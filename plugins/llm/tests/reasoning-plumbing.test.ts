/**
 * Regression: reasoning-model controls must flow through the Vercel AI SDK
 * provider-options surface for the two providers that expose them.
 *
 *   - OpenAI o-series: `providerOptions.openai.reasoning_effort` = "low" |
 *     "medium" | "high". Set in MODELS per-model (o3 / o3-pro / o3-mini /
 *     o4-mini).
 *   - Anthropic Claude 4.5+ extended thinking:
 *     `providerOptions.anthropic.thinking` = { type: "enabled",
 *     budget_tokens: N }. Set in MODELS on claude-opus-4-6 and
 *     claude-sonnet-4-6.
 *
 * Without the plumbing, the `reasoning` metadata was inert — the fields
 * existed on the type but never reached the SDK call. Both paths go through
 * queryModel() in research.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { makeTestEnv } from "./helpers"

// Mock `ai` at the import boundary — generateText / streamText never hit
// the network, just record the arguments they receive.
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

describe("reasoning-plumbing", () => {
  beforeEach(() => {
    resetMocksToOk()
  })

  it("OpenAI o-series: passes providerOptions.openai.reasoning_effort when model.reasoning.openaiEffort is set", async () => {
    makeTestEnv()
    vi.resetModules()

    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")

    // o3-pro is seeded with openaiEffort: "high" in MODELS.
    const model = getModel("o3-pro")!
    expect(model.reasoning?.openaiEffort).toBe("high")

    const { response } = await queryModel({ question: "hi", model })
    expect(response.error).toBeUndefined()

    // Non-streaming path goes through generateText.
    expect(generateTextMock).toHaveBeenCalledTimes(1)
    const call = generateTextMock.mock.calls[0]![0]
    expect(call.providerOptions).toBeDefined()
    expect(call.providerOptions.openai).toEqual({ reasoning_effort: "high" })
    // Anthropic slot must NOT leak onto an OpenAI call.
    expect(call.providerOptions.anthropic).toBeUndefined()
  })

  it("Anthropic Claude 4.6: passes providerOptions.anthropic.thinking with budget_tokens when model.reasoning.anthropicBudget is set", async () => {
    makeTestEnv()
    vi.resetModules()

    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")

    // claude-opus-4-6 is seeded with anthropicBudget: 16384 in MODELS.
    const model = getModel("claude-opus-4-6")!
    expect(model.reasoning?.anthropicBudget).toBe(16384)

    const { response } = await queryModel({ question: "hi", model })
    expect(response.error).toBeUndefined()

    expect(generateTextMock).toHaveBeenCalledTimes(1)
    const call = generateTextMock.mock.calls[0]![0]
    expect(call.providerOptions).toBeDefined()
    expect(call.providerOptions.anthropic).toEqual({
      thinking: { type: "enabled", budget_tokens: 16384 },
    })
    // OpenAI slot must NOT leak onto an Anthropic call.
    expect(call.providerOptions.openai).toBeUndefined()
  })
})
