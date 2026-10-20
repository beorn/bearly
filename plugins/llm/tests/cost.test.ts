/**
 * Canonical cost substrate (bead 19899 Phase 0) — the acceptance matrix:
 * standard input/output, cache read/write, unknown model/provider,
 * provider-reported cost passthrough, genuine $0, cache-rate fallback,
 * reasoning-not-double-priced.
 */

import { describe, it, expect } from "vitest"
import { resolveCost, resolveSubscriptionCost, type ModelRates } from "../src/lib/cost"
import { parseLiteLLMMap, matchLiteLLMEntry } from "../src/lib/litellm"

const RATES: ModelRates = { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 }

describe("resolveCost keeps charged dollars and list-equivalent estimates independent", () => {
  it("computes per-class cost with distinct cache rates (write > input > read)", () => {
    const result = resolveCost({
      usage: { input: 1_000_000, output: 1_000_000, cache_read: 1_000_000, cache_write: 1_000_000 },
      rates: RATES,
    })
    expect(result.charged).toEqual({ reason: "provider did not state a charge" })
    expect(result.listEquivalent).toEqual({ usd: 3 + 15 + 0.3 + 3.75 })
    expect(result.breakdown).toEqual({ input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 })
  })

  it("two-rate math matches the legacy estimateCost shape", () => {
    const result = resolveCost({ usage: { input: 500, output: 1000 }, rates: { inputPerM: 2.5, outputPerM: 10 } })
    expect(result.listEquivalent).toEqual({ usd: expect.closeTo(0.01125, 12) })
  })

  it("missing cache rates fall back to the input rate (LiteLLM convention)", () => {
    const result = resolveCost({
      usage: { cache_read: 1_000_000, cache_write: 1_000_000 },
      rates: { inputPerM: 3, outputPerM: 15 },
    })
    expect(result.breakdown).toEqual({ cache_read: 3, cache_write: 3 })
  })

  it("preserves a stated charge beside a deliberately different computable estimate", () => {
    const result = resolveCost({ usage: { input: 1_000_000, output: 1_000_000 }, rates: RATES, reportedUsd: 1.23 })
    expect(result.charged).toEqual({ usd: 1.23 })
    expect(result.listEquivalent).toEqual({ usd: 18 })
    expect(result).not.toHaveProperty("usd")
    expect(result).not.toHaveProperty("source")
  })

  it("a genuine reported $0 is provider-sourced, not unknown", () => {
    const result = resolveCost({ usage: { input: 10 }, reportedUsd: 0 })
    expect(result.charged).toEqual({ usd: 0 })
    expect(result.listEquivalent).toEqual({ reason: "model rates are unavailable" })
  })

  it("no rates and no reported cost → unknown provenance, not a synthetic $0", () => {
    const result = resolveCost({ usage: { input: 500, output: 1000 } })
    expect(result.charged).toEqual({ reason: "provider did not state a charge" })
    expect(result.listEquivalent).toEqual({ reason: "model rates are unavailable" })
  })

  it("reasoning tokens are informational — never priced on top of output", () => {
    const withReasoning = resolveCost({ usage: { input: 100, output: 1_000, reasoning: 900 }, rates: RATES })
    const withoutReasoning = resolveCost({ usage: { input: 100, output: 1_000 }, rates: RATES })
    expect(withReasoning.listEquivalent).toEqual({ usd: expect.closeTo(0.0153, 12) })
    expect(withoutReasoning.listEquivalent).toEqual({ usd: expect.closeTo(0.0153, 12) })
    expect(withReasoning.breakdown).not.toHaveProperty("reasoning")
  })

  // @failure A subscription or invalid stated amount is treated as a charge.
  // @level l0 @consumer The shared resolver's independent known/unknown amounts.
  // Previous provider precedence does not retain a separate computable column.
  it("keeps a subscription charge unknown while retaining an available estimate", () => {
    const result = resolveSubscriptionCost({ usage: { input: 1_000_000 }, rates: RATES })
    expect(result.charged).toEqual({ reason: "subscription route has no stated API-key charge" })
    expect(result.listEquivalent).toEqual({ usd: 3 })
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "does not treat invalid stated charge %s as money or discard the estimate",
    (reportedUsd) => {
      const result = resolveCost({ usage: { input: 1_000_000 }, rates: RATES, reportedUsd })
      expect(result.charged).toEqual({ reason: "provider stated an invalid charge" })
      expect(result.listEquivalent).toEqual({ usd: 3 })
    },
  )
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
