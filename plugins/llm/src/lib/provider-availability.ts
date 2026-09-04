import { constants as fsConstants } from "node:fs"
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { getCacheDir } from "./cache"
import { getProviderEnvVar, type Provider } from "./types"

export type ProviderAvailabilityStatus = "available" | "refusing" | "unknown"

export type ProviderRefusalKind =
  | "credential-missing"
  | "auth"
  | "quota"
  | "rate-limited"
  | "transport"
  | "server-error"

export type PersistedProviderRefusalKind = Exclude<ProviderRefusalKind, "credential-missing">

interface ProviderEvidenceBase {
  provider: Provider
  source: string
  reason: string
  observedAt: number
  expiresAt: number
  retryAt?: number
}

export type RecordedProviderObservation =
  | (ProviderEvidenceBase & {
      status: "available"
      kind?: never
    })
  | (ProviderEvidenceBase & {
      status: "refusing"
      kind: PersistedProviderRefusalKind
    })

export type ProviderAvailabilityFact =
  | RecordedProviderObservation
  | {
      provider: Provider
      status: "refusing"
      kind: "credential-missing"
      source: "config"
      reason: string
      observedAt?: never
      expiresAt?: never
      retryAt?: never
    }
  | {
      provider: Provider
      status: "unknown"
      kind?: PersistedProviderRefusalKind
      source: string
      reason: string
      observedAt?: number
      expiresAt?: number
      retryAt?: number
    }

export type ProviderObservation =
  | {
      provider: Provider
      status: "available"
      source: string
      reason: string
      observedAt?: number
      retryAt?: never
      kind?: never
    }
  | {
      provider: Provider
      status: "refusing"
      kind: PersistedProviderRefusalKind
      source: string
      reason: string
      observedAt?: number
      retryAt?: number
    }

export type ProviderObservationReadResult =
  | { status: "found"; path: string; observation: RecordedProviderObservation }
  | { status: "absent"; path: string }
  | { status: "unreadable"; path: string; reason: string }

export interface ProviderObservationStore {
  pathFor(provider: Provider): string
  read(provider: Provider): Promise<ProviderObservationReadResult>
  write(observation: RecordedProviderObservation): Promise<void>
}

export interface CreateProviderObservationStoreOptions {
  /** Bearly cache root; defaults to the sibling of the existing responses directory. */
  cacheRoot?: string
  warn?: (message: string) => void
}

const STORE_VERSION = 1
const LOCK_WAIT_MS = 5_000
const LOCK_RETRY_MS = 5

const DEFAULT_TTL_MS: Record<"available" | PersistedProviderRefusalKind, number> = {
  available: 30 * 60_000,
  auth: 30 * 60_000,
  quota: 30 * 60_000,
  "rate-limited": 10 * 60_000,
  transport: 2 * 60_000,
  "server-error": 5 * 60_000,
}

interface StoredProviderObservation {
  version: typeof STORE_VERSION
  observation: RecordedProviderObservation
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code)
}

function isProviderObservation(value: unknown, provider?: Provider): value is RecordedProviderObservation {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<RecordedProviderObservation>
  if (provider !== undefined && item.provider !== provider) return false
  if (typeof item.provider !== "string" || typeof item.source !== "string" || item.source.length === 0) return false
  if (typeof item.reason !== "string" || item.reason.length === 0) return false
  if (!Number.isFinite(item.observedAt) || !Number.isFinite(item.expiresAt)) return false
  if ((item.expiresAt as number) < (item.observedAt as number)) return false
  if (item.retryAt !== undefined && !Number.isFinite(item.retryAt)) return false
  if (item.status === "available") return item.kind === undefined && item.retryAt === undefined
  if (item.status !== "refusing") return false
  return (
    item.kind === "auth" ||
    item.kind === "quota" ||
    item.kind === "rate-limited" ||
    item.kind === "transport" ||
    item.kind === "server-error"
  )
}

function parseStoredObservation(raw: string, provider: Provider): RecordedProviderObservation {
  const parsed = JSON.parse(raw) as Partial<StoredProviderObservation>
  if (parsed.version !== STORE_VERSION) {
    throw new Error(`unsupported provider observation version ${String(parsed.version)}`)
  }
  if (!isProviderObservation(parsed.observation, provider)) {
    throw new Error(`invalid provider observation for ${provider}`)
  }
  return parsed.observation
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function acquireLock(lockPath: string): Promise<Awaited<ReturnType<typeof open>>> {
  const deadline = Date.now() + LOCK_WAIT_MS
  while (true) {
    try {
      return await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600)
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw new Error(`provider observation lock failed: ${lockPath}: ${errorMessage(error)}`)
      }
      if (Date.now() >= deadline) {
        throw new Error(`provider observation lock timed out after ${LOCK_WAIT_MS}ms: ${lockPath}`)
      }
      await wait(LOCK_RETRY_MS)
    }
  }
}

