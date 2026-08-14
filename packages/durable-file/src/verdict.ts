import { readFileSync } from "node:fs"
import { atomicWriteFileSync } from "./index.ts"

export const VERDICT_SCHEMA = "bearly.verdict/v1" as const

export type Verdict = "OK" | "FAIL" | "REFUSE" | "ABORT"
export type VerdictDomain = "product" | "infra" | "harness"
export type ResourceKind =
  | "disk-space"
  | "disk-inodes"
  | "disk-quota"
  | "process-file-descriptors"
  | "system-file-descriptors"
  | "memory"
  | "process-slots"

export interface VerdictObservation {
  readonly source: string
  readonly observedAt: string
  readonly detail: string
}

export type VerdictReason =
  | Readonly<{ kind: "PRODUCT_PASSED"; detail?: string }>
  | Readonly<{ kind: "PRODUCT_FAILED"; detail?: string }>
  | Readonly<{
      kind: "RESOURCE_EXHAUSTED"
      resource: ResourceKind
      errno?: "ENOSPC" | "EDQUOT" | "EMFILE" | "ENFILE" | "ENOMEM" | "EAGAIN"
      detail?: string
    }>
  | Readonly<{ kind: "TIMEOUT_UNCERTAIN"; detail?: string }>
  | Readonly<{ kind: "NO_TESTS_COLLECTED"; detail?: string }>
  | Readonly<{
      kind: "VERDICT_MISSING"
      issue: "absent" | "malformed" | "version-unknown" | "subject-mismatch" | "exit-inconsistent"
      detail?: string
    }>
  | Readonly<{ kind: "HARNESS_ABORTED"; detail?: string }>

export interface VerdictArtifact {
  readonly schema: typeof VERDICT_SCHEMA
  readonly subject: string
  readonly verdict: Verdict
  readonly domain: VerdictDomain
  readonly reason: VerdictReason
  readonly observedAt: string
  readonly observations?: Readonly<{
    headroom_at_start?: VerdictObservation
    pressure_at_end?: VerdictObservation
  }>
}

export interface ReadVerdictOptions {
  readonly subject: string
  readonly exitCode?: number
  readonly observedAt?: string
}

const errnoResources = {
  ENOSPC: "disk-space",
  EDQUOT: "disk-quota",
  EMFILE: "process-file-descriptors",
  ENFILE: "system-file-descriptors",
  ENOMEM: "memory",
} as const

/** Classify only structural errno fields; arbitrary error messages are never evidence. */
export function classifyErrno(
  error: unknown,
  maxDepth = 8,
): Extract<VerdictReason, { kind: "RESOURCE_EXHAUSTED" }> | null {
  const seen = new Set<object>()
  let current: unknown = error
  for (let depth = 0; depth < maxDepth && typeof current === "object" && current !== null; depth += 1) {
    if (seen.has(current)) return null
    seen.add(current)
    const code = stringField(current, "code")
    if (code !== null && code in errnoResources) {
      const errno = code as keyof typeof errnoResources
      return { kind: "RESOURCE_EXHAUSTED", errno, resource: errnoResources[errno] }
    }
    if (code === "EAGAIN" && isProcessCreationSyscall(stringField(current, "syscall"))) {
      return { kind: "RESOURCE_EXHAUSTED", errno: "EAGAIN", resource: "process-slots" }
    }
    current = "cause" in current ? current.cause : undefined
  }
  return null
}

export function exitCodeForVerdict(verdict: Verdict): 0 | 1 | 2 {
  if (verdict === "OK") return 0
  if (verdict === "FAIL") return 1
  return 2
}

