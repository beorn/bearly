/**
 * Response cache (CAS) — sha256 keying, atomic write, graceful read failure.
 *
 * The cache is content-addressable: filenames start with the sha256 hash of
 * (model, prompt, context, params), and encode metadata afterward so
 * `ls ~/.cache/bearly-llm/responses/` is a CSV-like dashboard:
 *
 *     <sha64>,<model-slug>,<microUSD>,<ms>,<status>.json
 *
 * Lookup scans the directory for a filename starting with `<hash>,`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  cacheKeyHash,
  readCache,
  writeCache,
  cacheStats,
  cacheClear,
  parseFilename,
  sanitizeModelSlug,
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
    const envelope = { model: { modelId: "test" }, usage: { estimatedCost: 0.001 }, durationMs: 42 }
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
    // Write a file that matches the new prefix-based lookup.
    writeFileSync(join(cacheDir, `${hash},broken,0,0,ok.json`), "not valid json")
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
    expect(s.byModel).toEqual({})
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

  it("byModel aggregates calls / cost / avg duration / statuses per model", () => {
    writeCache(
      { model: "a", prompt: "1" },
      { model: { modelId: "modelA" }, usage: { estimatedCost: 0.01 }, durationMs: 100 },
      "x",
    )
    writeCache(
      { model: "a", prompt: "2" },
      { model: { modelId: "modelA" }, usage: { estimatedCost: 0.02 }, durationMs: 300 },
      "y",
    )
    writeCache(
      { model: "b", prompt: "3" },
      { model: { modelId: "modelB" }, usage: { estimatedCost: 0.005 }, durationMs: 50, error: "boom" },
      "z",
    )
    const s = cacheStats()
    expect(s.byModel.modelA!.calls).toBe(2)
    expect(s.byModel.modelA!.totalMicroUSD).toBe(30_000) // 0.01 + 0.02 USD = 30000 microUSD
    expect(s.byModel.modelA!.avgMs).toBe(200) // (100+300)/2
    expect(s.byModel.modelA!.statuses.ok).toBe(2)
    expect(s.byModel.modelB!.calls).toBe(1)
    expect(s.byModel.modelB!.statuses.err).toBe(1)
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
  it("two writes with same key overwrite the same hash (last write wins)", () => {
    const key: CacheKey = { model: "x", prompt: "same" }
    writeCache(key, { v: 1 }, "first")
    writeCache(key, { v: 2 }, "second")
    expect(cacheStats().count).toBe(1) // same hash → at most one entry
    const entry = readCache(key)!
    expect(entry.content).toBe("second") // last write wins
  })

  it("read after write returns cached content (saves a real call)", () => {
    const key: CacheKey = { model: "test", prompt: "expensive query" }
    // First call: cache miss
    expect(readCache(key)).toBeNull()
    // Simulated dispatch + write
    writeCache(
      key,
      { model: { modelId: "test" }, usage: { estimatedCost: 1.5 }, durationMs: 1000 },
      "expensive answer",
    )
    // Second call: cache hit — would short-circuit dispatch in real flow
    const hit = readCache<{ usage: { estimatedCost: number } }>(key)
    expect(hit).not.toBeNull()
    expect(hit!.envelope.usage.estimatedCost).toBe(1.5)
    expect(hit!.content).toBe("expensive answer")
  })
})

// ============================================================================
// Filename-encoded metadata — turns `ls cache/` into a CSV dashboard.
// ============================================================================

describe("filename format — <sha64>,<model-slug>,<microUSD>,<ms>,<status>.json", () => {
  it("encodes hash, sanitized model, microUSD cost, ms duration, and ok status", () => {
    const key: CacheKey = { model: "moonshotai/kimi-k2.6", prompt: "hi" }
    writeCache(
      key,
      {
        model: { modelId: "moonshotai/kimi-k2.6" },
        usage: { estimatedCost: 0.000123 }, // 123 microUSD
        durationMs: 456,
      },
      "hello",
    )
    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"))
    expect(files).toHaveLength(1)
    const filename = files[0]
    const hash = cacheKeyHash(key)
    expect(filename).toBe(`${hash},moonshotai_kimi-k2.6,123,456,ok.json`)
  })

  it("err status when envelope.error is non-empty and not abort/truncate", () => {
    writeCache(
      { model: "x", prompt: "p" },
      { model: { modelId: "x" }, error: "some failure" },
      "",
    )
    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"))
    expect(files[0]).toMatch(/,err\.json$/)
  })

  it("abrt status when envelope.error mentions abort", () => {
    writeCache(
      { model: "x", prompt: "p" },
      { model: { modelId: "x" }, error: "AbortError: aborted by user" },
      "",
    )
    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"))
    expect(files[0]).toMatch(/,abrt\.json$/)
  })

  it("trunc status when envelope.error mentions truncation", () => {
    writeCache(
      { model: "x", prompt: "p" },
      { model: { modelId: "x" }, error: "response truncated at max tokens" },
      "",
    )
    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"))
    expect(files[0]).toMatch(/,trunc\.json$/)
  })

  it("missing usage / durationMs default to 0,0 (parser still accepts)", () => {
    writeCache({ model: "x", prompt: "p" }, { model: { modelId: "x" } }, "c")
    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"))
    const parsed = parseFilename(files[0]!)
    expect(parsed).not.toBeNull()
    expect(parsed!.microUSD).toBe(0)
    expect(parsed!.ms).toBe(0)
    expect(parsed!.status).toBe("ok")
  })

  it("falls back to cache-key model when envelope.model.modelId is absent", () => {
    writeCache({ model: "fallback-model", prompt: "p" }, {}, "c")
    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"))
    const parsed = parseFilename(files[0]!)
    expect(parsed!.model).toBe("fallback-model")
  })
})

describe("sanitizeModelSlug — / → _, comma-hostile chars stripped", () => {
  it("replaces / with _ for nested model ids", () => {
    expect(sanitizeModelSlug("deepseek/deepseek-r1")).toBe("deepseek_deepseek-r1")
  })

  it("preserves dots, dashes, digits, underscores", () => {
    expect(sanitizeModelSlug("moonshotai/kimi-k2.6")).toBe("moonshotai_kimi-k2.6")
    expect(sanitizeModelSlug("openai/gpt-5.4-pro_2026")).toBe("openai_gpt-5.4-pro_2026")
  })

  it("strips commas (the filename delimiter) so format stays unambiguous", () => {
    expect(sanitizeModelSlug("weird,name")).toBe("weirdname")
  })

  it("strips path-traversal and shell metacharacters", () => {
    expect(sanitizeModelSlug("../../etc/passwd")).toBe(".._.._etc_passwd")
    expect(sanitizeModelSlug("a b c")).toBe("abc")
  })
})

describe("parseFilename — round-trip + rejects malformed", () => {
  it("parses a well-formed filename", () => {
    const hash = "a".repeat(64)
    const parsed = parseFilename(`${hash},gpt-5.4,1500,2300,ok.json`)
    expect(parsed).toEqual({ hash, model: "gpt-5.4", microUSD: 1500, ms: 2300, status: "ok" })
  })

  it("returns null for non-.json", () => {
    const hash = "a".repeat(64)
    expect(parseFilename(`${hash},m,0,0,ok.txt`)).toBeNull()
  })

  it("returns null for in-flight temp files (.tmp.)", () => {
    const hash = "a".repeat(64)
    expect(parseFilename(`${hash},m,0,0,ok.json.tmp.123.456`)).toBeNull()
  })

  it("returns null when hash isn't 64 hex chars", () => {
    expect(parseFilename("short,m,0,0,ok.json")).toBeNull()
    expect(parseFilename(`${"z".repeat(64)},m,0,0,ok.json`)).toBeNull() // non-hex
  })

  it("returns null for unknown status", () => {
    const hash = "a".repeat(64)
    expect(parseFilename(`${hash},m,0,0,bogus.json`)).toBeNull()
  })

  it("returns null for non-integer cost / duration", () => {
    const hash = "a".repeat(64)
    expect(parseFilename(`${hash},m,1.5,0,ok.json`)).toBeNull()
    expect(parseFilename(`${hash},m,0,abc,ok.json`)).toBeNull()
  })
})

describe("glob lookup — picks right entry by hash prefix", () => {
  it("finds the cached entry even when other keys' files are present", () => {
    // Three different cache keys → three different hashes → three different filenames.
    writeCache({ model: "alpha", prompt: "1" }, { model: { modelId: "alpha" } }, "AAA")
    writeCache({ model: "beta", prompt: "2" }, { model: { modelId: "beta" } }, "BBB")
    writeCache({ model: "gamma", prompt: "3" }, { model: { modelId: "gamma" } }, "CCC")
    expect(readdirSync(cacheDir).filter((f) => f.endsWith(".json"))).toHaveLength(3)
    const hit = readCache({ model: "beta", prompt: "2" })
    expect(hit!.content).toBe("BBB")
  })

  it("re-write with same key but different metadata replaces the old file", () => {
    const key: CacheKey = { model: "x", prompt: "p" }
    writeCache(key, { model: { modelId: "x" }, durationMs: 100 }, "first")
    const before = readdirSync(cacheDir).filter((f) => f.endsWith(".json"))
    expect(before).toHaveLength(1)
    expect(before[0]).toMatch(/,100,ok\.json$/)
    // Different durationMs → different filename, but same hash prefix.
    writeCache(key, { model: { modelId: "x" }, durationMs: 999 }, "second")
    const after = readdirSync(cacheDir).filter((f) => f.endsWith(".json"))
    expect(after).toHaveLength(1) // old file unlinked
    expect(after[0]).toMatch(/,999,ok\.json$/)
    expect(readCache(key)!.content).toBe("second")
  })

  it("ignores in-flight .tmp.<pid>.<ts> files during lookup", () => {
    const key: CacheKey = { model: "x", prompt: "p" }
    const hash = cacheKeyHash(key)
    // Simulate an in-flight write that hasn't been renamed yet.
    writeFileSync(join(cacheDir, `${hash},x,0,0,ok.json.tmp.99.123`), '{"bogus":true}')
    expect(readCache(key)).toBeNull()
  })
})
