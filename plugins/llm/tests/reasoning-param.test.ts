/**
 * Phase-2 capability extension: typed-union `reasoningParam` on the
 * ProviderEndpoint replaces the residual `model.provider === "openai"` string
 * match in research.ts. Each provider declares its reasoning knob verbatim
 * (effort enum vs token budget vs depth mode vs boolean toggle); routing
 * reads `endpoint.reasoningParam.kind` and dispatches per discriminator.
 *
 * These tests cover three concerns:
 *   1. Schema/registry — `reasoningParam` parses + appears on real endpoints.
 *   2. Discriminated-union construction — every variant is well-typed.
 *   3. Dispatch — `queryModel` writes the correct `providerOptions` slot for
 *      each reasoning kind without inspecting the provider name.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { makeTestEnv } from "./helpers"

const generateTextMock = vi.fn()
const streamTextMock = vi.fn()

vi.mock("ai", () => {
  return {
    generateText: generateTextMock,
    streamText: streamTextMock,
  }
})

function resetMocksToOk() {
  generateTextMock.mockReset()
  generateTextMock.mockResolvedValue({
    text: "ok",
    reasoning: [],
    usage: { inputTokens: 10, outputTokens: 5 },
  })
  streamTextMock.mockReset()
  streamTextMock.mockImplementation(() => ({
    textStream: (async function* () {
      yield "ok"
    })(),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
  }))
}

describe("reasoning-param: schema + registry", () => {
  it("parses a ProviderEndpoint with reasoningParam: openai-effort", async () => {
    const { ProviderEndpointSchema } = await import("../src/lib/types")
    const parsed = ProviderEndpointSchema.parse({
      provider: "openai",
      capabilities: { webSearch: false, backgroundApi: true, vision: false, deepResearch: false },
      reasoningParam: { kind: "openai-effort", defaultLevel: "high" },
    })
    expect(parsed.reasoningParam).toEqual({ kind: "openai-effort", defaultLevel: "high" })
  })

  it("each ReasoningParam variant is constructible and discriminator-matches", async () => {
    const { ReasoningParamSchema } = await import("../src/lib/types")
    const variants = [
      { kind: "openai-effort", defaultLevel: "medium" } as const,
      { kind: "anthropic-budget", defaultTokens: 8192 } as const,
      { kind: "google-depth", defaultMode: "deep" } as const,
      { kind: "deepseek-thinking", defaultEnabled: true } as const,
    ]
    for (const v of variants) {
      const parsed = ReasoningParamSchema.parse(v)
      expect(parsed.kind).toBe(v.kind)
    }
  })

  it("rejects an unknown reasoningParam kind", async () => {
    const { ReasoningParamSchema } = await import("../src/lib/types")
    const result = ReasoningParamSchema.safeParse({ kind: "bogus-kind" })
    expect(result.success).toBe(false)
  })

  it("real endpoints in PROVIDER_ENDPOINTS carry the expected reasoningParam shapes", async () => {
    const { getEndpoint } = await import("../src/lib/types")

    const o3pro = getEndpoint("o3-pro")
    expect(o3pro?.reasoningParam).toEqual({ kind: "openai-effort", defaultLevel: "high" })

    const opus = getEndpoint("claude-opus-4-6")
    expect(opus?.reasoningParam).toEqual({ kind: "anthropic-budget", defaultTokens: 16384 })

    const gemini = getEndpoint("gemini-3-pro-preview")
    expect(gemini?.reasoningParam).toEqual({ kind: "google-depth", defaultMode: "standard" })

    const deepseek = getEndpoint("deepseek/deepseek-r1")
    expect(deepseek?.reasoningParam).toEqual({ kind: "deepseek-thinking", defaultEnabled: true })

    // Non-reasoning models leave reasoningParam unset.
    const sonnet45 = getEndpoint("claude-sonnet-4-5-20250929")
    expect(sonnet45?.reasoningParam).toBeUndefined()
    const flash = getEndpoint("gemini-2.5-flash")
    expect(flash?.reasoningParam).toBeUndefined()
  })
})

describe("reasoning-param: dispatch", () => {
  beforeEach(() => {
    resetMocksToOk()
  })

  it("openai-effort endpoint → providerOptions.openai.reasoningEffort", async () => {
    makeTestEnv()
    vi.resetModules()

    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")

    const model = getModel("o3-pro")!
    const { response } = await queryModel({ question: "hi", model })
    expect(response.error).toBeUndefined()

    expect(generateTextMock).toHaveBeenCalledTimes(1)
    const call = generateTextMock.mock.calls[0]![0]
    expect(call.providerOptions?.openai).toEqual({ reasoningEffort: "high" })
    expect(call.providerOptions?.anthropic).toBeUndefined()
  })

  it("anthropic-budget endpoint → providerOptions.anthropic.thinking with budgetTokens", async () => {
    makeTestEnv()
    vi.resetModules()

    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")

    const model = getModel("claude-sonnet-4-6")!
    const { response } = await queryModel({ question: "hi", model })
    expect(response.error).toBeUndefined()

    expect(generateTextMock).toHaveBeenCalledTimes(1)
    const call = generateTextMock.mock.calls[0]![0]
    expect(call.providerOptions?.anthropic).toEqual({
      thinking: { type: "enabled", budgetTokens: 8192 },
    })
    expect(call.providerOptions?.openai).toBeUndefined()
  })

  it("google-depth endpoint → no providerOptions today (TODO when SDK supports it), but does not crash", async () => {
    makeTestEnv()
    vi.resetModules()

    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")

    const model = getModel("gemini-3-pro-preview")!
    const { response } = await queryModel({ question: "hi", model })
    expect(response.error).toBeUndefined()

    expect(generateTextMock).toHaveBeenCalledTimes(1)
    const call = generateTextMock.mock.calls[0]![0]
    // Google depth not yet plumbed — call must succeed without setting
    // provider-name-matched options. The registry-level intent is what
    // matters for this test; the SDK wiring is a follow-up.
    expect(call.providerOptions?.google).toBeUndefined()
    expect(call.providerOptions?.openai).toBeUndefined()
    expect(call.providerOptions?.anthropic).toBeUndefined()
  })

  it("deepseek-thinking endpoint → no providerOptions today (TODO when SDK supports it), but does not crash", async () => {
    makeTestEnv()
    vi.resetModules()

    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")

    const model = getModel("deepseek/deepseek-r1")!
    const { response } = await queryModel({ question: "hi", model })
    expect(response.error).toBeUndefined()

    expect(generateTextMock).toHaveBeenCalledTimes(1)
    const call = generateTextMock.mock.calls[0]![0]
    expect(call.providerOptions?.openrouter).toBeUndefined()
    expect(call.providerOptions?.openai).toBeUndefined()
    expect(call.providerOptions?.anthropic).toBeUndefined()
  })

  it("non-reasoning model (claude-sonnet-4-5) → no providerOptions, no provider-name match", async () => {
    makeTestEnv()
    vi.resetModules()

    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")

    const model = getModel("claude-sonnet-4-5-20250929")!
    expect(model.reasoning).toBeUndefined()

    const { response } = await queryModel({ question: "hi", model })
    expect(response.error).toBeUndefined()

    expect(generateTextMock).toHaveBeenCalledTimes(1)
    const call = generateTextMock.mock.calls[0]![0]
    // No reasoningParam, no legacy reasoning — providerOptions absent entirely.
    expect(call.providerOptions).toBeUndefined()
  })

  it("o-series with default-level fallback: openai-effort dispatch reads endpoint defaultLevel when SKU has no openaiEffort", async () => {
    // o3-mini ships with both endpoint.reasoningParam.defaultLevel="medium"
    // AND sku.reasoning.openaiEffort="medium". Drop the SKU override at runtime
    // and verify the endpoint default still drives dispatch — no provider-name
    // match required.
    makeTestEnv()
    vi.resetModules()

    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")

    const baseModel = getModel("o3-mini")!
    // Strip the legacy SKU reasoning.openaiEffort to prove the new typed-union
    // path is the one driving dispatch (not the back-compat fallback).
    const model = { ...baseModel, reasoning: { ...baseModel.reasoning, openaiEffort: undefined } }

    const { response } = await queryModel({ question: "hi", model })
    expect(response.error).toBeUndefined()

    expect(generateTextMock).toHaveBeenCalledTimes(1)
    const call = generateTextMock.mock.calls[0]![0]
    expect(call.providerOptions?.openai).toEqual({ reasoningEffort: "medium" })
  })
})
