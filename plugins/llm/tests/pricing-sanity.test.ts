/**
 * Regression: pricing auto-update must:
 *   1. Reject 100× (outlier) price swings — a hallucinating extraction model
 *      could turn $2.50 into $250 and poison every cost estimate. The rejection
 *      is logged as "Suspicious pricing delta" and the MODELS entry is left
 *      unchanged. (dispatch.ts:~168-176)
 *   2. NOT call cacheCurrentPricing when fetching pricing pages fails. Writing
 *      the cache on failure would reset the 5-day stale timer and block retries
 *      until the timer re-expired. (dispatch.ts:~87-92)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { makeTestEnv } from "./helpers"

// Spy on cacheCurrentPricing to verify the failure path doesn't call it.
// Mocked at the pricing module's export surface so both dispatch.performPricingUpdate
// AND direct callers get the spied version.
const cacheCurrentPricingMock = vi.fn()

vi.mock("../src/lib/pricing", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/pricing")>("../src/lib/pricing")
  return {
    ...actual,
    cacheCurrentPricing: cacheCurrentPricingMock,
  }
})

// Mock queryModel so the pricing extraction doesn't hit the LLM. Returns
// whatever JSON the test wires up.
const queryModelMock = vi.fn()

vi.mock("../src/lib/research", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/research")>("../src/lib/research")
  return {
    ...actual,
    queryModel: queryModelMock,
  }
})

describe("pricing sanity", () => {
  beforeEach(() => {
    cacheCurrentPricingMock.mockReset()
    queryModelMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("rejects 100× outlier price delta and leaves MODELS entry unchanged", async () => {
    const env = makeTestEnv()

    // Stub fetch so the pricing pages "load" (short HTML body is enough —
    // performPricingUpdate strips tags and truncates to 8K). All five PRICING_SOURCES
    // entries return successful responses.
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "<html>pricing page</html>",
    }))
    vi.stubGlobal("fetch", fetchMock)

    // LLM returns a 100× hike for gpt-5.4: $2.5 → $250, $15 → $1500.
    // The sanity bound (>10×) must reject it.
    queryModelMock.mockResolvedValue({
      response: {
        model: { modelId: "gpt-5.4", displayName: "GPT-5.4", provider: "openai" },
        content: JSON.stringify([{ modelId: "gpt-5.4", inputPricePerM: 250.0, outputPricePerM: 1500.0 }]),
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        durationMs: 10,
      },
    })

    vi.resetModules()
    const dispatch = await import("../src/lib/dispatch")
    const { MODELS } = await import("../src/lib/types")
    const gpt54Before = MODELS.find((m) => m.modelId === "gpt-5.4")!
    const inputBefore = gpt54Before.inputPricePerM
    const outputBefore = gpt54Before.outputPricePerM

    const result = await dispatch.performPricingUpdate({ verbose: false, modelMode: "quick" })

    // No price change should have been recorded — the delta was rejected.
    expect(result.priceChanges).toHaveLength(0)

    // MODELS entry unchanged.
    const gpt54After = MODELS.find((m) => m.modelId === "gpt-5.4")!
    expect(gpt54After.inputPricePerM).toBe(inputBefore)
    expect(gpt54After.outputPricePerM).toBe(outputBefore)

    // Rejection logged via console.error.
    const stderrAll = env.stderr.join("\n")
    expect(stderrAll).toMatch(/Suspicious pricing delta/)
  }, 10_000)

  it("pricing fetch failure does NOT reset the stale timer (cacheCurrentPricing not called)", async () => {
    makeTestEnv()

    // All fetches fail — either network error or non-OK. performPricingUpdate
    // must short-circuit BEFORE cacheCurrentPricing.
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
    // Core assertion: the cache write function was NEVER invoked. Previous
    // (buggy) code would have reset the 5-day timer even on total failure.
    expect(cacheCurrentPricingMock).not.toHaveBeenCalled()
  }, 10_000)
})
