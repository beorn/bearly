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
 * Storage: `~/.cache/bearly-llm/responses/<sha256>.json` per entry.
 * Atomic write (temp + rename) so a crash mid-write can't corrupt the
 * cache. Graceful read failure: malformed entries return null, caller
 * falls through to live dispatch.
 *
 * Eviction: none today (single-user, expected <10K entries). `cacheClear`
 * for manual purge; `cacheStats` for inspection. If/when count exceeds
 * a threshold, add LRU eviction at write time — the file mtime is the
 * natural last-touch signal.
 */

import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

let cachePathOverride: string | undefined

/** Override cache directory for tests. */
export function _setCacheDirForTesting(dir: string | undefined): void {
  cachePathOverride = dir
}

function getCacheDir(): string {
  if (cachePathOverride) return cachePathOverride
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

/** SHA-256 over canonical JSON of the cache key. */
export function cacheKeyHash(key: CacheKey): string {
  const canonical = JSON.stringify({
    model: key.model,
    prompt: key.prompt,
    context: key.context ?? "",
    params: sortObj(key.params ?? {}),
  })
  return createHash("sha256").update(canonical).digest("hex")
}

function sortObj(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(obj).sort()) out[k] = obj[k]
  return out
}

/** Look up a cached response. Returns null on miss or malformed entry. */
export function readCache<E = unknown>(key: CacheKey): CacheEntry<E> | null {
  const file = path.join(getCacheDir(), `${cacheKeyHash(key)}.json`)
  if (!fs.existsSync(file)) return null
  try {
    const raw = fs.readFileSync(file, "utf-8")
    return JSON.parse(raw) as CacheEntry<E>
  } catch {
    // Malformed cache entry — surface as miss so caller falls through.
    return null
  }
}

/** Write a cache entry. Atomic via temp + rename. */
export function writeCache<E = unknown>(key: CacheKey, envelope: E, content: string): void {
  const dir = getCacheDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${cacheKeyHash(key)}.json`)
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
  const entry: CacheEntry<E> = { envelope, content, ts: new Date().toISOString(), key }
  fs.writeFileSync(tmp, JSON.stringify(entry))
  fs.renameSync(tmp, file)
}

export interface CacheStats {
  count: number
  bytes: number
  dir: string
}

/** Inspect cache size + entry count. */
export function cacheStats(): CacheStats {
  const dir = getCacheDir()
  if (!fs.existsSync(dir)) return { count: 0, bytes: 0, dir }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
  let bytes = 0
  for (const f of files) bytes += fs.statSync(path.join(dir, f)).size
  return { count: files.length, bytes, dir }
}

/** Purge all cached responses. Returns count removed. */
export function cacheClear(): { removed: number } {
  const dir = getCacheDir()
  if (!fs.existsSync(dir)) return { removed: 0 }
  const files = fs.readdirSync(dir)
  let removed = 0
  for (const f of files) {
    try {
      fs.unlinkSync(path.join(dir, f))
      removed++
    } catch {
      // Ignore unlink failures — best-effort purge.
    }
  }
  return { removed }
}
