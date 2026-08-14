import { afterEach, describe, expect, test } from "vitest"
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { atomicWriteFileSync } from "../src/index.ts"
import {
  classifyErrno,
  exitCodeForVerdict,
  readVerdictArtifact,
  writeVerdictArtifact,
  type VerdictArtifact,
} from "../src/verdict.ts"

const roots: string[] = []
const OBSERVED_AT = "2026-08-14T20:00:00.000Z"

afterEach(() => {
  for (const root of roots.splice(0)) {
    safeRemoveSync(root, { within: tmpdir(), allowMissing: true })
  }
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "durable-file-test-"))
  roots.push(root)
  return root
}

function artifact(overrides: Partial<VerdictArtifact> = {}): VerdictArtifact {
  return {
    schema: "bearly.verdict/v1",
    subject: "commit:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    verdict: "OK",
    domain: "product",
    reason: { kind: "PRODUCT_PASSED" },
    observedAt: OBSERVED_AT,
    ...overrides,
  }
}

describe("atomicWriteFileSync", () => {
  test("publishes complete replacement bytes and leaves no sibling temp file", () => {
    const root = scratch()
    const path = join(root, "verdict.json")
    writeFileSync(path, "old")

    atomicWriteFileSync(path, Buffer.from("new verdict\n"))

    expect(readFileSync(path, "utf8")).toBe("new verdict\n")
    expect(readdirSync(root)).toEqual(["verdict.json"])
  })
})

describe("errno classification", () => {
  test.each([
    [{ code: "ENOSPC" }, "disk-space"],
    [{ code: "EDQUOT" }, "disk-quota"],
    [{ code: "EMFILE" }, "process-file-descriptors"],
    [{ code: "ENFILE" }, "system-file-descriptors"],
    [{ code: "ENOMEM" }, "memory"],
    [{ code: "EAGAIN", syscall: "spawn" }, "process-slots"],
  ] as const)("maps $0.code to a typed resource refusal", (fields, resource) => {
    expect(classifyErrno(Object.assign(new Error("boom"), fields))).toEqual({
      kind: "RESOURCE_EXHAUSTED",
      errno: fields.code,
      resource,
    })
  })

  test("does not treat non-process EAGAIN as exhausted process slots", () => {
    expect(classifyErrno(Object.assign(new Error("try again"), { code: "EAGAIN", syscall: "read" }))).toBeNull()
  })

  test("walks a bounded cause chain and gives wrapped and direct errnos the same result", () => {
    const direct = Object.assign(new Error("disk full"), { code: "ENOSPC" })
    const wrapped = new Error("outer", { cause: new Error("middle", { cause: direct }) })

    expect(classifyErrno(wrapped)).toEqual(classifyErrno(direct))
  })

  test("does not classify arbitrary message text as an errno", () => {
    expect(classifyErrno(new Error("ENOSPC while doing something unrelated"))).toBeNull()
  })
})

describe("strict verdict artifacts", () => {
  test("round-trips one canonical artifact through the atomic writer", () => {
    const path = join(scratch(), "verdict.json")
    const expected = artifact({
      observations: {
        headroom_at_start: { source: "statfs:/tmp", observedAt: OBSERVED_AT, detail: "427937 free inodes" },
      },
    })

    writeVerdictArtifact(path, expected)

    expect(readVerdictArtifact(path, { subject: expected.subject, exitCode: 0, observedAt: OBSERVED_AT })).toEqual(
      expected,
    )
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(expected, null, 2)}\n`)
  })

  test.each([
    ["absent", (path: string) => path],
    ["malformed", (path: string) => (writeFileSync(path, "not json"), path)],
    [
      "version-unknown",
      (path: string) => (writeFileSync(path, JSON.stringify({ ...artifact(), schema: "bearly.verdict/v2" })), path),
    ],
    [
      "subject-mismatch",
      (path: string) => (writeFileSync(path, JSON.stringify(artifact({ subject: "commit:other" }))), path),
    ],
    ["exit-inconsistent", (path: string) => (writeFileSync(path, JSON.stringify(artifact())), path)],
  ] as const)("derives REFUSE / VERDICT_MISSING for %s input", (issue, prepare) => {
    const path = prepare(join(scratch(), "verdict.json"))
    const exitCode = issue === "exit-inconsistent" ? 1 : 0

    const actual = readVerdictArtifact(path, {
      subject: artifact().subject,
      exitCode,
      observedAt: OBSERVED_AT,
    })

    expect(actual).toMatchObject({
      schema: "bearly.verdict/v1",
      subject: artifact().subject,
      verdict: "REFUSE",
      domain: "harness",
      reason: { kind: "VERDICT_MISSING", issue },
    })
  })

  test("rejects unknown fields rather than silently accepting a wider schema", () => {
    const path = join(scratch(), "verdict.json")
    writeFileSync(path, JSON.stringify({ ...artifact(), extra: true }))

    expect(
      readVerdictArtifact(path, { subject: artifact().subject, exitCode: 0, observedAt: OBSERVED_AT }),
    ).toMatchObject({
      verdict: "REFUSE",
      reason: { kind: "VERDICT_MISSING", issue: "malformed" },
    })
  })

  test("keeps REFUSE distinct while mapping the four verdicts onto advisory exit codes", () => {
    expect(exitCodeForVerdict("OK")).toBe(0)
    expect(exitCodeForVerdict("FAIL")).toBe(1)
    expect(exitCodeForVerdict("REFUSE")).toBe(2)
    expect(exitCodeForVerdict("ABORT")).toBe(2)
  })

  test("does not create the destination when schema validation rejects the artifact", () => {
    const path = join(scratch(), "verdict.json")
    const invalid = { ...artifact(), subject: "" } as VerdictArtifact

    expect(() => writeVerdictArtifact(path, invalid)).toThrow(/subject/u)
    expect(existsSync(path)).toBe(false)
  })
})
