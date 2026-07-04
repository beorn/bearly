/**
 * Canonical cost substrate (bead 19899 Phase 0) — the acceptance matrix:
 * OpenAI cached input, Anthropic cache read/write, standard input/output,
 * unknown model/provider, provider-reported cost passthrough, genuine $0,
 * cache-rate fallback, reasoning-not-double-priced.
 */

import { describe, it, expect } from "vitest"
import { normalizeUsage, resolveCost, formatResolvedCost, UNKNOWN_COST_LABEL, type ModelRates } from "../src/lib/cost"
import { parseLiteLLMMap, matchLiteLLMEntry } from "../src/lib/litellm"

const RATES: ModelRates = { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 }

describe("normalizeUsage", () => {
  it("OpenAI chat: cached_tokens is a SUBSET of prompt — input becomes non-cached", () => {
    const usage = normalizeUsage({
      prompt_tokens: 10_000,
      completion_tokens: 500,
      prompt_tokens_details: { cached_tokens: 8_000 },
    })
    expect(usage).toEqual({ input: 2_000, cache_read: 8_000, output: 500 })
  })

  it("OpenAI responses dialect: input_tokens_details.cached_tokens subset semantics", () => {
    const usage = normalizeUsage({
      input_tokens: 6_000,
      output_tokens: 1_000,
      input_tokens_details: { cached_tokens: 6_000 },
      output_tokens_details: { reasoning_tokens: 400 },
    })
    expect(usage).toEqual({ input: 0, cache_read: 6_000, output: 1_000, reasoning: 400 })
  })

  it("Anthropic: input_tokens already excludes cache classes — disjoint mapping", () => {
    const usage = normalizeUsage({
      input_tokens: 1_200,
      output_tokens: 700,
      cache_read_input_tokens: 50_000,
      cache_creation_input_tokens: 4_000,
    })
    expect(usage).toEqual({ input: 1_200, output: 700, cache_read: 50_000, cache_write: 4_000 })
  })

  it("plain input/output passes through", () => {
    expect(normalizeUsage({ prompt_tokens: 500, completion_tokens: 1000 })).toEqual({ input: 500, output: 1000 })
  })
})

describe("resolveCost precedence (reported > computed > unknown)", () => {
  it("computes per-class cost with distinct cache rates (write > input > read)", () => {
    const result = resolveCost({
      usage: { input: 1_000_000, output: 1_000_000, cache_read: 1_000_000, cache_write: 1_000_000 },
      rates: RATES,
    })
    expect(result.source).toBe("computed")
    expect(result.usd).toBeCloseTo(3 + 15 + 0.3 + 3.75, 10)
    expect(result.breakdown).toEqual({ input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 })
  })

  it("two-rate math matches the legacy estimateCost shape", () => {
    const result = resolveCost({ usage: { input: 500, output: 1000 }, rates: { inputPerM: 2.5, outputPerM: 10 } })
    expect(result.usd).toBeCloseTo(2.5 * (500 / 1e6) + 10 * (1000 / 1e6), 12)
  })

  it("missing cache rates fall back to the input rate (LiteLLM convention)", () => {
    const result = resolveCost({
      usage: { cache_read: 1_000_000, cache_write: 1_000_000 },
      rates: { inputPerM: 3, outputPerM: 15 },
    })
    expect(result.breakdown).toEqual({ cache_read: 3, cache_write: 3 })
  })

  it("provider-reported cost wins over computable tokens", () => {
    const result = resolveCost({ usage: { input: 1_000_000, output: 1_000_000 }, rates: RATES, reportedUsd: 1.23 })
    expect(result).toEqual({ usd: 1.23, source: "provider" })
  })

  it("a genuine reported $0 is provider-sourced and renders $0, not unknown", () => {
    const result = resolveCost({ usage: { input: 10 }, reportedUsd: 0 })
    expect(result.source).toBe("provider")
    expect(formatResolvedCost(result)).toBe("$0.00¢")
  })

  it("no rates and no reported cost → unknown; renders the unknown label, never $0", () => {
    const result = resolveCost({ usage: { input: 500, output: 1000 } })
    expect(result.source).toBe("unknown")
    expect(formatResolvedCost(result)).toBe(UNKNOWN_COST_LABEL)
    expect(formatResolvedCost(result)).not.toContain("$")
  })

  it("reasoning tokens are informational — never priced on top of output", () => {
    const withReasoning = resolveCost({ usage: { input: 100, output: 1_000, reasoning: 900 }, rates: RATES })
    const withoutReasoning = resolveCost({ usage: { input: 100, output: 1_000 }, rates: RATES })
    expect(withReasoning.usd).toBeCloseTo(withoutReasoning.usd, 12)
    expect(withReasoning.breakdown).not.toHaveProperty("reasoning")
  })
})

describe("LiteLLM map parsing + matching", () => {
  const FIXTURE = {
    sample_spec: { input_cost_per_token: 0 },
    "claude-opus-4-5": {
      input_cost_per_token: 5e-6,
      output_cost_per_token: 2.5e-5,
      cache_read_input_token_cost: 5e-7,
      cache_creation_input_token_cost: 6.25e-6,
      litellm_provider: "anthropic",
    },
    "openrouter/some/embedding-model": { output_cost_per_token: 1e-7 },
    "gemini/gemini-3.1-pro": { input_cost_per_token: 2e-6, output_cost_per_token: 1.2e-5 },
  }

  it("parses per-token USD into per-M rates, skipping unpriced + sample_spec entries", () => {
    const map = parseLiteLLMMap(FIXTURE)
    expect(map.size).toBe(2)
    expect(map.get("claude-opus-4-5")).toMatchObject({
      inputPerM: 5,
      outputPerM: 25,
      cacheReadPerM: 0.5,
      cacheWritePerM: 6.25,
    })
  })

  it("matches exact, then provider-prefix-stripped candidates; misses return null", () => {
    const map = parseLiteLLMMap(FIXTURE)
    expect(matchLiteLLMEntry(map, ["claude-opus-4-5"])).not.toBeNull()
    expect(matchLiteLLMEntry(map, ["anthropic/claude-opus-4-5"])).not.toBeNull()
    expect(matchLiteLLMEntry(map, ["gemini/gemini-3.1-pro"])).not.toBeNull()
    expect(matchLiteLLMEntry(map, ["totally-unknown-model"])).toBeNull()
  })
})
