/**
 * quality-gate — adversarial fixtures for the recall quality filter.
 *
 * The gate must reject three corruption classes and accept clean content:
 *   1. stuck-loop: a single line / N-gram repeating across the doc
 *   2. decayed-llm: short-sentence ratio + low stopword density
 *   3. cross-session-concat: heuristic — best-effort, the deeper fix is
 *      upstream in the export path
 *   4. clean-good: must NOT be rejected
 */
import { describe, test, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { analyzeQuality, isAcceptable } from "../src/lib/quality-gate.ts"

const FIXTURE_DIR = join(import.meta.dirname, "quality-gate.fixtures")

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, `${name}.txt`), "utf-8")
}

describe("analyzeQuality", () => {
  test("clean-good is acceptable", () => {
    const text = fixture("clean-good")
    const r = analyzeQuality(text)
    expect(r.rejectReason).toBeUndefined()
    expect(isAcceptable(text)).toBe(true)
  })

  test("stuck-loop: rejected with stuck-loop reason", () => {
    const text = fixture("stuck-loop")
    const r = analyzeQuality(text)
    expect(r.rejectReason).toBeDefined()
    expect(r.rejectReason).toMatch(/^stuck-loop:/)
    expect(isAcceptable(text)).toBe(false)
  })

  test("decayed-llm: rejected with decayed-llm reason", () => {
    const text = fixture("decayed-llm")
    const r = analyzeQuality(text)
    expect(r.rejectReason).toBeDefined()
    expect(r.rejectReason).toMatch(/^decayed-llm:/)
    expect(isAcceptable(text)).toBe(false)
  })

  test("cross-session-concat: signals carry the diagnostic shape", () => {
    // Cross-session concat is the hardest class — fragments from unrelated
    // sessions joined mid-sentence often look like normal prose because both
    // halves ARE normal prose. The deeper fix lives in the export path
    // (investigate `exportSession` for append-without-close). The lexical
    // gate catches it only by side-effect when the join boundary degrades
    // grammar enough to trigger decayed-llm. We assert the diagnostic
    // signals are computed so callers can layer their own concat heuristic
    // on top, but we don't require this fixture to be rejected.
    const text = fixture("cross-session-concat")
    const r = analyzeQuality(text)
    expect(r.signals.totalTokens).toBeGreaterThan(50)
    expect(r.signals.totalSentences).toBeGreaterThan(0)
  })

  test("synthetic: 12 verbatim repeats of a single line is stuck-loop", () => {
    const line = "the quick brown fox jumps over the lazy dog"
    const text = Array(12).fill(line).join("\n")
    expect(analyzeQuality(text).rejectReason).toMatch(/^stuck-loop:repeated-line$/)
  })

  test("synthetic: 9 verbatim repeats is below threshold (not rejected for repeated-line)", () => {
    const line = "the quick brown fox jumps over the lazy dog"
    const text = Array(9).fill(line).join("\n")
    // 9 < 10 so the contiguous-line rule doesn't fire, but a single line
    // covers most of the doc so it might still be caught by ngram-coverage.
    const r = analyzeQuality(text)
    if (r.rejectReason) {
      expect(r.rejectReason).not.toBe("stuck-loop:repeated-line")
    }
  })

  test("synthetic: high punctuation, normal sentences passes", () => {
    // Three distinct paragraphs, no repetition — the rendering-pipeline
    // example was originally one paragraph repeated 3x which (correctly)
    // tripped the ngram coverage check. Real prose has variation.
    const text = `
      We need to consider whether the rendering pipeline correctly handles
      the case where a sticky child overflows its container. The dirty flag
      tracking in the compose phase should detect this. If it doesn't, then
      we have a regression that needs to be fixed before we ship.

      The next consideration is incremental render correctness across
      multiple frames. Sticky children have a contract with their parent
      column: they remain anchored even when the parent scrolls past their
      natural position. Breaking that contract leaks visual artifacts into
      surrounding cells.

      Finally, performance. Sticky lookups happen on every frame so they
      must be O(1) in steady state. The current implementation walks the
      child tree which is O(n). We can fix this by maintaining a sparse
      sticky-child index keyed by parent node id.
    `
    expect(isAcceptable(text)).toBe(true)
  })

  test("empty text is acceptable (degenerate, nothing to filter)", () => {
    expect(isAcceptable("")).toBe(true)
    expect(isAcceptable("   \n\n  ")).toBe(true)
  })

  test("very short text passes (insufficient data to judge)", () => {
    // Don't reject a one-line note just because it has no stopwords.
    expect(isAcceptable("test")).toBe(true)
    expect(isAcceptable("ok done")).toBe(true)
  })

  test("signals object includes diagnostic fields", () => {
    const text = fixture("clean-good")
    const r = analyzeQuality(text)
    expect(r.signals).toBeDefined()
    expect(typeof r.signals.totalTokens).toBe("number")
    expect(typeof r.signals.shortSentenceRatio).toBe("number")
    expect(typeof r.signals.stopwordDensity).toBe("number")
    expect(typeof r.signals.maxLineRepeat).toBe("number")
    expect(typeof r.signals.maxNgramCoverage).toBe("number")
  })

  test("ngram-coverage: 4-gram covering >20% of tokens triggers rejection", () => {
    // Build a doc where "alpha beta gamma delta" repeats and dominates.
    const phrase = "alpha beta gamma delta"
    const filler = "and "
    const text = (phrase + " ").repeat(60) + filler.repeat(40)
    const r = analyzeQuality(text)
    expect(r.rejectReason).toMatch(/stuck-loop/)
  })
})

describe("isAcceptable opts", () => {
  test("opts.minTokens raises the floor for short-text exemption", () => {
    const text = "ok done shipped pushed merged"
    // Default exempts short text
    expect(isAcceptable(text)).toBe(true)
    // With a low floor we still pass because nothing is repeating
    expect(isAcceptable(text, { minTokens: 1 })).toBe(true)
  })
})
