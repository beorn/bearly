/**
 * @failure An AI SDK upgrade silently sends a provider to a different HTTP API.
 * @level l2 — real provider models with mocked HTTP, no billed request
 * @consumer bearly LLM callers using OpenRouter or xAI
 * @testonly none
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { makeTestEnv } from "./helpers"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe("provider transport across AI SDK upgrades", () => {
  // 30170: the actual pinned Responses adapter must retain raw stated amounts and disjoint usage.
  // Mocked ai.generateText results cannot expose schema stripping or aggregate-usage raw loss.
  it.each([
    [false, "moonshotai/kimi-k2.6", { cost: 0.125, upstream_inference_cost: 9 }, 0.125],
    [true, "moonshotai/kimi-k2.6", { cost: 0 }, 0],
    [false, "gpt-5-nano", { cost_usd: 0.25, cost: 9 }, 0.25],
    [true, "gpt-5-nano", { cost_usd: 0.25 }, 0.25],
    [false, "gpt-5-nano", { cost: 9 }, undefined],
    [true, "moonshotai/kimi-k2.6", { cost: -1, upstream_inference_cost: 9 }, undefined],
  ] as const)("retains Responses facts stream=%s model=%s extras=%j", async (stream, modelId, extras, charged) => {
    const env = makeTestEnv()
    vi.stubEnv("XDG_CACHE_HOME", env.tmpDir)
    const usage = {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
      output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 30 },
      total_tokens: 150,
      ...extras,
    }
    const responseBody = {
      id: "resp_cost_contract",
      created_at: 1,
      model: modelId,
      output: [
        {
          type: "message",
          id: "msg_cost_contract",
          role: "assistant",
          content: [{ type: "output_text", text: "answer", annotations: [] }],
        },
      ],
      usage,
    }
    const events = [
      { type: "response.created", response: { id: responseBody.id, created_at: 1, model: modelId } },
      { type: "response.output_text.delta", item_id: "msg_cost_contract", output_index: 0, delta: "answer" },
      { type: "response.completed", response: { usage } },
    ]
    const fetchMock = vi.fn(
      async () =>
        new Response(
          stream ? events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") : JSON.stringify(responseBody),
          { headers: { "content-type": stream ? "text/event-stream" : "application/json" } },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)
    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")
    const model = getModel(modelId)
    if (!model) throw new Error(`required registry model ${modelId} is missing`)
    const { response } = await queryModel({ question: "probe", model, stream, onToken: vi.fn() })
    expect(response.error).toBeUndefined()
    expect(response.content).toBe("answer")
    expect(response.usage?.classes).toEqual({ input: 70, output: 50, cache_read: 20, cache_write: 10, reasoning: 30 })
    expect(response.usage?.raw).toEqual(usage)
    if (charged === undefined) expect(response).not.toHaveProperty("cost_usd")
    else expect(response.cost_usd).toBe(charged)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([
    ["moonshotai/kimi-k2.6", "OPENROUTER_API_KEY", "/api/v1/responses"],
    ["grok-4", "XAI_API_KEY", "/v1/chat/completions"],
  ])("%s sends to %s endpoint %s", async (modelId, keyName, pathname) => {
    vi.stubEnv("LLM_NO_ENV_AUTOLOAD", "1")
    vi.stubEnv(keyName, "test-only-key")
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(JSON.stringify({ error: { message: "probe rejection", type: "invalid_request_error" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const { generateText } = await import("ai")
    const { getLanguageModel } = await import("../src/lib/providers")
    const { getModel } = await import("../src/lib/types")
    const model = getModel(modelId)
    expect(model).toBeDefined()

    await expect(generateText({ model: getLanguageModel(model!), prompt: "probe", maxRetries: 0 })).rejects.toThrow(
      "probe rejection",
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const input = fetchMock.mock.calls[0]![0]
    const url = input instanceof Request ? input.url : String(input)
    expect(new URL(url).pathname).toBe(pathname)
  })

  /**
   * @failure A library bound disappears when the model has no declared output ceiling.
   * @consumer Library callers constraining a provider's reservation without reasoning metadata.
   * CLI budget coverage uses a model with declared limits; assert this distinct case on real HTTP mapping.
   */
  it("preserves caller budget, Grok chat reasoning, billed usage, and rate-limit headers", async () => {
    const env = makeTestEnv()
    vi.stubEnv("LLM_NO_ENV_AUTOLOAD", "1")
    vi.stubEnv("XAI_API_KEY", "test-only-key")
    vi.stubEnv("XDG_CACHE_HOME", env.tmpDir)
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 1,
            model: "grok-4-1-fast-reasoning",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "answer", reasoning_content: "thinking" },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 5,
              prompt_tokens_details: { cached_tokens: 2 },
              completion_tokens_details: { reasoning_tokens: 7 },
            },
          }),
          {
            headers: {
              "content-type": "application/json",
              "x-ratelimit-remaining-requests": "9",
              "x-ratelimit-limit-requests": "10",
            },
          },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")
    const model = { ...getModel("grok-4-1-fast-reasoning")!, reasoning: undefined }
    const options = { question: "probe", model, maxOutputTokens: 4096 }
    const { response } = await queryModel(options)

    expect(response.error).toBeUndefined()
    expect(response).toMatchObject({
      content: "answer",
      reasoning: "thinking",
      usage: { promptTokens: 20, completionTokens: 12, totalTokens: 32 },
      quota: { remainingRequests: 9, requestsPerWindow: 10 },
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    const input = fetchMock.mock.calls[0]![0]
    const url = input instanceof Request ? input.url : String(input)
    expect(new URL(url).pathname).toBe("/v1/chat/completions")
    const init = fetchMock.mock.calls[0]![1]
    expect(JSON.parse(String(init?.body))).toMatchObject({ max_tokens: 4096 })
    const { totalResponseCost } = await import("../src/lib/format")
    const cost = totalResponseCost([response])
    expect(cost.charged).toEqual({ reason: "charged unavailable for 1 of 1 invoked calls" })
    expect(cost.listEquivalent).toEqual({ usd: expect.closeTo((20 * 0.2 + 12 * 0.5) / 1_000_000, 12) })
    expect(cost.listEquivalentBasis).toEqual([{ rateSource: "sku", matchedModelId: "grok-4-1-fast-reasoning" }])
  })

  // Native HTTP adapters have independent serialization/refusal risks from AI SDK transports.
  it.each([
    [4096, 4096],
    [100000, 65536],
    [undefined, undefined],
  ])("maps Ollama explicit bound %s without inventing an unbounded default", async (maxOutputTokens, expected) => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ message: { content: "answer" } }), {
          headers: { "content-type": "application/json" },
        }),
    )
    vi.stubGlobal("fetch", fetchMock)
    const { ollamaChat } = await import("../src/lib/ollama")
    const response = await ollamaChat({ model: "local-test", question: "probe", stream: false, maxOutputTokens })
    expect(response.content).toBe("answer")
    expect(fetchMock).toHaveBeenCalledOnce()
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as {
      options?: { num_predict: number }
    }
    if (maxOutputTokens === undefined) expect(body).not.toHaveProperty("options")
    else expect(body.options?.num_predict).toBe(expected)
  })

  it.each([0, 1.5, Number.NaN])("refuses invalid bound %s before native HTTP dispatch", async (maxOutputTokens) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const { ollamaChat } = await import("../src/lib/ollama")
    const { queryGeminiDeepResearch } = await import("../src/lib/gemini-deep")
    const { getModel } = await import("../src/lib/types")
    const responses = [
      await ollamaChat({ model: "local-test", question: "probe", maxOutputTokens }),
      await queryGeminiDeepResearch({
        topic: "probe",
        model: getModel("deep-research-pro-preview-12-2025")!,
        maxOutputTokens,
      }),
    ]
    for (const response of responses) expect(response.error).toContain("positive safe integer")
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("bearly:llm:gemini"),
      expect.stringContaining("positive safe integer"),
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("refuses a Gemini agent bound that the API cannot honor before spending", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const { queryGeminiDeepResearch } = await import("../src/lib/gemini-deep")
    const { getModel } = await import("../src/lib/types")
    const response = await queryGeminiDeepResearch({
      topic: "probe",
      model: getModel("deep-research-pro-preview-12-2025")!,
      maxOutputTokens: 4096,
    })
    expect(response.error).toContain("deep-research-pro-preview-12-2025")
    expect(response.error).toContain("4096")
    expect(response.error).toContain("cannot honor")
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("bearly:llm:gemini"),
      expect.stringContaining("cannot honor maxOutputTokens=4096"),
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("requests xAI usage for streams and preserves its billed totals", async () => {
    const env = makeTestEnv()
    vi.stubEnv("LLM_NO_ENV_AUTOLOAD", "1")
    vi.stubEnv("XAI_API_KEY", "test-only-key")
    vi.stubEnv("XDG_CACHE_HOME", env.tmpDir)
    const events = [
      {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 1,
        model: "grok-4-1-fast-reasoning",
        choices: [{ index: 0, delta: { role: "assistant", content: "answer" }, finish_reason: null }],
      },
      {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 1,
        model: "grok-4-1-fast-reasoning",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
      {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 1,
        model: "grok-4-1-fast-reasoning",
        choices: [],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 5,
          completion_tokens_details: { reasoning_tokens: 7 },
        },
      },
    ]
    const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Response(body, { headers: { "content-type": "text/event-stream" } }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")
    const { response } = await queryModel({
      question: "probe",
      model: getModel("grok-4-1-fast-reasoning")!,
      stream: true,
      onToken: vi.fn(),
    })

    expect(response.error).toBeUndefined()
    expect(response).toMatchObject({
      content: "answer",
      usage: { promptTokens: 20, completionTokens: 12, totalTokens: 32 },
    })
    const init = fetchMock.mock.calls[0]![1]
    expect(JSON.parse(String(init?.body))).toMatchObject({ stream_options: { include_usage: true } })
  })
})
