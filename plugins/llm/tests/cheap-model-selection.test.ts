import { describe, it, expect } from "vitest"
import { getCheapModels, getModel, MODELS } from "../src/lib/types"
import { selectModels, type ProviderAvailabilityFact } from "../src/index"

// Regression coverage for the "cheap tier picks a slow reasoning model"
// defect (2026-08-05, recall synthesis timeout investigation): getCheapModels
// used to return the FIRST "low" costTier SKU per provider in MODELS array
// order, with no regard for whether that SKU declares a `reasoning` config.
// A heavy reasoning model (Kimi K2.6, ~15s typical, burns reasoning tokens
// on every call regardless of task complexity) and a fast non-reasoning
// model (DeepSeek Chat V3, ~5s typical) are both "low" cost — array order
// alone decided which one every "give me a cheap model" caller got.
describe("getCheapModels — reasoning-vs-non-reasoning selection", () => {
  it("prefers OpenRouter's non-reasoning DeepSeek Chat V3 over the reasoning Kimi K2.6, even though Kimi is registered first", () => {
    const models = getCheapModels(Number.MAX_SAFE_INTEGER)
    const openrouterPick = models.find((m) => m.provider === "openrouter")
    expect(openrouterPick?.modelId).toBe("deepseek/deepseek-chat")
    expect(openrouterPick?.reasoning).toBeUndefined()
  })

  it("never picks a reasoning-declaring SKU when a non-reasoning 'low' SKU exists for the same provider", () => {
    const models = getCheapModels(Number.MAX_SAFE_INTEGER)
    for (const model of models) {
      if (model.reasoning === undefined) continue
      // A reasoning pick is only correct if EVERY "low" SKU for that
      // provider also declares reasoning (no non-reasoning alternative
      // existed to prefer).
      const siblings = MODELS.filter((m) => m.provider === model.provider && m.costTier === "low" && !m.isDeepResearch)
      expect(siblings.every((s) => s.reasoning !== undefined)).toBe(true)
    }
  })

  it("leaves every non-OpenRouter provider's pick unchanged — none of their 'low' SKUs declare reasoning, so the fix never fires there", () => {
    const models = getCheapModels(Number.MAX_SAFE_INTEGER)
    const byProvider = new Map(models.map((m) => [m.provider, m]))
    // The first-registered "low" SKU for each of these — same as the old
    // pure-array-order behavior — because none of them have a reasoning
    // alternative to lose to.
    expect(byProvider.get("openai")?.modelId).toBe("gpt-5-nano")
    expect(byProvider.get("anthropic")?.modelId).toBe("claude-haiku-4-5-20251001")
    expect(byProvider.get("google")?.modelId).toBe("gemini-2.5-flash")
  })

  it("preserves provider order (first-appearance in MODELS) and the max cap, matching prior behavior", () => {
    const two = getCheapModels(2)
    expect(two).toHaveLength(2)
    expect(two.map((m) => m.provider)).toEqual(["openai", "anthropic"])
  })

  it("still excludes deep-research and non-low-tier SKUs", () => {
    const models = getCheapModels(Number.MAX_SAFE_INTEGER)
    expect(models.every((m) => m.costTier === "low" && !m.isDeepResearch)).toBe(true)
  })

  it("keeps the complete legacy representative sequence byte-compatible", () => {
    expect(getCheapModels(Number.MAX_SAFE_INTEGER).map(({ provider, modelId }) => ({ provider, modelId }))).toEqual([
      { provider: "openai", modelId: "gpt-5-nano" },
      { provider: "anthropic", modelId: "claude-haiku-4-5-20251001" },
      { provider: "google", modelId: "gemini-2.5-flash" },
      { provider: "xai", modelId: "grok-4-1-fast-reasoning" },
      { provider: "openrouter", modelId: "deepseek/deepseek-chat" },
      { provider: "perplexity", modelId: "sonar" },
    ])
  })

  it("preserves the legacy max=0 edge behavior", () => {
    expect(getCheapModels(0)).toEqual([getCheapModels(Number.MAX_SAFE_INTEGER)[0]])
  })
})

