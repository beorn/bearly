/**
 * Response cache (CAS) — sha256 keying, atomic write, graceful read failure.
 *
 * The cache is content-addressable: the file path *is* the hash of
 * (model, prompt, context, params). Identical input always hashes to the
 * same path, so cache lookup is just `fs.exists(<hash>.json)`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  cacheKeyHash,
  readCache,
  writeCache,
  cacheStats,
  cacheClear,
  _setCacheDirForTesting,
  type CacheKey,
} from "../src/lib/cache"

let cacheDir: string

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "bearly-cache-"))
  _setCacheDirForTesting(cacheDir)
})

afterEach(() => {
  _setCacheDirForTesting(undefined)
  rmSync(cacheDir, { recursive: true, force: true })
})

describe("cacheKeyHash — content-addressable", () => {
  it("identical inputs produce identical hashes", () => {
    const a: CacheKey = { model: "x", prompt: "hello" }
    const b: CacheKey = { model: "x", prompt: "hello" }
    expect(cacheKeyHash(a)).toBe(cacheKeyHash(b))
  })

  it("different model → different hash", () => {
    const a = cacheKeyHash({ model: "x", prompt: "p" })
    const b = cacheKeyHash({ model: "y", prompt: "p" })
    expect(a).not.toBe(b)
  })

  it("different prompt → different hash", () => {
    const a = cacheKeyHash({ model: "x", prompt: "a" })
    const b = cacheKeyHash({ model: "x", prompt: "b" })
    expect(a).not.toBe(b)
  })

  it("different context → different hash", () => {
    const a = cacheKeyHash({ model: "x", prompt: "p", context: "ctx-A" })
    const b = cacheKeyHash({ model: "x", prompt: "p", context: "ctx-B" })
    expect(a).not.toBe(b)
  })

  it("missing context vs empty context produce same hash", () => {
    // Both should normalize to empty string to avoid spurious cache misses.
    const a = cacheKeyHash({ model: "x", prompt: "p" })
    const b = cacheKeyHash({ model: "x", prompt: "p", context: "" })
    expect(a).toBe(b)
  })

  it("params order doesn't affect hash (sorted canonicalization)", () => {
    const a = cacheKeyHash({ model: "x", prompt: "p", params: { temperature: 0.7, top_p: 1 } })
    const b = cacheKeyHash({ model: "x", prompt: "p", params: { top_p: 1, temperature: 0.7 } })
    expect(a).toBe(b)
  })

  it("different params → different hash", () => {
    const a = cacheKeyHash({ model: "x", prompt: "p", params: { temperature: 0.7 } })
    const b = cacheKeyHash({ model: "x", prompt: "p", params: { temperature: 0.5 } })
    expect(a).not.toBe(b)
  })

  it("hash is 64 hex chars (sha256)", () => {
    const h = cacheKeyHash({ model: "x", prompt: "p" })
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("readCache / writeCache — round-trip", () => {
  it("write then read returns the same entry", () => {
    const key: CacheKey = { model: "test", prompt: "ping" }
    const envelope = { model: "test", tokens: { total: 42 }, cost: 0.001 }
    const content = "pong"
    writeCache(key, envelope, content)
    const entry = readCache(key)
    expect(entry).not.toBeNull()
    expect(entry!.envelope).toEqual(envelope)
    expect(entry!.content).toBe(content)
    expect(entry!.key).toEqual(key)
  })

  it("read miss returns null", () => {
    const entry = readCache({ model: "absent", prompt: "no" })
    expect(entry).toBeNull()
  })

  it("malformed cache file returns null (graceful failure)", () => {
    const key: CacheKey = { model: "broken", prompt: "x" }
    const hash = cacheKeyHash(key)
    writeFileSync(join(cacheDir, `${hash}.json`), "not valid json")
    expect(readCache(key)).toBeNull()
  })

  it("write creates cache directory if missing", () => {
    rmSync(cacheDir, { recursive: true, force: true })
    expect(existsSync(cacheDir)).toBe(false)
    writeCache({ model: "x", prompt: "p" }, {}, "content")
    expect(existsSync(cacheDir)).toBe(true)
  })

  it("write is atomic — no .tmp file leftover after success", () => {
    writeCache({ model: "x", prompt: "p" }, {}, "content")
    const files = readdirSync(cacheDir)
    const tmpFiles = files.filter((f) => f.includes(".tmp."))
    expect(tmpFiles).toHaveLength(0)
  })

  it("ts is ISO timestamp", () => {
    writeCache({ model: "x", prompt: "p" }, {}, "c")
    const entry = readCache({ model: "x", prompt: "p" })!
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })
})

describe("cacheStats", () => {
  it("returns 0/0 when cache dir doesn't exist", () => {
    rmSync(cacheDir, { recursive: true, force: true })
    const s = cacheStats()
    expect(s.count).toBe(0)
    expect(s.bytes).toBe(0)
  })

  it("counts entries and sums bytes", () => {
    writeCache({ model: "a", prompt: "1" }, {}, "x")
    writeCache({ model: "b", prompt: "2" }, {}, "yy")
    writeCache({ model: "c", prompt: "3" }, {}, "zzz")
    const s = cacheStats()
    expect(s.count).toBe(3)
    expect(s.bytes).toBeGreaterThan(0)
  })

  it("ignores non-.json files in cache dir", () => {
    writeCache({ model: "x", prompt: "p" }, {}, "c")
    writeFileSync(join(cacheDir, "stray.txt"), "not a cache entry")
    const s = cacheStats()
    expect(s.count).toBe(1)
  })
})

describe("cacheClear", () => {
  it("removes all entries", () => {
    writeCache({ model: "a", prompt: "1" }, {}, "x")
    writeCache({ model: "b", prompt: "2" }, {}, "y")
    expect(cacheStats().count).toBe(2)
    const result = cacheClear()
    expect(result.removed).toBe(2)
    expect(cacheStats().count).toBe(0)
  })

  it("returns 0 when cache dir doesn't exist", () => {
    rmSync(cacheDir, { recursive: true, force: true })
    expect(cacheClear()).toEqual({ removed: 0 })
  })

  it("returns 0 when cache is empty", () => {
    expect(cacheClear()).toEqual({ removed: 0 })
  })
})

describe("CAS property — cache hit on identical input", () => {
  it("two writes with same key overwrite the same file", () => {
    const key: CacheKey = { model: "x", prompt: "same" }
    writeCache(key, { v: 1 }, "first")
    writeCache(key, { v: 2 }, "second")
    expect(cacheStats().count).toBe(1) // same hash → same file
    const entry = readCache(key)!
    expect(entry.content).toBe("second") // last write wins
  })

  it("read after write returns cached content (saves a real call)", () => {
    const key: CacheKey = { model: "test", prompt: "expensive query" }
    // First call: cache miss
    expect(readCache(key)).toBeNull()
    // Simulated dispatch + write
    writeCache(key, { cost: 1.5 }, "expensive answer")
    // Second call: cache hit — would short-circuit dispatch in real flow
    const hit = readCache<{ cost: number }>(key)
    expect(hit).not.toBeNull()
    expect(hit!.envelope.cost).toBe(1.5)
    expect(hit!.content).toBe("expensive answer")
  })
})
