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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
/**
 * @reach fs-walk <fixture-only: tmpRoot is a mkdtempSync directory under tmpdir; cacheDir is the responses dir that XDG_CACHE_HOME resolves to inside it>
 */
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cacheKeyHash, readCache, writeCache, sanitizeModelSlug, type CacheKey } from "../src/lib/cache"

let cacheDir: string
let tmpRoot: string

beforeEach(() => {
  // XDG_CACHE_HOME is the cache's documented override (see getCacheDir); it is
  // read at call time, so a stubbed tmpdir isolates the suite from the real
  // ~/.cache/bearly-llm/responses without any test-only setter.
  tmpRoot = mkdtempSync(join(tmpdir(), "bearly-cache-"))
  vi.stubEnv("XDG_CACHE_HOME", tmpRoot)
  cacheDir = join(tmpRoot, "bearly-llm", "responses")
  // The deleted _setCacheDirForTesting pointed straight at an existing
  // mkdtemp dir; the XDG override now resolves to this child, so create it to
  // preserve the "cache dir already exists" premise of the write-path cases.
  mkdirSync(cacheDir, { recursive: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(tmpRoot, { recursive: true, force: true })
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

describe("CAS property — cache hit on identical input", () => {
  it("two writes with same key overwrite the same hash (last write wins)", () => {
    const key: CacheKey = { model: "x", prompt: "same" }
    writeCache(key, { v: 1 }, "first")
    writeCache(key, { v: 2 }, "second")
    expect(readdirSync(cacheDir).filter((f) => f.endsWith(".json"))).toHaveLength(1) // same hash → one entry
    const entry = readCache(key)!
    expect(entry.content).toBe("second") // last write wins
  })

  it("read after write returns cached content (saves a real call)", () => {
    const key: CacheKey = { model: "test", prompt: "expensive query" }
    // First call: cache miss
    expect(readCache(key)).toBeNull()
    // Simulated dispatch + write
    writeCache(key, { model: { modelId: "test" }, usage: { estimatedCost: 1.5 }, durationMs: 1000 }, "expensive answer")
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
  it.each([
    { estimate: 0.000123, encoded: "123" },
    { estimate: 0, encoded: "0" },
  ])("encodes list-equivalent estimate $estimate independently from a charge", ({ estimate, encoded }) => {
    const key: CacheKey = { model: "moonshotai/kimi-k2.6", prompt: "hi" }
    writeCache(
      key,
      {
        model: { modelId: "moonshotai/kimi-k2.6" },
        cost_usd: 3,
        list_equivalent_usd: estimate,
        durationMs: 456,
      },
      "hello",
    )
    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"))
    expect(files).toHaveLength(1)
    const filename = files[0]
    const hash = cacheKeyHash(key)
    expect(filename).toBe(`${hash},moonshotai_kimi-k2.6,${encoded},456,ok.json`)
  })

  it("err status when envelope.error is non-empty and not abort/truncate", () => {
    writeCache({ model: "x", prompt: "p" }, { model: { modelId: "x" }, error: "some failure" }, "")
    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"))
    expect(files[0]).toMatch(/,err\.json$/)
  })

  it("abrt status when envelope.error mentions abort", () => {
    writeCache({ model: "x", prompt: "p" }, { model: { modelId: "x" }, error: "AbortError: aborted by user" }, "")
    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"))
    expect(files[0]).toMatch(/,abrt\.json$/)
  })

  it("trunc status when envelope.error mentions truncation", () => {
    writeCache({ model: "x", prompt: "p" }, { model: { modelId: "x" }, error: "response truncated at max tokens" }, "")
    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"))
    expect(files[0]).toMatch(/,trunc\.json$/)
  })

  it("missing estimate is unknown while duration retains its existing default", () => {
    writeCache({ model: "x", prompt: "p" }, { model: { modelId: "x" } }, "c")
    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/,x,unknown,0,ok\.json$/)
  })

  it("falls back to cache-key model when envelope.model.modelId is absent", () => {
    writeCache({ model: "fallback-model", prompt: "p" }, {}, "c")
    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/,fallback-model,/)
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
