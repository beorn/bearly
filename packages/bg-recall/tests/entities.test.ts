import { describe, expect, test } from "vitest"
import { entitiesFromToolCall, entityOverlap, extractEntities, extractShingles } from "../src/entities.ts"

describe("extractEntities", () => {
  test("pulls file paths with extensions", () => {
    const e = extractEntities("read packages/bg-recall/src/daemon.ts and tests/foo.test.ts")
    expect(e).toContain("packages/bg-recall/src/daemon.ts")
    expect(e).toContain("daemon.ts")
    expect(e).toContain("tests/foo.test.ts")
    expect(e).toContain("foo.test.ts")
  })

  test("pulls dotted sigils (bead-style)", () => {
    const e = extractEntities("working on km-tribe.bg-recall-daemon and km-silvery.scope")
    expect(e).toContain("km-tribe.bg-recall-daemon")
    expect(e).toContain("km-silvery.scope")
  })

  test("pulls TitleCase names", () => {
    const e = extractEntities("Bjørn Stabell met Gerd Leonhard yesterday")
    expect(e).toContain("gerd leonhard")
  })

  test("does not strip ≥7-char non-stopwords (heuristic preserves long words)", () => {
    // 'because' is 7 chars and not in the STOPWORDS set, so it's kept.
    // The stopword filter only excludes the small closed set of common short
    // function words (the/a/and/…). This is the documented behavior.
    const e = extractEntities("the quick brown fox jumps over because")
    expect(e).toContain("because")
    expect(e).not.toContain("the")
    expect(e).not.toContain("over")
  })

  test("returns empty for empty input", () => {
    expect(extractEntities("")).toEqual([])
  })
})

describe("extractShingles", () => {
  test("emits hash-stable shingles for matching text", () => {
    const a = extractShingles("the quick brown fox jumps over the lazy dog")
    const b = extractShingles("the quick brown fox jumps over the lazy dog")
    expect(a).toEqual(b)
    expect(a.length).toBeGreaterThan(0)
  })

  test("returns empty when text shorter than n", () => {
    expect(extractShingles("two words", 4)).toEqual([])
  })
})

describe("entitiesFromToolCall", () => {
  test("Read shapes a path entity from input", () => {
    const e = entitiesFromToolCall({
      sessionId: "s1",
      sessionName: "fixer",
      tool: "Read",
      input: "/Users/beorn/Code/pim/km/vendor/bearly/packages/bg-recall/src/daemon.ts",
      ts: Date.now(),
    })
    expect(e.some((x) => x.includes("daemon.ts"))).toBe(true)
  })

  test("merges input + output entities", () => {
    const e = entitiesFromToolCall({
      sessionId: "s1",
      sessionName: "fixer",
      tool: "Bash",
      input: "grep -rn km-tribe.bg-recall src/",
      output: "src/daemon.ts:12: km-tribe.bg-recall-daemon hint",
      ts: Date.now(),
    })
    expect(e).toContain("km-tribe.bg-recall")
    expect(e).toContain("km-tribe.bg-recall-daemon")
    expect(e.some((x) => x.includes("daemon.ts"))).toBe(true)
  })

  test("no-input no-output → empty", () => {
    expect(entitiesFromToolCall({ sessionId: "s1", sessionName: "x", tool: "Bash", ts: 0 })).toEqual([])
  })
})

describe("entityOverlap", () => {
  test("returns 1.0 for identical sets", () => {
    expect(entityOverlap(["a", "b"], ["a", "b"])).toBe(1)
  })

  test("returns 0 for disjoint sets", () => {
    expect(entityOverlap(["a", "b"], ["c", "d"])).toBe(0)
  })

  test("computes Jaccard for partial overlap", () => {
    // intersect = {a}, union = {a, b, c} → 1/3
    expect(entityOverlap(["a", "b"], ["a", "c"])).toBeCloseTo(1 / 3, 5)
  })

  test("handles empty sets", () => {
    expect(entityOverlap([], ["a"])).toBe(0)
    expect(entityOverlap(["a"], [])).toBe(0)
  })
})
