/**
 * @failure a background-capable Pro leg is dispatched through the METERED Responses path even when the subscription
 *   CLI route applies, while the dry-run line above it promises the subscription route and the run then fails on a
 *   missing API key (37884; measured by @cto fa9e7ff9).
 * @level l1
 * @consumer plugins/llm pro.ts dispatchOne; ask.ts --pro branch
 * @testonly none
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { shouldUseOpenAIBackground } from "./openai-deep"
import { getModel } from "./types"

const savedSubscription = process.env.LLM_SUBSCRIPTION_CLI

beforeEach(() => {
  delete process.env.LLM_SUBSCRIPTION_CLI
})

afterEach(() => {
  if (savedSubscription === undefined) delete process.env.LLM_SUBSCRIPTION_CLI
  else process.env.LLM_SUBSCRIPTION_CLI = savedSubscription
})

describe("background route vs subscription route (37884)", () => {
  const pro = getModel("gpt-5.5-pro")!

  it("keeps a Pro leg on the subscription CLI when that route applies", () => {
    expect(shouldUseOpenAIBackground(pro, {}, () => "codex")).toBe(false)
  })

  it("uses the metered background path when no subscription route applies", () => {
    expect(shouldUseOpenAIBackground(pro, {}, () => undefined)).toBe(true)
  })

  it("never sends an image to the text-only background path", () => {
    expect(shouldUseOpenAIBackground(pro, { hasImage: true }, () => "codex")).toBe(false)
    expect(shouldUseOpenAIBackground(pro, { hasImage: true }, () => undefined)).toBe(false)
  })

  it("stays off the background path for a model that cannot use it", () => {
    const notCapable = { ...pro, isDeepResearch: true }
    expect(shouldUseOpenAIBackground(notCapable, {}, () => undefined)).toBe(false)
  })

  it("does not consult the subscription resolver when LLM_SUBSCRIPTION_CLI=0 disables it", () => {
    process.env.LLM_SUBSCRIPTION_CLI = "0"
    // The real resolver returns undefined while disabled, so the metered path is permitted again.
    expect(shouldUseOpenAIBackground(pro)).toBe(true)
  })
})
