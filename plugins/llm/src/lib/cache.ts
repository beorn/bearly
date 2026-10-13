/**
 * Response cache — content-addressable storage (CAS) keyed by sha256 of
 * (model, prompt, context, params). Saves money during iteration on the
 * same prompt; identical (model, prompt, context, params) input always
 * returns identical output, so caching is sound by construction.
 *
 * Cache scope: single-model ask path only. /pro shadow testing, /deep
 * research, and /debate consensus deliberately bypass — caching there
 * would corrupt judge calibration and defeat the multi-model purpose.
 *
 * Storage: `~/.cache/bearly-llm/responses/<filename>.json` per entry, where
 * the filename encodes metadata so `ls` is a CSV-like dashboard:
 *
 *     <sha64>,<model-slug>,<microUSD>,<ms>,<status>.json
 *
 *   sha64       — 64 hex chars (sha256 of cache key)
 *   model-slug  — model id with `/` → `_` (e.g. `moonshotai_kimi-k2.6`)
 *   microUSD    — cost in integer microUSD (USD × 1_000_000)
 *   ms          — duration in milliseconds (integer)
 *   status      — one of: ok | err | abrt | trunc
 *
 * Lookup is O(N) over the directory (typical N < 1000): find a filename
 * starting with `<hash>,`. Atomic write (temp + rename) so a crash mid-write
 * can't corrupt the cache. Graceful read failure: malformed entries return
 * null, caller falls through to live dispatch.
 *
 * Eviction: none today (single-user, expected <10K entries). If/when count
 * exceeds a threshold, add LRU eviction at write time — the file mtime is the
 * natural last-touch signal.
 */

import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

/** True when caching is suppressed for this process — set LLM_NO_CACHE=1
 * to bypass cache reads + writes (used by tests + as a manual escape hatch). */
export function isCacheDisabled(): boolean {
  return process.env.LLM_NO_CACHE === "1"
}

/** Response-cache directory. Provider observations use its `providers/` sibling. */
export function getCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME
  const home = process.env.HOME ?? ""
  const base = xdg && xdg.length > 0 ? xdg : `${home}/.cache`
  return path.join(base, "bearly-llm/responses")
}

export interface CacheKey {
  model: string
  prompt: string
  context?: string
  /** Provider/model parameters that affect output (temperature, reasoning level, etc.). */
  params?: Record<string, unknown>
  /** Route that answers the call — "key" (billing API key) or a subscription
   *  CLI id. Part of the identity because a CLI answer and a key answer for the
   *  same SKU are different results (bead 29147). */
  route?: string
}

export interface CacheEntry<E = unknown> {
  envelope: E
  /** Cached response text — what the caller would read from `file:` in the envelope. */
  content: string
  /** ISO timestamp of cache write. */
  ts: string
  /** Original key, stored for inspection / debugging — not used for lookup. */
  key: CacheKey
}

export type CacheStatus = "ok" | "err" | "abrt" | "trunc"

/** SHA-256 over canonical JSON of the cache key. */
export function cacheKeyHash(key: CacheKey): string {
  const canonical = JSON.stringify({
    model: key.model,
    prompt: key.prompt,
    context: key.context ?? "",
    route: key.route ?? "key",
    params: sortObj(key.params ?? {}),
  })
  return createHash("sha256").update(canonical).digest("hex")
}

function sortObj(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(obj).sort()) out[k] = obj[k]
  return out
}

/**
 * Sanitize a model id for safe use in a filename component.
 * `/` becomes `_` (e.g. `deepseek/deepseek-r1` → `deepseek_deepseek-r1`).
 * Other filename-hostile characters (commas, control chars) are stripped
 * so the comma-delimited filename format stays unambiguous.
 */
