import { describe, test, expect } from "vitest"
import { estimateTokens, computeMaxOutputTokens } from "./research"
import type { Model } from "./types"

/**
 * Regression tests for the token estimator and combined-limit budget math.
 *
 * Context: 2026-04-20 dual-pro architectural review failed with Kimi K2.6
 * returning "context length exceeded". Root cause was chars/4 estimator
 * under-counting code/JSON-heavy content by ~7%, blowing through a 2048-
 * token safety margin by 45 tokens. Both the divisor (4 → 3.5) and the
 * safety margin (2048 → 4096) were tightened. These tests lock in the
 * "always overestimates" contract.
 */

describe("estimateTokens — must overestimate, never under-estimate", () => {
  // A rough lower bound for real token counts: for any realistic content,
  // real tokens ≤ chars / 2.5 (emoji/CJK worst case). Our estimator must
  // produce ≥ real tokens. We approximate the real count with chars / 3.5
  // for dense content (empirically measured on the 2026-04-20 context:
  // 113218 chars → 30687 tokens = 3.69 chars/token).

  test("English prose — estimator ≥ measured-realistic token count", () => {
    // ~1000 chars of English prose tokenizes at ~4 chars/token → ~250 tokens
    const prose = "The quick brown fox jumps over the lazy dog. ".repeat(25)
    const estimated = estimateTokens(prose)
    const realishLowerBound = Math.ceil(prose.length / 4) // English ratio
    expect(estimated).toBeGreaterThanOrEqual(realishLowerBound)
  })

  test("Dense code/JSON content — estimator ≥ empirical tokenization", () => {
    // 2026-04-20 review context: 113218 chars tokenized to 30687 tokens.
    // Ratio: 3.69 chars/token. Our estimator should be ≥ that count.
    const sampleSize = 113218
    const realObservedTokens = 30687
    // Build a sample string of that size (content shape doesn't matter
    // for the math — estimator only reads length).
    const sample = "x".repeat(sampleSize)
    const estimated = estimateTokens(sample)
    expect(estimated).toBeGreaterThanOrEqual(realObservedTokens)
  })

  test("Single char — rounds up to 1 token", () => {
    expect(estimateTokens("a")).toBe(1)
  })

  test("Empty string — 0 tokens", () => {
    expect(estimateTokens("")).toBe(0)
  })
})

describe("computeMaxOutputTokens — combined-limit provider budget", () => {
  const k26Model: Model = {
    provider: "openrouter",
    modelId: "moonshotai/kimi-k2.6",
    displayName: "Kimi K2.6",
    isDeepResearch: false,
    costTier: "low",
    inputPricePerM: 0.95,
    outputPricePerM: 4.0,
    typicalLatencyMs: 15000,
    reasoning: { contextWindow: 262144 },
  }

  test("2026-04-20 regression — 113K-char input must leave headroom within 262K cap", () => {
    // This is the exact failing scenario: a 113218-char context file +
    // question sent to K2.6 returned "262189 > 262144 by 45 tokens".
    // After the fix (divisor 3.5 + SAFETY 4096), the request must land
    // safely under the cap.
    const inputChars = 113218 + 1597 // context + question from failing call
    const messages = [{ role: "user", content: "x".repeat(inputChars) }]
    const cap = computeMaxOutputTokens(k26Model, messages)
    expect(cap).toBeDefined()

    // The provider will see: realInput + cap ≤ contextWindow.
    // Real input was 30687 for the failing 114815-char payload. With a
    // slight cushion for variance, we assert: estimated + cap + realInput
    // stays within contextWindow using the EMPIRICAL ratio (3.69 chars/
    // token) as a worst-case real-token count.
    const worstCaseRealTokens = Math.ceil(inputChars / 3.3) // safety factor
    const totalRequest = worstCaseRealTokens + cap!
    expect(totalRequest).toBeLessThanOrEqual(262144)
  })

  test("Tiny query gets most of the output window", () => {
    const messages = [{ role: "user", content: "Hello" }]
    const cap = computeMaxOutputTokens(k26Model, messages)
    expect(cap).toBeDefined()
    // 262144 - ~1 input - 4096 SAFETY ≈ 258047
    expect(cap!).toBeGreaterThan(250000)
  })

  test("Non-reasoning model — returns undefined (provider default)", () => {
    const plainModel: Model = {
      provider: "openai",
      modelId: "gpt-4.1",
      displayName: "GPT-4.1",
      isDeepResearch: false,
      costTier: "medium",
      inputPricePerM: 2.5,
      outputPricePerM: 10,
      typicalLatencyMs: 5000,
    }
    const messages = [{ role: "user", content: "Hello" }]
    expect(computeMaxOutputTokens(plainModel, messages)).toBeUndefined()
  })

  test("Static ceiling model — returns the static value", () => {
    const staticModel: Model = {
      provider: "openai",
      modelId: "gpt-5.2-pro",
      displayName: "GPT-5.2 Pro",
      isDeepResearch: false,
      costTier: "high",
      inputPricePerM: 20,
      outputPricePerM: 80,
      typicalLatencyMs: 30000,
      reasoning: { maxOutputTokens: 64000 },
    }
    const messages = [{ role: "user", content: "Hello" }]
    expect(computeMaxOutputTokens(staticModel, messages)).toBe(64000)
  })
})