/** Validate first, then publish one complete JSON document atomically. */
export function writeVerdictArtifact(path: string, artifact: VerdictArtifact): void {
  assertVerdictArtifact(artifact)
  atomicWriteFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`)
}

/**
 * Read strict evidence for one expected subject. Every unreadable or
 * inconsistent artifact becomes the same explicit refusal family.
 */
export function readVerdictArtifact(path: string, options: ReadVerdictOptions): VerdictArtifact {
  requireNonEmpty(options.subject, "expected subject")
  const observedAt = options.observedAt ?? new Date().toISOString()
  assertTimestamp(observedAt, "reader observedAt")

  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") return missingVerdict(options.subject, observedAt, "absent")
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return missingVerdict(options.subject, observedAt, "malformed")
  }
  if (isRecord(parsed) && typeof parsed.schema === "string" && parsed.schema !== VERDICT_SCHEMA) {
    return missingVerdict(options.subject, observedAt, "version-unknown")
  }

  try {
    assertVerdictArtifact(parsed)
  } catch {
    return missingVerdict(options.subject, observedAt, "malformed")
  }
  const artifact = parsed as VerdictArtifact
  if (artifact.subject !== options.subject) {
    return missingVerdict(options.subject, observedAt, "subject-mismatch")
  }
  if (options.exitCode !== undefined && exitCodeForVerdict(artifact.verdict) !== options.exitCode) {
    return missingVerdict(options.subject, observedAt, "exit-inconsistent")
  }
  return artifact
}

export function assertVerdictArtifact(value: unknown): asserts value is VerdictArtifact {
  if (!isRecord(value)) throw new Error("verdict artifact must be an object")
  exactKeys(value, ["schema", "subject", "verdict", "domain", "reason", "observedAt"], ["observations"], "artifact")
  if (value.schema !== VERDICT_SCHEMA) throw new Error(`verdict schema must be ${VERDICT_SCHEMA}`)
  requireNonEmpty(value.subject, "verdict subject")
  if (!isVerdict(value.verdict)) throw new Error("verdict must be OK, FAIL, REFUSE, or ABORT")
  if (!isDomain(value.domain)) throw new Error("verdict domain must be product, infra, or harness")
  assertTimestamp(value.observedAt, "verdict observedAt")
  assertReason(value.reason)
  assertReasonMatchesVerdict(value.verdict, value.reason)
  if (value.observations !== undefined) assertObservations(value.observations)
}

function missingVerdict(
  subject: string,
  observedAt: string,
  issue: Extract<VerdictReason, { kind: "VERDICT_MISSING" }>["issue"],
): VerdictArtifact {
  return {
    schema: VERDICT_SCHEMA,
    subject,
    verdict: "REFUSE",
    domain: "harness",
    reason: { kind: "VERDICT_MISSING", issue },
    observedAt,
  }
}

function assertReason(value: unknown): asserts value is VerdictReason {
  if (!isRecord(value) || typeof value.kind !== "string") throw new Error("verdict reason must have a kind")
  switch (value.kind) {
    case "PRODUCT_PASSED":
    case "PRODUCT_FAILED":
    case "TIMEOUT_UNCERTAIN":
    case "NO_TESTS_COLLECTED":
    case "HARNESS_ABORTED":
      exactKeys(value, ["kind"], ["detail"], `reason ${value.kind}`)
      assertOptionalDetail(value.detail)
      return
    case "RESOURCE_EXHAUSTED": {
      exactKeys(value, ["kind", "resource"], ["errno", "detail"], "reason RESOURCE_EXHAUSTED")
      if (!isResourceKind(value.resource)) throw new Error("resource reason has an invalid resource")
      if (value.errno !== undefined) {
        const expected = resourceForErrno(value.errno)
        if (expected === null || value.resource !== expected) {
          throw new Error("resource reason has an invalid errno/resource pair")
        }
      }
      assertOptionalDetail(value.detail)
      return
    }
    case "VERDICT_MISSING":
      exactKeys(value, ["kind", "issue"], ["detail"], "reason VERDICT_MISSING")
      if (!isMissingIssue(value.issue)) throw new Error("VERDICT_MISSING issue is invalid")
      assertOptionalDetail(value.detail)
      return
    default:
      throw new Error(`unknown verdict reason ${value.kind}`)
  }
}

function assertReasonMatchesVerdict(verdict: Verdict, reason: VerdictReason): void {
  const valid =
    (verdict === "OK" && reason.kind === "PRODUCT_PASSED") ||
    (verdict === "FAIL" && reason.kind === "PRODUCT_FAILED") ||
    (verdict === "REFUSE" &&
      ["RESOURCE_EXHAUSTED", "TIMEOUT_UNCERTAIN", "NO_TESTS_COLLECTED", "VERDICT_MISSING"].includes(reason.kind)) ||
    (verdict === "ABORT" && reason.kind === "HARNESS_ABORTED")
  if (!valid) throw new Error(`reason ${reason.kind} is inconsistent with verdict ${verdict}`)
}

function assertObservations(value: unknown): void {
  if (!isRecord(value)) throw new Error("verdict observations must be an object")
  exactKeys(value, [], ["headroom_at_start", "pressure_at_end"], "observations")
  if (value.headroom_at_start !== undefined) assertObservation(value.headroom_at_start, "headroom_at_start")
  if (value.pressure_at_end !== undefined) assertObservation(value.pressure_at_end, "pressure_at_end")
}

function assertObservation(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} observation must be an object`)
  exactKeys(value, ["source", "observedAt", "detail"], [], `${label} observation`)
  requireNonEmpty(value.source, `${label} source`)
  requireNonEmpty(value.detail, `${label} detail`)
  assertTimestamp(value.observedAt, `${label} observedAt`)
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  const missing = required.filter((key) => !(key in value))
  const unknown = keys.filter((key) => !allowed.has(key))
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${label} keys invalid: missing=${missing.join(",") || "none"} unknown=${unknown.join(",") || "none"}`,
    )
  }
}

function resourceForErrno(errno: unknown): ResourceKind | null {
  if (typeof errno !== "string") return null
  if (errno in errnoResources) return errnoResources[errno as keyof typeof errnoResources]
  return errno === "EAGAIN" ? "process-slots" : null
}

function isResourceKind(value: unknown): value is ResourceKind {
  return (
    value === "disk-space" ||
    value === "disk-inodes" ||
    value === "disk-quota" ||
    value === "process-file-descriptors" ||
    value === "system-file-descriptors" ||
    value === "memory" ||
    value === "process-slots"
  )
}

function isProcessCreationSyscall(syscall: string | null): boolean {
  return syscall !== null && /(?:^|\b)(?:fork|spawn|posix_spawn)(?:\b|$)/u.test(syscall)
}

function isVerdict(value: unknown): value is Verdict {
  return value === "OK" || value === "FAIL" || value === "REFUSE" || value === "ABORT"
}

function isDomain(value: unknown): value is VerdictDomain {
  return value === "product" || value === "infra" || value === "harness"
}

function isMissingIssue(value: unknown): value is Extract<VerdictReason, { kind: "VERDICT_MISSING" }>["issue"] {
  return (
    value === "absent" ||
    value === "malformed" ||
    value === "version-unknown" ||
    value === "subject-mismatch" ||
    value === "exit-inconsistent"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`)
}

function assertOptionalDetail(value: unknown): void {
  if (value !== undefined) requireNonEmpty(value, "reason detail")
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  requireNonEmpty(value, label)
  const time = Date.parse(value)
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value)
    {throw new Error(`${label} must be an ISO timestamp`)}
}

function stringField(value: object, key: string): string | null {
  if (!(key in value)) return null
  const field = (value as Record<string, unknown>)[key]
  return typeof field === "string" ? field : null
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null ? stringField(error, "code") : null
}
