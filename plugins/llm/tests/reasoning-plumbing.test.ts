/**
 * Regression: reasoning-model controls must flow through the Vercel AI SDK
 * provider-options surface for the two providers that expose them.
 *
 *   - OpenAI o-series: `providerOptions.openai.reasoningEffort` = "low" |
 *     "medium" | "high". Set in MODELS per-model (o3 / o3-pro / o3-mini /
 *     o4-mini).
 *   - Anthropic Claude 4.5+ extended thinking:
 *     `providerOptions.anthropic.thinking` = { type: "enabled",
 *     budgetTokens: N }. Set in MODELS on claude-opus-4-6 and
 *     claude-sonnet-4-6.
 *
 * Without the plumbing, the `reasoning` metadata was inert — the fields
 * existed on the type but never reached the SDK call. Both paths go through
 * queryModel() in research.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
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
    finalStep: { reasoningText: undefined },
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

  it("AI SDK 7: passes the system prompt as instructions instead of a system-role message", async () => {
    makeTestEnv()
    vi.resetModules()

    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")

    const model = getModel("gpt-5-nano")!
    const { response } = await queryModel({
      question: "Answer briefly.",
      systemPrompt: "Be precise.",
      model,
    })
    expect(response.error).toBeUndefined()

    expect(generateTextMock).toHaveBeenCalledTimes(1)
    const call = generateTextMock.mock.calls[0]![0]
    expect(call.instructions).toBe("Be precise.")
    expect(call.messages).toEqual([{ role: "user", content: "Answer briefly." }])
  })

  it("AI SDK 7: sends images as file parts with mediaType", async () => {
    const env = makeTestEnv()
    const imagePath = join(env.tmpDir, "shot.png")
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    vi.resetModules()

    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")

    const model = getModel("gpt-5-nano")!
    const { response } = await queryModel({ question: "Describe this.", imagePath, model })
    expect(response.error).toBeUndefined()

    const call = generateTextMock.mock.calls[0]![0]
    expect(call.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this." },
          { type: "file", data: expect.any(Uint8Array), mediaType: "image/png" },
        ],
      },
    ])
  })

  it("AI SDK 7: reads text reasoning from finalStep without serializing reasoning files", async () => {
    makeTestEnv()
    vi.resetModules()
    generateTextMock.mockResolvedValueOnce({
      text: "ok",
      reasoning: [
        { type: "reasoning", text: "kept reasoning" },
        { type: "reasoning-file", file: { mediaType: "text/plain" } },
      ],
      finalStep: { reasoningText: "kept reasoning" },
      usage: { inputTokens: 10, outputTokens: 5 },
    })

    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")

    const model = getModel("gpt-5-nano")!
    const { response } = await queryModel({ question: "Answer briefly.", model })

    expect(response.reasoning).toBe("kept reasoning")
  })

  it("OpenAI o-series: passes providerOptions.openai.reasoningEffort when model.reasoning.openaiEffort is set", async () => {
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
    expect(call.providerOptions.openai).toEqual({ reasoningEffort: "high" })
    // Anthropic slot must NOT leak onto an OpenAI call.
    expect(call.providerOptions.anthropic).toBeUndefined()
  })

  it("Anthropic Claude 4.6: passes providerOptions.anthropic.thinking with budgetTokens when model.reasoning.anthropicBudget is set", async () => {
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
      thinking: { type: "enabled", budgetTokens: 16384 },
    })
    // OpenAI slot must NOT leak onto an Anthropic call.
    expect(call.providerOptions.openai).toBeUndefined()
  })
})
