/**
 * Regression: pricing auto-update must:
 *   1. Reject 100× (outlier) price swings — a bad upstream LiteLLM row could
 *      turn $2.50 into $250 and poison every cost estimate. The rejection is
 *      logged as "Suspicious pricing delta" and the MODELS entry is left
 *      unchanged. (cmd/pricing.ts outlier guard)
 *   2. NOT write the pricing cache when the LiteLLM fetch fails, or when no
 *      tracked model is accepted. Writing would reset the 5-day stale timer.
 *   3. Skip auto-update entirely for --dry-run invocations.
 *
 * (bead 19899: the price source is the LiteLLM community map — deterministic
 * fetch, no scrape pages, no LLM extraction.)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { makeTestEnv } from "./helpers"

// A failed fetch and a refresh with no accepted update must leave the cache
// bytes alone. savePricingCache is the only writer.
const savePricingCacheMock = vi.fn()
const isPricingStaleMock = vi.fn()

vi.mock("../src/lib/pricing", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/pricing")>("../src/lib/pricing")
  return {
    ...actual,
    savePricingCache: savePricingCacheMock,
    isPricingStale: isPricingStaleMock,
  }
})

/** A LiteLLM-map response body pricing gpt-5.4 at a 100× hike. */
function outlierLiteLLMBody(): Record<string, unknown> {
  return {
    "gpt-5.4": {
      // $250/M input, $1500/M output — per-token scientific notation as upstream.
      input_cost_per_token: 250 / 1_000_000,
      output_cost_per_token: 1500 / 1_000_000,
      litellm_provider: "openai",
    },
  }
}

describe("pricing sanity", () => {
  beforeEach(() => {
    savePricingCacheMock.mockReset()
    isPricingStaleMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("rejects 100× outlier price delta and leaves MODELS entry unchanged", async () => {
    const env = makeTestEnv()

    // Stub fetch to serve the LiteLLM map with a 100× hike for gpt-5.4:
    // $2.5 → $250, $15 → $1500. The sanity bound (>10×) must reject it.
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => outlierLiteLLMBody(),
    }))
    vi.stubGlobal("fetch", fetchMock)

    vi.resetModules()
    const dispatch = await import("../src/lib/dispatch")
    const { MODELS } = await import("../src/lib/types")
    const gpt54Before = MODELS.find((m) => m.modelId === "gpt-5.4")!
    const inputBefore = gpt54Before.inputPricePerM
    const outputBefore = gpt54Before.outputPricePerM

    const result = await dispatch.performPricingUpdate({ verbose: false, modelMode: "quick" })

    // The only tracked row in the stub map was held by the 10× guard, so the
    // refresh accepts nothing: error, and the cache is not written.
    expect(result.priceChanges).toHaveLength(0)
    expect(result.error).toMatch(/Pricing cache unchanged/)
    expect(savePricingCacheMock).not.toHaveBeenCalled()

    // MODELS entry unchanged.
    const gpt54After = MODELS.find((m) => m.modelId === "gpt-5.4")!
    expect(gpt54After.inputPricePerM).toBe(inputBefore)
    expect(gpt54After.outputPricePerM).toBe(outputBefore)

    // Rejection logged via console.error.
    const stderrAll = env.stderr.join("\n")
    expect(stderrAll).toMatch(/Suspicious pricing delta/)
  }, 10_000)

  it("pricing fetch failure leaves the cache bytes unchanged", async () => {
    makeTestEnv()

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network unreachable")
      }),
    )

    vi.resetModules()
    const dispatch = await import("../src/lib/dispatch")

    const result = await dispatch.performPricingUpdate({ verbose: false, modelMode: "quick" })

    expect(result.error).toBeDefined()
    expect(result.error).toMatch(/Could not fetch any pricing pages/)
    expect(savePricingCacheMock).not.toHaveBeenCalled()
  }, 10_000)

  it("skips auto-update entirely for --dry-run invocations", async () => {
    makeTestEnv()
    const prevNoAutoPricing = process.env.LLM_NO_AUTO_PRICING
    const prevArgv = process.argv
    const fetchMock = vi.fn(async () => {
      throw new Error("dry-run should not fetch pricing")
    })
    try {
      delete process.env.LLM_NO_AUTO_PRICING
      process.argv = ["node", "llm.ts", "pro", "--dry-run", "ping"]
      isPricingStaleMock.mockReturnValue(true)
      vi.stubGlobal("fetch", fetchMock)

      vi.resetModules()
      const dispatch = await import("../src/lib/dispatch")
      await dispatch.maybeAutoUpdatePricing("pro")

      expect(isPricingStaleMock).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      process.argv = prevArgv
      if (prevNoAutoPricing === undefined) delete process.env.LLM_NO_AUTO_PRICING
      else process.env.LLM_NO_AUTO_PRICING = prevNoAutoPricing
    }
  }, 10_000)
})
