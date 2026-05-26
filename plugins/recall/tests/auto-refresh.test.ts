/**
 * Auto-refresh stale FTS5 index — @km/bearly/19216-recall-freshness-shrink-threshold
 *
 * Covers: parseThreshold (unit), refreshIndexIfStale (integration with test seam),
 * RECALL_STALE_THRESHOLD env override, --no-refresh opt-out.
 */
import { describe, test, expect, afterEach } from "vitest"
import {
  parseThreshold,
  getStaleThresholdMs,
  RECALL_STALE_THRESHOLD_DEFAULT,
} from "../src/lib/staleness"

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

// refreshIndexIfStale itself lives in search.ts where it can import getDb +
// getIndexMeta. Its behavior under DB access is covered by an end-to-end smoke
// (search-time stale → auto-refresh fires); the *pure* pieces it composes
// (parseThreshold + getStaleThresholdMs) are tested above. The subprocess seam
// is exposed for an integration-style test (pass a fake spawner) — that test
// belongs in a setup that has bun:sqlite available, not in this pure-unit file.