export function sanitizeModelSlug(model: string): string {
  // Replace path-separator-ish chars with underscore, then strip the rest.
  // Keep [A-Za-z0-9._-] which covers every real model id we ship.
  return model.replace(/\//g, "_").replace(/[^A-Za-z0-9._-]/g, "")
}

/**
 * Find the cached file for a hash, if any. Returns the absolute path or null.
 * O(N) directory scan — fine for N < 1000.
 */
function findCacheFile(dir: string, hash: string): string | null {
  if (!fs.existsSync(dir)) return null
  const prefix = `${hash},`
  for (const f of fs.readdirSync(dir)) {
    // `.startsWith(prefix)` excludes in-flight `<final>.tmp.<pid>.<ts>`
    // entries because their basename starts with the *full* filename
    // (including `,model,microUSD,ms,status.json`) — never with the bare
    // `<hash>,` prefix alone followed by another comma.
    if (f.startsWith(prefix) && f.endsWith(".json") && !f.includes(".tmp.")) {
      return path.join(dir, f)
    }
  }
  return null
}

/** Look up a cached response. Returns null on miss, on malformed entry, or
 * when LLM_NO_CACHE=1 (clean test isolation without per-suite dir wiring). */
export function readCache<E = unknown>(key: CacheKey): CacheEntry<E> | null {
  if (isCacheDisabled()) return null
  const file = findCacheFile(getCacheDir(), cacheKeyHash(key))
  if (!file) return null
  try {
    const raw = fs.readFileSync(file, "utf-8")
    return JSON.parse(raw) as CacheEntry<E>
  } catch {
    // Malformed cache entry — surface as miss so caller falls through.
    return null
  }
}

/**
 * Derive filename metadata from an envelope (ModelResponse-shaped).
 * Duck-typed: cache.ts is generic over E, so we read optional fields
 * defensively. Anything missing falls back to a sentinel that still
 * produces a well-formed `<hash>,<model>,<microUSD>,<ms>,<status>.json` name.
 */
function deriveMetadata(
  key: CacheKey,
  envelope: unknown,
): { model: string; microUSD: number; ms: number; status: CacheStatus } {
  const env = (envelope ?? {}) as Record<string, unknown>
  // Prefer envelope.model.modelId, fall back to the cache key.
  const envModel = env.model as { modelId?: unknown } | undefined
  const modelId = typeof envModel?.modelId === "string" && envModel.modelId.length > 0 ? envModel.modelId : key.model
  const usage = env.usage as { estimatedCost?: unknown } | undefined
  const cost = typeof usage?.estimatedCost === "number" ? usage.estimatedCost : 0
  const microUSD = Math.max(0, Math.round(cost * 1_000_000))
  const durationMs = env.durationMs
  const ms = Math.max(0, typeof durationMs === "number" ? Math.round(durationMs) : 0)
  let status: CacheStatus = "ok"
  const error = env.error
  if (typeof error === "string" && error.length > 0) {
    if (/abort|aborted|cancell?ed/i.test(error)) status = "abrt"
    else if (/truncat/i.test(error)) status = "trunc"
    else status = "err"
  }
  return { model: sanitizeModelSlug(modelId), microUSD, ms, status }
}

/** Write a cache entry. Atomic via temp + rename. No-op when LLM_NO_CACHE=1. */
export function writeCache<E = unknown>(key: CacheKey, envelope: E, content: string): void {
  if (isCacheDisabled()) return
  const dir = getCacheDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const hash = cacheKeyHash(key)
  const meta = deriveMetadata(key, envelope)
  const filename = `${hash},${meta.model},${meta.microUSD},${meta.ms},${meta.status}.json`
  const file = path.join(dir, filename)
  // Temp suffix `.tmp.<pid>.<ts>` is chosen so a `<hash>,*` lookup never
  // matches an in-flight write: the temp basename ends with `.tmp.<pid>.<ts>`
  // (no `.json` suffix, and `.tmp.` substrings are never matched on lookup).
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
  const entry: CacheEntry<E> = { envelope, content, ts: new Date().toISOString(), key }
  fs.writeFileSync(tmp, JSON.stringify(entry))
  // Replace any existing file for this hash (different metadata is fine —
  // last write wins) so we don't accumulate stale entries with old costs.
  const existing = findCacheFile(dir, hash)
  if (existing && existing !== file) {
    try {
      fs.unlinkSync(existing)
    } catch {
      // Best effort — if the unlink races with another writer we just
      // leave the stale entry; the next read picks one of them.
    }
  }
  fs.renameSync(tmp, file)
}
