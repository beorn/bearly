/**
 * Auto-refresh stale FTS5 index — @km/bearly/19216-recall-freshness-shrink-threshold
 *
 * Covers: parseThreshold (unit), refreshIndexIfStale (integration with test seam),
 * RECALL_STALE_THRESHOLD env override, --no-refresh opt-out.
 */
import { describe, test, expect, afterEach } from "vitest"
import { parseThreshold, getStaleThresholdMs, RECALL_STALE_THRESHOLD_DEFAULT } from "../src/lib/staleness"
import { refreshIndexIfStaleWithDeps, type RefreshDeps } from "../src/lib/refresh"

/** Build a deps bundle defaulting to "fresh / no spawn" for fast tests. */
function makeFakeDeps(overrides: Partial<RefreshDeps> = {}): RefreshDeps {
  return {
    getLastRebuild: () => null,
    now: () => 1_000_000,
    getThresholdMs: () => 5 * 60 * 1000,
    spawnCmd: async () => ({ exitCode: 0 }),
    ...overrides,
  }
}

describe("parseThreshold", () => {
  test('accepts "5m" — 5 minutes', () => {
    expect(parseThreshold("5m")).toBe(5 * 60 * 1000)
  })

  test('accepts "1h" — 1 hour', () => {
    expect(parseThreshold("1h")).toBe(60 * 60 * 1000)
  })

  test('accepts "30s" — 30 seconds', () => {
    expect(parseThreshold("30s")).toBe(30 * 1000)
  })

  test('accepts "500ms" — milliseconds explicit', () => {
    expect(parseThreshold("500ms")).toBe(500)
  })

  test('bare "10" defaults to minutes (most-common-input optimization)', () => {
    expect(parseThreshold("10")).toBe(10 * 60 * 1000)
  })

  test("trims whitespace", () => {
    expect(parseThreshold("  5m  ")).toBe(5 * 60 * 1000)
  })

  test('throws on garbage "5y"', () => {
    expect(() => parseThreshold("5y")).toThrow(/invalid duration/)
  })

  test('throws on empty ""', () => {
    expect(() => parseThreshold("")).toThrow(/invalid duration/)
  })

  test('default RECALL_STALE_THRESHOLD_DEFAULT is "5m" — matches prompt-cache TTL', () => {
    expect(RECALL_STALE_THRESHOLD_DEFAULT).toBe("5m")
    expect(parseThreshold(RECALL_STALE_THRESHOLD_DEFAULT)).toBe(5 * 60 * 1000)
  })
})

describe("getStaleThresholdMs (env override)", () => {
  const originalEnv = process.env.RECALL_STALE_THRESHOLD

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.RECALL_STALE_THRESHOLD
    else process.env.RECALL_STALE_THRESHOLD = originalEnv
  })

  test("defaults to 5m when env unset", () => {
    delete process.env.RECALL_STALE_THRESHOLD
    expect(getStaleThresholdMs()).toBe(5 * 60 * 1000)
  })

  test('honors RECALL_STALE_THRESHOLD="10m"', () => {
    process.env.RECALL_STALE_THRESHOLD = "10m"
    expect(getStaleThresholdMs()).toBe(10 * 60 * 1000)
  })

  test('honors RECALL_STALE_THRESHOLD="1h"', () => {
    process.env.RECALL_STALE_THRESHOLD = "1h"
    expect(getStaleThresholdMs()).toBe(60 * 60 * 1000)
  })
})

describe("refreshIndexIfStaleWithDeps — opt-out", () => {
  test('options.refresh === false short-circuits to { reason: "opt-out" }', async () => {
    const spawned: string[][] = []
    const r = await refreshIndexIfStaleWithDeps(
      { refresh: false },
      makeFakeDeps({
        spawnCmd: async (argv) => {
          spawned.push(argv)
          return { exitCode: 0 }
        },
      }),
    )
    expect(r.refreshed).toBe(false)
    if (!r.refreshed) expect(r.reason).toBe("opt-out")
    expect(spawned).toEqual([]) // never spawned
  })

  test("options.refresh undefined falls through to the staleness check", async () => {
    const r = await refreshIndexIfStaleWithDeps({}, makeFakeDeps())
    if (!r.refreshed) expect(r.reason).not.toBe("opt-out")
  })

  test("options.refresh === true (explicit) also falls through", async () => {
    const r = await refreshIndexIfStaleWithDeps({ refresh: true }, makeFakeDeps())
    if (!r.refreshed) expect(r.reason).not.toBe("opt-out")
  })
})

