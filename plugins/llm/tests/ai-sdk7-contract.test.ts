/**
 * @failure An AI SDK major upgrade silently drops instructions, image data, reasoning, usage, or quota headers.
 * @level l1 — bearly's real query mapping over controlled SDK results
 * @consumer bearly LLM CLI and library response envelopes
 * @testonly none
 */

import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeTestEnv } from "./helpers"

const generateTextMock = vi.fn()
const streamTextMock = vi.fn()
vi.mock("ai", () => ({ generateText: generateTextMock, streamText: streamTextMock }))

beforeEach(() => {
  generateTextMock.mockReset()
  streamTextMock.mockReset()
  generateTextMock.mockResolvedValue({
    text: "ok",
    finalStep: { reasoningText: undefined },
    usage: { inputTokens: 10, outputTokens: 5 },
  })
})

describe("AI SDK 7 bearly response contract", () => {
  it("sends system text as instructions and only user content as messages", async () => {
    makeTestEnv()
    vi.resetModules()
    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")

    const { response } = await queryModel({
      question: "Answer briefly.",
      systemPrompt: "Be precise.",
      model: getModel("gpt-5-nano")!,
    })

    expect(response.error).toBeUndefined()
    expect(generateTextMock.mock.calls[0]![0]).toMatchObject({
      instructions: "Be precise.",
      messages: [{ role: "user", content: "Answer briefly." }],
    })
  })

  it("sends images as file parts with their media type", async () => {
    const env = makeTestEnv()
    const imagePath = join(env.tmpDir, "shot.png")
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    vi.resetModules()
    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")

    const { response } = await queryModel({ question: "Describe this.", imagePath, model: getModel("gpt-5-nano")! })

    expect(response.error).toBeUndefined()
    expect(generateTextMock.mock.calls[0]![0].messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this." },
          { type: "file", data: expect.any(Uint8Array), mediaType: "image/png" },
        ],
      },
    ])
  })

  it("preserves final-step text reasoning without serializing reasoning files", async () => {
    makeTestEnv()
    generateTextMock.mockResolvedValueOnce({
      text: "ok",
      reasoning: [{ type: "reasoning-file", file: { mediaType: "text/plain" } }],
      finalStep: { reasoningText: "kept reasoning" },
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    vi.resetModules()
    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")

    const { response } = await queryModel({ question: "hi", model: getModel("gpt-5-nano")! })

    expect(response.reasoning).toBe("kept reasoning")
  })

  it("keeps fixed SDK usage and its cost in the bearly envelope", async () => {
    makeTestEnv()
    generateTextMock.mockResolvedValueOnce({
      text: "ok",
      finalStep: { reasoningText: undefined },
      usage: { inputTokens: 100, outputTokens: 50 },
    })
    vi.resetModules()
    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")
    const { totalResponseCost } = await import("../src/lib/format")
    const model = { ...getModel("gpt-5-nano")!, inputPricePerM: 2, outputPricePerM: 10 }

    const { response } = await queryModel({ question: "hi", model })

    expect(response.usage).toEqual({ promptTokens: 100, completionTokens: 50, totalTokens: 150 })
    expect(totalResponseCost([response])).toBeCloseTo(0.0007)
  })

  it("keeps generateText rate-limit headers from finalStep", async () => {
    makeTestEnv()
    generateTextMock.mockResolvedValueOnce({
      text: "ok",
      finalStep: {
        reasoningText: undefined,
        response: { headers: { "x-ratelimit-remaining-requests": "17" } },
      },
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    vi.resetModules()
    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")

    const { response } = await queryModel({ question: "hi", model: getModel("gpt-5-nano")! })

    expect(response.quota).toMatchObject({ remainingRequests: 17 })
  })

  it("keeps streamText rate-limit headers from finalStep", async () => {
    makeTestEnv()
    streamTextMock.mockReturnValueOnce({
      textStream: (async function* () {
        yield "ok"
      })(),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
      finalStep: Promise.resolve({ response: { headers: { "x-ratelimit-remaining-requests": "17" } } }),
    })
    vi.resetModules()
    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")

    const { response } = await queryModel({
      question: "hi",
      model: getModel("gpt-5-nano")!,
      stream: true,
      onToken: vi.fn(),
    })

    expect(response.quota).toMatchObject({ remainingRequests: 17 })
  })
})
