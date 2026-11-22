/**
 * @failure a background-capable Pro leg is dispatched through the METERED Responses path even when the subscription
 *   CLI route applies, while the dry-run line above it promises the subscription route and the run then fails on a
 *   missing API key (37884; measured by @cto fa9e7ff9). The gate must read `resolveQueryRoute`, the one decision the
 *   dry-run, the forecast and the dispatch share — not a second expression of the same rule.
 * @level l1
 * @consumer plugins/llm pro.ts forecastLeg + dispatchOne; ask.ts --pro branch
 * @testonly none
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { shouldUseOpenAIBackground } from "./research"
import { getModel, type Model } from "./types"

const savedSubscription = process.env.LLM_SUBSCRIPTION_CLI
const pro = getModel("gpt-5.5-pro")!

const subscription = () => ({ kind: "subscription", cli: "codex" }) as const
const metered = () => ({ kind: "metered" }) as const
const local = () => ({ kind: "local" }) as const

beforeEach(() => {
  delete process.env.LLM_SUBSCRIPTION_CLI
})

afterEach(() => {
  if (savedSubscription === undefined) delete process.env.LLM_SUBSCRIPTION_CLI
  else process.env.LLM_SUBSCRIPTION_CLI = savedSubscription
})

describe("background route vs subscription route (37884)", () => {
  it("keeps a Pro leg on the subscription CLI when the shared route is a subscription", () => {
    expect(shouldUseOpenAIBackground(pro, {}, subscription)).toBe(false)
  })

  it("uses the metered background path only when the shared route is metered", () => {
    expect(shouldUseOpenAIBackground(pro, {}, metered)).toBe(true)
  })

  it("stays off the background path for a local route", () => {
    expect(shouldUseOpenAIBackground(pro, {}, local)).toBe(false)
  })

  it("never sends an image to the text-only background path", () => {
    expect(shouldUseOpenAIBackground(pro, { hasImage: true }, subscription)).toBe(false)
    expect(shouldUseOpenAIBackground(pro, { hasImage: true }, metered)).toBe(false)
  })

  it("stays off the background path for a model that cannot use it", () => {
    const notCapable: Model = { ...pro, isDeepResearch: true }
    expect(shouldUseOpenAIBackground(notCapable, {}, metered)).toBe(false)
  })

  it("permits the metered path when LLM_SUBSCRIPTION_CLI=0 removes the subscription route", () => {
    process.env.LLM_SUBSCRIPTION_CLI = "0"
    expect(shouldUseOpenAIBackground(pro)).toBe(true)
  })
})
