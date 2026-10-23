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
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: generateTextMock,
  streamText: streamTextMock,
}))

const nativeDeepMock = vi.hoisted(() =>
  vi.fn(async ({ model }) => ({ model, content: "native control", durationMs: 1 })),
)
vi.mock("../src/lib/openai-deep", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/openai-deep")>("../src/lib/openai-deep")),
  queryOpenAIDeepResearch: nativeDeepMock,
}))

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

  it("keeps SDK counts and estimates without inventing a total or stated charge", async () => {
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

    expect(response.usage).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      classes: { input: 100, output: 50 },
    })
    const cost = totalResponseCost([response])
    expect(cost.charged).toEqual({ reason: "charged unavailable for 1 of 1 invoked calls" })
    expect("usd" in cost.listEquivalent && cost.listEquivalent.usd).toBeCloseTo(0.0007)
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

// 30826: URL/title projection of the actual17-source Responses diagnostic; no prose scraping.
const researchSources = [
  {
    type: "source",
    sourceType: "url",
    id: "fixture-1",
    url: "https://cneos.jpl.nasa.gov/faq/new.html",
    title: "Frequently Asked Questions (FAQ) - Nasa CNEOS",
  },
  {
    type: "source",
    sourceType: "url",
    id: "fixture-2",
    url: "https://cneos.jpl.nasa.gov/glossary/NEO.html",
    title: "Glossary",
  },
] as const

it.each(["nonstream", "complete", "stream-error", "abort", "terminal-error", "source-free"] as const)(
  "Deep preserves normalized citations and honest terminal facts: %s",
  async (mode) => {
    makeTestEnv()
    vi.resetModules()
    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")
    const controller = new AbortController()
    const failure = new Error("fixture research aborted")
    const sources =
      mode === "source-free"
        ? []
        : [
            ...researchSources,
            {
              type: "source",
              sourceType: "document",
              id: "fixture-document",
              title: "Document control",
              mediaType: "text/plain",
            },
          ]
    const content = mode === "source-free" ? "retained research https://prose.example.invalid" : "retained research"
    const usage = { inputTokens: 10, outputTokens: 5 }
    generateTextMock.mockResolvedValueOnce({ text: content, sources, finalStep: { usage }, finishReason: "stop" })
    streamTextMock.mockImplementationOnce((options) => ({
      textStream: (async function* () {
        for (const source of sources) options.onChunk?.({ chunk: source })
        yield content
        if (mode === "stream-error") {
          options.onError({ error: failure })
          throw failure
        }
        if (mode === "abort") {
          controller.abort(failure)
          options.onAbort?.({ steps: [] })
          throw failure
        }
      })(),
      get finalStep() {
        return mode === "terminal-error" ? Promise.reject(failure) : Promise.resolve({ usage })
      },
      finishReason: Promise.resolve("stop"),
      rawFinishReason: Promise.resolve("stop"),
    }))
    const { response } = await queryModel({
      question: "NASA",
      model: getModel("perplexity/sonar-deep-research")!,
      stream: mode !== "nonstream",
      onToken: vi.fn(),
      abortSignal: controller.signal,
      observationStore: null,
    })
    expect(response.content).toBe(content)
    if (mode !== "source-free") {
      expect(response.citations).toEqual(researchSources.map(({ url, title }) => ({ url, title })))
    }
    if (["stream-error", "abort", "terminal-error", "source-free"].includes(mode)) expect(response.error).toBeTruthy()
    else {
      expect(response.error).toBeUndefined()
      expect(response.usage).toMatchObject({ promptTokens: 10, completionTokens: 5 })
    }
    if (["stream-error", "abort", "terminal-error"].includes(mode)) expect(response.usage).toBeUndefined()
    if (mode === "source-free") expect(response.error).toContain("citation completeness is unresolved")
    expect(response.cost_usd).toBeUndefined()
    expect(response.responseId).toBeUndefined()
  },
)

it.each([
  { providers: ["openrouter", "openai", "google", "perplexity"], model: "perplexity/sonar-deep-research" },
  { providers: ["openai", "google", "perplexity"], model: "gpt-5.4" },
  { providers: ["anthropic"], model: undefined },
])("Deep public defaults share curated selection and fallthrough: $providers", async ({ providers, model }) => {
  const env = makeTestEnv()
  vi.resetModules()
  const availability = await import("../src/lib/providers")
  vi.spyOn(availability, "isProviderAvailable").mockImplementation((provider) => providers.includes(provider))
  generateTextMock.mockResolvedValue({ text: "selected research", sources: researchSources, finalStep: { usage: {} } })
  const { research } = await import("../src/lib/research")
  const { runDeep } = await import("../src/cmd/deep")
  const response = await research("NASA")
  if (model) expect(response.model.modelId).toBe(model)
  else expect(response.model.provider).toBe("anthropic")
  await runDeep({
    topic: "NASA",
    modelOverride: undefined,
    buildContext: async () => undefined,
    outputFile: "/dev/null",
    sessionTag: "test",
    skipRecover: true,
    skipConfirm: true,
    dryRun: true,
    streamToken: () => {},
  })
  if (model) expect(env.stderr.join("\n")).toContain(`Model: ${model}`)
  else {
    expect(env.stderr.join("\n")).toContain("Provider: anthropic")
    expect(env.stderr.join("\n")).toContain("No curated Deep model available")
  }
})

it("Deep explicit override wins and missing routes remain explicit", async () => {
  const env = makeTestEnv()
  vi.resetModules()
  const availability = await import("../src/lib/providers")
  process.env.PERPLEXITY_API_KEY = "offline-perplexity-fixture"
  const available = vi.spyOn(availability, "isProviderAvailable").mockReturnValue(true)
  generateTextMock.mockResolvedValue({ text: "override", finalStep: { usage: {} } })
  const { research } = await import("../src/lib/research")
  expect((await research("NASA", { modelOverride: "sonar-deep-research" })).model.provider).toBe("perplexity")
  const { getModel } = await import("../src/lib/types")
  const { runDeep } = await import("../src/cmd/deep")
  await runDeep({
    topic: "NASA",
    modelOverride: getModel("sonar-deep-research"),
    buildContext: async () => undefined,
    outputFile: "/dev/null",
    sessionTag: "test",
    skipRecover: true,
    skipConfirm: true,
    dryRun: true,
    streamToken: () => {},
  })
  expect(env.stderr.join("\n")).toContain("Model: sonar-deep-research")
  available.mockReturnValue(false)
  await expect(research("NASA")).rejects.toThrow("No deep research or high-tier models available")
  await expect(
    runDeep({
      topic: "NASA",
      modelOverride: undefined,
      buildContext: async () => undefined,
      outputFile: "/dev/null",
      sessionTag: "test",
      skipRecover: true,
      skipConfirm: true,
      dryRun: true,
      streamToken: () => {},
    }),
  ).rejects.toThrow("__exit_1")
  expect(env.stdout.join("\n")).toContain('"status":"failed"')
})