export function createProviderObservationStore(
  options: CreateProviderObservationStoreOptions = {},
): ProviderObservationStore {
  const cacheRoot = options.cacheRoot ?? path.dirname(getCacheDir())
  const providerDir = path.join(cacheRoot, "providers")
  const warn = options.warn ?? ((message: string) => console.error(message))

  const pathFor = (provider: Provider): string => path.join(providerDir, `${provider}.json`)

  const read = async (provider: Provider): Promise<ProviderObservationReadResult> => {
    const file = pathFor(provider)
    try {
      const raw = await readFile(file, "utf8")
      return { status: "found", path: file, observation: parseStoredObservation(raw, provider) }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { status: "absent", path: file }
      const reason = `observation store unreadable: ${file}: ${errorMessage(error)}`
      warn(reason)
      return { status: "unreadable", path: file, reason }
    }
  }

  const write = async (observation: RecordedProviderObservation): Promise<void> => {
    if (!isProviderObservation(observation)) {
      throw new Error("provider observation write rejected invalid observation")
    }
    const file = pathFor(observation.provider)
    const lockPath = `${file}.lock`
    await mkdir(providerDir, { recursive: true, mode: 0o700 })
    const lock = await acquireLock(lockPath)
    let operationError: unknown
    let temporary: string | undefined
    try {
      let current: RecordedProviderObservation | undefined
      try {
        current = parseStoredObservation(await readFile(file, "utf8"), observation.provider)
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) {
          warn(`observation store unreadable: ${file}: ${errorMessage(error)}`)
        }
      }
      if (current && current.observedAt >= observation.observedAt) return

      temporary = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`
      const stored: StoredProviderObservation = { version: STORE_VERSION, observation }
      await writeFile(temporary, `${JSON.stringify(stored)}\n`, { mode: 0o600 })
      await rename(temporary, file)
      temporary = undefined
    } catch (error) {
      operationError = error
      throw new Error(`provider observation write failed: ${file}: ${errorMessage(error)}`)
    } finally {
      const cleanupFailures: string[] = []
      try {
        await lock.close()
      } catch (error) {
        cleanupFailures.push(`close ${lockPath}: ${errorMessage(error)}`)
      }
      try {
        await unlink(lockPath)
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) cleanupFailures.push(`unlink ${lockPath}: ${errorMessage(error)}`)
      }
      if (operationError && temporary) {
        try {
          await unlink(temporary)
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) cleanupFailures.push(`unlink ${temporary}: ${errorMessage(error)}`)
        }
      }
      if (cleanupFailures.length > 0) {
        const message = `provider observation cleanup failed: ${cleanupFailures.join("; ")}`
        if (operationError) warn(message)
        else throw new Error(message)
      }
    }
  }

  return { pathFor, read, write }
}

function ttlFor(input: ProviderObservation): number {
  return input.status === "available" ? DEFAULT_TTL_MS.available : DEFAULT_TTL_MS[input.kind]
}

export async function recordProviderObservation(
  store: ProviderObservationStore,
  input: ProviderObservation,
): Promise<RecordedProviderObservation> {
  if (input.source.trim().length === 0) throw new Error("provider observation source must be non-empty")
  if (input.reason.trim().length === 0) throw new Error("provider observation reason must be non-empty")
  if (input.observedAt !== undefined && !Number.isFinite(input.observedAt)) {
    throw new Error(`provider observation observedAt must be finite; received ${String(input.observedAt)}`)
  }
  if (input.retryAt !== undefined && !Number.isFinite(input.retryAt)) {
    throw new Error(`provider observation retryAt must be finite; received ${String(input.retryAt)}`)
  }
  const observedAt = input.observedAt ?? Date.now()
  const defaultExpiry = observedAt + ttlFor(input)
  const expiresAt =
    input.status === "refusing" &&
    input.kind === "rate-limited" &&
    input.retryAt !== undefined &&
    input.retryAt > observedAt
      ? input.retryAt
      : defaultExpiry
  const observation: RecordedProviderObservation =
    input.status === "available" ? { ...input, observedAt, expiresAt } : { ...input, observedAt, expiresAt }
  await store.write(observation)
  return observation
}

export interface ReadProviderAvailabilityOptions {
  store: ProviderObservationStore
  now: number
  env?: Readonly<Record<string, string | undefined>>
}

function hasCurrentCredential(provider: Provider, env: Readonly<Record<string, string | undefined>>): boolean {
  if (provider === "ollama") return true
  const value = env[getProviderEnvVar(provider)]
  return typeof value === "string" && value.trim().length > 0
}

function formatAge(ageMs: number): string {
  if (ageMs < 1_000) return `${Math.max(0, ageMs)}ms`
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)}s`
  return `${Math.floor(ageMs / 60_000)}m`
}

export async function readProviderAvailability(
  provider: Provider,
  options: ReadProviderAvailabilityOptions,
): Promise<ProviderAvailabilityFact> {
  const env = options.env ?? process.env
  if (!hasCurrentCredential(provider, env)) {
    const envVar = getProviderEnvVar(provider)
    return {
      provider,
      status: "refusing",
      kind: "credential-missing",
      source: "config",
      reason: `${envVar} is not configured`,
    }
  }

  const result = await options.store.read(provider)
  if (result.status === "unreadable") {
    return { provider, status: "unknown", source: "observation-store", reason: result.reason }
  }
  if (result.status === "absent") {
    return {
      provider,
      status: "unknown",
      source: "observation-store",
      reason: `no provider observation found at ${result.path}`,
    }
  }

  const observation = result.observation
  if (observation.expiresAt <= options.now) {
    return {
      provider,
      status: "unknown",
      ...(observation.status === "refusing" ? { kind: observation.kind } : {}),
      source: observation.source,
      reason: `last ${observation.status} observation from ${observation.source} is stale (age ${formatAge(options.now - observation.observedAt)})`,
      observedAt: observation.observedAt,
      expiresAt: observation.expiresAt,
      ...(observation.retryAt !== undefined ? { retryAt: observation.retryAt } : {}),
    }
  }
  return observation
}