describe("selectModels — availability bands before latency", () => {
  const at = 10_000
  const model = (id: string, latency: number | undefined) => {
    const registered = getModel(id)
    if (!registered) throw new Error(`test fixture model missing: ${id}`)
    return { ...registered, typicalLatencyMs: latency }
  }

  const fact = (
    value: Omit<ProviderAvailabilityFact, "source" | "reason"> &
      Partial<Pick<ProviderAvailabilityFact, "source" | "reason">>,
  ): ProviderAvailabilityFact => ({ source: "test", reason: "test evidence", ...value }) as ProviderAvailabilityFact

  it("excludes fresh refusing providers, ranks fresh available before faster cold unknown, and retains unknown", () => {
    const openai = model("gpt-5-nano", 50)
    const anthropic = model("claude-haiku-4-5-20251001", 10)
    const google = model("gemini-2.5-flash", 100)
    const facts: ProviderAvailabilityFact[] = [
      fact({
        provider: "openai",
        status: "refusing",
        kind: "auth",
        observedAt: at - 10,
        expiresAt: at + 1_000,
        reason: "401 invalid_api_key",
      }),
      fact({
        provider: "google",
        status: "available",
        observedAt: at - 10,
        expiresAt: at + 1_000,
      }),
    ]

    const result = selectModels({ candidates: [openai, anthropic, google], facts, now: at, limit: 3 })

    expect(result.selected.map((candidate) => candidate.modelId)).toEqual([
      "gemini-2.5-flash",
      "claude-haiku-4-5-20251001",
    ])
    expect(result.excluded).toContainEqual(
      expect.objectContaining({
        model: expect.objectContaining({ modelId: "gpt-5-nano" }),
        status: "refusing",
        kind: "auth",
        reason: "401 invalid_api_key",
      }),
    )
  })

  it("treats expired refusing evidence as unknown and reports its age", () => {
    const candidate = model("gpt-5-nano", 50)
    const result = selectModels({
      candidates: [candidate],
      facts: [
        fact({
          provider: "openai",
          status: "refusing",
          kind: "quota",
          observedAt: at - 2_000,
          expiresAt: at - 1,
        }),
      ],
      now: at,
      limit: 1,
    })

    expect(result.selected).toEqual([candidate])
    expect(result.evidence).toContainEqual(
      expect.objectContaining({ provider: "openai", status: "unknown", kind: "quota", ageMs: 2_000 }),
    )
  })

  it("sorts latency ascending inside a status band, with undefined last and registry order as the tie-break", () => {
    const firstTie = model("gpt-5-nano", 100)
    const secondTie = model("claude-haiku-4-5-20251001", 100)
    const unknownLatency = model("gemini-2.5-flash", undefined)
    const facts: ProviderAvailabilityFact[] = [firstTie, secondTie, unknownLatency].map((candidate) =>
      fact({
        provider: candidate.provider,
        status: "available",
        observedAt: at - 1,
        expiresAt: at + 1_000,
      }),
    )

    const result = selectModels({ candidates: [secondTie, firstTie, unknownLatency], facts, now: at, limit: 3 })
    expect(result.selected).toEqual([firstTie, secondTie, unknownLatency])
  })

  it("applies caller exclusions before facts and returns diagnostic context when nothing is eligible", () => {
    const candidate = model("gpt-5-nano", 50)
    const result = selectModels({
      candidates: [candidate],
      facts: [],
      now: at,
      exclude: ["openai"],
      limit: 1,
    })

    expect(result.selected).toEqual([])
    expect(result.candidates).toEqual([candidate])
    expect(result.excluded).toEqual([
      expect.objectContaining({
        model: candidate,
        status: "excluded",
        reason: "excluded by caller",
      }),
    ])
  })

  it("rejects a zero limit instead of selecting one model accidentally", () => {
    expect(() => selectModels({ candidates: [model("gpt-5-nano", 50)], facts: [], now: at, limit: 0 })).toThrow(
      "selectModels limit must be a positive safe integer; received 0",
    )
  })

  it("rejects a non-finite observation time", () => {
    expect(() => selectModels({ candidates: [model("gpt-5-nano", 50)], facts: [], now: Number.NaN, limit: 1 })).toThrow(
      "selectModels now must be finite; received NaN",
    )
  })
})
