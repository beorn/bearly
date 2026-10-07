import { describe, test, expect } from "vitest"
import { estimateTokens, computeMaxOutputTokens, parseContextLengthError, MAX_USEFUL_OUTPUT_TOKENS } from "./research"
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

  test("Tiny query is capped at the useful ceiling, not the whole window", () => {
    // Until 2026-09-11 this asserted `> 250000` — the window minus the input,
    // which is what the bug DID rather than what we want. `max_tokens` is a
    // credit RESERVATION on metered routes, so requesting the whole window
    // costs headroom on every call and 402s the expensive models outright
    // (bead 22972). The intent underneath that assertion was "a short query
    // must not be handed a stingy cap", and that intent is kept below.
    const messages = [{ role: "user", content: "Hello" }]
    const cap = computeMaxOutputTokens(k26Model, messages)
    expect(cap).toBe(MAX_USEFUL_OUTPUT_TOKENS)
    // The anti-stinginess guard, restated against measured reality: the
    // largest completion in 38 real llm-meta records is 26472 tokens, so the
    // cap must leave comfortable room above anything we have ever produced.
    expect(cap!).toBeGreaterThan(26472 * 2)
  })

  test("Endpoint ceiling wins when it is smaller than the window's headroom", () => {
    // The 22972 regression proper. Inkling advertises max_completion_tokens
    // 32768 against a 1048576 combined window: before the fix we asked for
    // ~1044000 — 32x the endpoint's own stated ceiling.
    const inkling: Model = {
      ...k26Model,
      modelId: "thinkingmachines/inkling",
      displayName: "Inkling",
      reasoning: { contextWindow: 1048576, maxOutputTokens: 32768 },
    }
    const cap = computeMaxOutputTokens(inkling, [{ role: "user", content: "Hello" }])
    expect(cap).toBe(32768)
  })

  test("Window headroom wins when the input is large enough to shrink it", () => {
    // All three bounds are live; none may override another. A 700K-char
    // prompt leaves less window headroom than either ceiling.
    const roomy: Model = { ...k26Model, reasoning: { contextWindow: 262144, maxOutputTokens: 235929 } }
    const cap = computeMaxOutputTokens(roomy, [{ role: "user", content: "x".repeat(700_000) }])
    expect(cap).toBeLessThan(MAX_USEFUL_OUTPUT_TOKENS)
    expect(cap).toBe(262144 - Math.ceil(700_000 / 3.5) - 4096)
  })

  test("top-level instructions still consume the combined context window", () => {
    const messages = [{ role: "user", content: "x".repeat(700_000) }]
    const withoutInstructions = computeMaxOutputTokens(k26Model, messages)
    const withInstructions = computeMaxOutputTokens(k26Model, messages, "y".repeat(3500))
    expect(withInstructions).toBe(withoutInstructions! - 1000)
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

  test("OpenRouter/K2.6 context-exceeded error — parsed for retry", () => {
    const msg =
      "This endpoint's maximum context length is 262144 tokens. However, you requested about 262189 tokens (30687 of text input, 231502 in the output). Please reduce the length of either one, or use the context-compression plugin to compress your prompt automatically."
    const parsed = parseContextLengthError(msg)
    expect(parsed).not.toBeNull()
    expect(parsed!.realInputTokens).toBe(30687)
  })

  test("OpenAI-style prompt-too-long error — parsed", () => {
    const msg = "This model's maximum context length is 128000 tokens. However, your prompt has 130000 tokens."
    const parsed = parseContextLengthError(msg)
    expect(parsed).not.toBeNull()
    expect(parsed!.realInputTokens).toBe(130000)
  })

  test("Unrelated error — returns null (no retry)", () => {
    expect(parseContextLengthError("Rate limit exceeded")).toBeNull()
    expect(parseContextLengthError("Connection timeout")).toBeNull()
    expect(parseContextLengthError("")).toBeNull()
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

  // 27977 row 3 / 26799's promise, "clearly oversized input stops before
  // dispatch". The guard in computeMaxOutputTokens is the only pre-dispatch
  // stop a leg has — `ask()` calls it before generateText/streamText, inside
  // the same try — and nothing exercised the throw until now. The specimen
  // that cost 27727 its leg (pro run 0581) did not trip it; the pair below
  // pins both sides of the boundary so nobody reads the guarantee as
  // stronger than the estimator can support.
  test("refuses input beyond the registry window and its uncertainty band", () => {
    const narrow: Model = { ...k26Model, reasoning: { contextWindow: 32768, maxOutputTokens: 16000 } }
    // 140000 chars → 40000 estimated tokens > 1.15 × 32768 (37683).
    const messages = [{ role: "user", content: "x".repeat(140_000) }]
    expect(() => computeMaxOutputTokens(narrow, messages)).toThrow(
      /Estimated input 40000 tokens exceeds openrouter \(moonshotai\/kimi-k2\.6\) registry context window 32768 tokens beyond estimator uncertainty/,
    )
  })

  test("does not refuse the 0581 payload — inside the band is not proof of overflow", () => {
    // The measured specimen: 118553 chars (118223-char context + ~310-char
    // question) → 33873 estimated tokens. The provider counted 34094 for the
    // same text, so the estimate sat within 1% of truth, yet the live route
    // refused at 32768 while the registry and the live OpenRouter catalog both
    // said 128000. The ±15% band is wider than that 4% overflow by design: an
    // estimator that may overcount 15% must not refuse a leg on a guess, so
    // the static endpoint ceiling stands alone and the provider's refusal is
    // what reports — classified as context-length since 27977, never auth.
    const narrow: Model = { ...k26Model, reasoning: { contextWindow: 32768, maxOutputTokens: 16000 } }
    const messages = [{ role: "user", content: "x".repeat(118_553) }]
    expect(computeMaxOutputTokens(narrow, messages)).toBe(16000)
  })
})
