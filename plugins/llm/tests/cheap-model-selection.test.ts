import { describe, it, expect } from "vitest"
import { getCheapModels, MODELS } from "../src/lib/types"

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
})