describe("refreshIndexIfStaleWithDeps — staleness branches", () => {
  test('no last-rebuild meta → { reason: "no-meta" }', async () => {
    const r = await refreshIndexIfStaleWithDeps({}, makeFakeDeps({ getLastRebuild: () => null }))
    expect(r.refreshed).toBe(false)
    if (!r.refreshed) expect(r.reason).toBe("no-meta")
  })

  test('index age ≤ threshold → { reason: "fresh" } (no spawn)', async () => {
    const spawned: string[][] = []
    const now = 10_000_000
    const lastRebuild = new Date(now - 1 * 60 * 1000).toISOString() // 1m ago
    const r = await refreshIndexIfStaleWithDeps(
      {},
      makeFakeDeps({
        getLastRebuild: () => lastRebuild,
        now: () => now,
        getThresholdMs: () => 5 * 60 * 1000,
        spawnCmd: async (argv) => {
          spawned.push(argv)
          return { exitCode: 0 }
        },
      }),
    )
    expect(r.refreshed).toBe(false)
    if (!r.refreshed) expect(r.reason).toBe("fresh")
    expect(spawned).toEqual([])
  })

  test("index age > threshold → spawns refresh + returns { refreshed: true }", async () => {
    const spawned: string[][] = []
    const now = 10_000_000
    const lastRebuild = new Date(now - 30 * 60 * 1000).toISOString() // 30m ago
    let nowCalls = 0
    const r = await refreshIndexIfStaleWithDeps(
      {},
      makeFakeDeps({
        getLastRebuild: () => lastRebuild,
        now: () => now + (nowCalls++ === 0 ? 0 : 250), // 250ms refresh duration
        getThresholdMs: () => 5 * 60 * 1000,
        spawnCmd: async (argv) => {
          spawned.push(argv)
          return { exitCode: 0 }
        },
      }),
    )
    expect(r.refreshed).toBe(true)
    expect(spawned).toEqual([["bun", "recall", "index", "--incremental"]])
    if (r.refreshed) {
      expect(r.staleMs).toBe(30 * 60 * 1000)
      expect(r.refreshMs).toBeGreaterThanOrEqual(0) // wall-clock time of refresh
    }
  })
})

describe("refreshIndexIfStaleWithDeps — error handling (Fail Loud, never break search)", () => {
  test('getLastRebuild throws → { reason: "error" } with the message (never throws to caller)', async () => {
    const r = await refreshIndexIfStaleWithDeps(
      {},
      makeFakeDeps({
        getLastRebuild: () => {
          throw new Error("DB locked")
        },
      }),
    )
    expect(r.refreshed).toBe(false)
    if (!r.refreshed && r.reason === "error") {
      expect(r.error).toContain("DB locked")
      expect(r.staleMs).toBe(0) // no staleness measured before the throw
    } else {
      throw new Error(`expected error result, got ${JSON.stringify(r)}`)
    }
  })

  test('spawn non-zero exit → { reason: "error" } includes exit code + first stderr line', async () => {
    const now = 10_000_000
    const lastRebuild = new Date(now - 30 * 60 * 1000).toISOString()
    const r = await refreshIndexIfStaleWithDeps(
      {},
      makeFakeDeps({
        getLastRebuild: () => lastRebuild,
        now: () => now,
        spawnCmd: async () => ({ exitCode: 1, stderr: "permission denied\nstack trace\n" }),
      }),
    )
    expect(r.refreshed).toBe(false)
    if (!r.refreshed && r.reason === "error") {
      expect(r.error).toContain("exited 1")
      expect(r.error).toContain("permission denied")
      expect(r.error).not.toContain("stack trace") // only first stderr line
      expect(r.staleMs).toBe(30 * 60 * 1000)
    } else {
      throw new Error(`expected error result, got ${JSON.stringify(r)}`)
    }
  })

  test('spawn throws → { reason: "error" } (never throws to caller)', async () => {
    const now = 10_000_000
    const lastRebuild = new Date(now - 30 * 60 * 1000).toISOString()
    const r = await refreshIndexIfStaleWithDeps(
      {},
      makeFakeDeps({
        getLastRebuild: () => lastRebuild,
        now: () => now,
        spawnCmd: async () => {
          throw new Error("ENOENT bun")
        },
      }),
    )
    expect(r.refreshed).toBe(false)
    if (!r.refreshed && r.reason === "error") {
      expect(r.error).toContain("ENOENT bun")
    } else {
      throw new Error(`expected error result, got ${JSON.stringify(r)}`)
    }
  })
})
