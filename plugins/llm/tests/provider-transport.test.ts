/**
 * @failure An AI SDK upgrade silently sends a provider to a different HTTP API.
 * @level l2 — real provider models with mocked HTTP, no billed request
 * @consumer bearly LLM callers using OpenRouter or xAI
 * @testonly none
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { makeTestEnv } from "./helpers"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe("provider transport across AI SDK upgrades", () => {
  // 30170 requires every invoked call, including SDK and context retries, in both totals.
  // Final-result mocks cannot reveal a failed HTTP attempt hidden by a successful retry.
  it.each([
    { kind: "SDK", status: 500, stream: false },
    { kind: "SDK", status: 500, stream: true },
    { kind: "context", status: 400, stream: false },
  ])("retains unknown earlier spending after $kind retry stream=$stream", async ({ kind, status, stream }) => {
    const env = makeTestEnv()
    vi.stubEnv("XDG_CACHE_HOME", env.tmpDir)
    vi.spyOn(console, "error").mockImplementation(() => {})
    const usage = { input_tokens: 100, output_tokens: 50, total_tokens: 150, cost: 0.125 }
    const responseBody = {
      id: "resp_retry_cost",
      created_at: 1,
      model: "moonshotai/kimi-k2.6",
      output: [
        {
          type: "message",
          id: "msg_retry_cost",
          role: "assistant",
          content: [{ type: "output_text", text: "answer", annotations: [] }],
        },
      ],
      usage,
    }
    const events = [
      { type: "response.created", response: { id: responseBody.id, created_at: 1, model: responseBody.model } },
      { type: "response.output_text.delta", item_id: "msg_retry_cost", output_index: 0, delta: "answer" },
      { type: "response.completed", response: { usage } },
    ]
    const message =
      kind === "context"
        ? "This endpoint's maximum context length is 262144 tokens. However, you requested about 262150 tokens (1000 of text input, 261150 in the output). Please reduce the length of either one."
        : "temporary provider failure"
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
          status,
          headers: { "content-type": "application/json", "retry-after-ms": "1" },
        }),
      )
      .mockImplementation(
        async () =>
          new Response(
            stream
              ? events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
              : JSON.stringify(responseBody),
            { headers: { "content-type": stream ? "text/event-stream" : "application/json" } },
          ),
      )
    vi.stubGlobal("fetch", fetchMock)
    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")
    const { resolveResponseCost } = await import("../src/lib/pricing")
    const { response } = await queryModel({
      question: "probe",
      model: getModel("moonshotai/kimi-k2.6")!,
      stream,
      onToken: vi.fn(),
    })
    expect(response.error).toBeUndefined()
    expect(response.content).toBe("answer")
    expect(response.usage?.raw).toEqual(usage)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(response.calls).toHaveLength(2)
    expect(response.calls?.[0]?.responseBody).toContain(message)
    expect(response.calls?.[1]?.usage?.raw).toEqual(usage)
    expect(response.usage?.promptTokens).toBeUndefined()
    expect(response.usage?.completionTokens).toBeUndefined()
    expect(response.usage?.totalTokens).toBeUndefined()
    const costs = resolveResponseCost(response)
    expect.soft(costs.charged).not.toHaveProperty("usd")
    expect.soft(costs.listEquivalent).not.toHaveProperty("usd")
    expect(costs.listEquivalentBasis).toEqual(
      expect.arrayContaining([expect.objectContaining({ matchedModelId: "moonshotai/kimi-k2.6" })]),
    )
    // Exercise the real result writer: adapter-only proof cannot catch dropped call metadata.
    const { finishResponse } = await import("../src/lib/format")
    const file = join(env.tmpDir, "retry-receipt.txt")
    await finishResponse(
      response.content,
      response.model,
      file,
      "retry-cost",
      response.usage,
      response.durationMs,
      "probe",
      response.responseId,
      undefined,
      response.error,
      undefined,
      response.servedBy,
      response,
    )
    const lines = env.stdout.filter((line) => line.trim().startsWith("{"))
    expect(lines).toHaveLength(1)
    const envelope = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(envelope.calls).toEqual(response.calls)
    expect(envelope).not.toHaveProperty("cost_usd")
    expect(envelope).not.toHaveProperty("list_equivalent_usd")
    const saved = readFileSync(file, "utf8").match(/^<!-- llm-meta: (.+) -->/)
    expect(saved).not.toBeNull()
    expect((JSON.parse(saved![1]!) as Record<string, unknown>).calls).toEqual(response.calls)
  })

  it("retains the last Ollama receipt when a later stream record is malformed", async () => {
    makeTestEnv()
    const raw = { done: false, prompt_eval_count: 7, eval_count: 3, cost_usd: 0, invoice: "before-stream-error" }
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ ...raw, message: { content: "partial answer" } }) + '\n{"broken"\n'),
      ),
    )
    const { ollamaChat } = await import("../src/lib/ollama")
    const response = await ollamaChat({ model: "local-fixture", question: "probe", stream: true })
    expect(response.error).toContain("stream")
    expect(response.content).toBe("partial answer")
    expect(response.usage?.raw).toEqual(raw)
    expect(response.cost_usd).toBe(0)
  })

  // Ollama reports independent counts, not an implicit normalized total.
  // Both transport modes must retain a reported zero and original usage facts.
  it.each(
    [
      { raw: {}, counts: {} },
      { raw: { prompt_eval_count: 7 }, counts: { promptTokens: 7 } },
      { raw: { eval_count: 3 }, counts: { completionTokens: 3 } },
      { raw: { prompt_eval_count: 0, eval_count: 0 }, counts: { promptTokens: 0, completionTokens: 0 } },
      { raw: { prompt_eval_count: 7, eval_count: 3 }, counts: { promptTokens: 7, completionTokens: 3 } },
    ].flatMap((item) => [false, true].map((stream) => ({ ...item, stream }))),
  )("keeps Ollama counts stream=$stream raw=$raw", async ({ raw, counts, stream }) => {
    makeTestEnv()
    const facts = { done: true, ...raw, invoice: "ollama-original", cost_usd: 0 }
    const body = { ...facts, message: { content: "answer" } }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body) + (stream ? "\n" : "")))
    vi.stubGlobal("fetch", fetchMock)
    const { ollamaChat } = await import("../src/lib/ollama")
    const response = await ollamaChat({ model: "local-fixture", question: "probe", stream })
    expect(response.error).toBeUndefined()
    expect(response.content).toBe("answer")
    expect(JSON.parse(JSON.stringify(response.usage))).toEqual({ ...counts, raw: facts })
    expect(response.cost_usd).toBe(0)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  // 30170: the Interactions API reports optional usage/steps. SDK-only fixtures
  // cannot detect REST field mismatches or a completed partial with no saved text.
  it.each([
    {
      name: "complete",
      usage: {
        total_input_tokens: 20,
        total_cached_tokens: 0,
        total_output_tokens: 1000,
        total_thought_tokens: 500,
        total_tokens: 1520,
      },
      counts: { promptTokens: 20, completionTokens: 1500, totalTokens: 1520 },
      priced: true,
    },
    { name: "raw only", usage: {}, counts: {}, priced: false },
    {
      name: "input only",
      usage: { total_input_tokens: 20, total_cached_tokens: 0 },
      counts: { promptTokens: 20 },
      priced: false,
    },
    {
      name: "output only",
      usage: { total_output_tokens: 1000, total_thought_tokens: 500 },
      counts: { completionTokens: 1500 },
      priced: false,
    },
    {
      name: "missing thought count",
      usage: { total_input_tokens: 20, total_cached_tokens: 0, total_output_tokens: 1000 },
      counts: { promptTokens: 20 },
      priced: false,
    },
    {
      name: "missing cache count",
      usage: { total_input_tokens: 20, total_output_tokens: 1000, total_thought_tokens: 500 },
      counts: { promptTokens: 20, completionTokens: 1500 },
      priced: false,
    },
    {
      name: "unsupported tool usage",
      usage: {
        total_input_tokens: 20,
        total_cached_tokens: 0,
        total_output_tokens: 1000,
        total_thought_tokens: 500,
        total_tool_use_tokens: 4,
      },
      counts: { promptTokens: 20, completionTokens: 1500 },
      priced: false,
    },
    {
      name: "unsupported image usage",
      usage: {
        total_input_tokens: 20,
        total_cached_tokens: 0,
        total_output_tokens: 1000,
        total_thought_tokens: 500,
        input_tokens_by_modality: [{ modality: "image", tokens: 4 }],
      },
      counts: { promptTokens: 20, completionTokens: 1500 },
      priced: false,
    },
  ])("retains Gemini $name facts through HTTP, saved partial and recovery", async ({ usage, counts, priced }) => {
    const env = makeTestEnv()
    vi.resetModules()
    const raw = { ...usage, cost_usd: 0, invoice: "gemini-original" }
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "gemini_receipt",
            status: "completed",
            usage: raw,
            steps: [
              { type: "model_output", content: [{ type: "text", text: "draft" }] },
              { type: "model_output", content: [{ type: "text", text: "final report" }] },
            ],
          }),
        ),
    )
    vi.stubGlobal("fetch", fetchMock)
    const { queryGeminiDeepResearch } = await import("../src/lib/gemini-deep")
    const { getModel } = await import("../src/lib/types")
    const response = await queryGeminiDeepResearch({
      topic: "probe",
      model: getModel("deep-research-pro-preview-12-2025")!,
    })
    expect(response.error).toBeUndefined()
    expect(response.content).toBe("final report")
    expect(response.cost_usd).toBe(0)
    expect(response.usage?.raw).toEqual(raw)
    const { classes, raw: _raw, ...actualCounts } = response.usage!
    expect(actualCounts).toEqual(counts)
    const { resolveResponseCost } = await import("../src/lib/pricing")
    const cost = resolveResponseCost(response)
    expect(cost.charged).toEqual({ usd: 0 })
    expect(cost.listEquivalent).toHaveProperty(priced ? "usd" : "reason")
    if (priced) expect(classes).toEqual({ input: 20, cache_read: 0, output: 1500, reasoning: 500 })
    const { findPartialByResponseId } = await import("../src/lib/persistence")
    const partial = findPartialByResponseId("gemini_receipt")
    expect(partial?.metadata.usage).toEqual(response.usage)
    expect(partial?.metadata.cost_usd).toBe(0)
    expect(partial?.content.trim()).toBe("final report")
    const { runRecover } = await import("../src/cmd/recover")
    await runRecover({ responseId: "gemini_receipt", clean: false, cleanStale: false, includeAll: false })
    const envelope = JSON.parse(env.stdout.filter((line) => line.trim().startsWith("{")).at(-1)!)
    expect(envelope).toHaveProperty("usage", response.usage)
    expect(envelope).toHaveProperty("cost_usd", 0)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  // Terminal provider outcomes and local interruption are different, but neither
  // may erase the last real receipt or turn poll observations into extra requests.
  it.each(["failed", "cancelled", "expired", "aborted", "timeout", "http-error"])(
    "retains the latest Gemini receipt after %s",
    async (outcome) => {
      makeTestEnv()
      vi.resetModules()
      const controller = new AbortController()
      const raw = { total_input_tokens: 7, invoice: outcome, cost_usd: 0 }
      const fetchMock = vi.fn(async () => {
        if (outcome === "aborted") controller.abort("operator-interrupt")
        return new Response(
          JSON.stringify({
            id: "gemini_poll",
            status: ["failed", "cancelled", "expired"].includes(outcome) ? outcome : "in_progress",
            usage: raw,
            error: outcome === "http-error" ? { message: "upstream failed" } : undefined,
          }),
          { status: outcome === "http-error" ? 400 : 200 },
        )
      })
      vi.stubGlobal("fetch", fetchMock)
      const { pollForGeminiCompletion } = await import("../src/lib/gemini-deep")
      const result = await pollForGeminiCompletion("gemini_poll", {
        intervalMs: 0,
        maxAttempts: 1,
        abortSignal: controller.signal,
      })
      expect(result.status).toBe(outcome === "http-error" ? "error" : outcome)
      expect(result).toHaveProperty("usage.raw", raw)
      expect(result).toHaveProperty("cost_usd", 0)
      expect(result.error).toEqual(expect.any(String))
      expect(fetchMock).toHaveBeenCalledOnce()
    },
  )

  it.each([200, 400])("retains initial Gemini failure facts on HTTP %s without a poll", async (status) => {
    makeTestEnv()
    vi.resetModules()
    const raw = { invoice: "failed-create", cost_usd: 0 }
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "gemini_failed_create",
            status: "failed",
            usage: raw,
            error: { message: "provider stopped" },
          }),
          { status },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)
    const { queryGeminiDeepResearch } = await import("../src/lib/gemini-deep")
    const { getModel } = await import("../src/lib/types")
    const response = await queryGeminiDeepResearch({
      topic: "probe",
      model: getModel("deep-research-pro-preview-12-2025")!,
    })
    expect(response.error).toContain("provider stopped")
    expect(response).toHaveProperty("usage.raw", raw)
    expect(response.cost_usd).toBe(0)
    expect(fetchMock).toHaveBeenCalledOnce()
    const { findPartialByResponseId } = await import("../src/lib/persistence")
    const saved = findPartialByResponseId("gemini_failed_create")
    expect(saved?.metadata.usage?.raw).toEqual(raw)
    expect(saved?.metadata.cost_usd).toBe(0)
    expect(saved?.metadata.completedAt).toBeUndefined()
  })

  it.each(["completed", "failed", "aborted"])(
    "keeps the latest %s Gemini poll in the actual query and saved receipt",
    async (outcome) => {
      makeTestEnv()
      vi.resetModules()
      const controller = new AbortController()
      const raw = { total_input_tokens: 7, invoice: "latest-poll", cost_usd: 0 }
      const fetchMock = vi.fn(async (_url, init?: RequestInit) => {
        if (init?.method === "POST") {
          return new Response(
            JSON.stringify({
              id: "gemini_lifecycle",
              status: "in_progress",
              usage: { cost_usd: 0.25, invoice: "initial-create" },
            }),
          )
        }
        if (outcome === "aborted") controller.abort("operator-interrupt")
        return new Response(
          JSON.stringify({
            id: "gemini_lifecycle",
            status: outcome === "aborted" ? "in_progress" : outcome,
            usage: raw,
            steps: [{ type: "model_output", content: [{ type: "text", text: "latest text" }] }],
            error: outcome === "failed" ? { message: "provider stopped" } : undefined,
          }),
        )
      })
      vi.stubGlobal("fetch", fetchMock)
      const { queryGeminiDeepResearch } = await import("../src/lib/gemini-deep")
      const { getModel } = await import("../src/lib/types")
      const response = await queryGeminiDeepResearch({
        topic: "probe",
        model: getModel("deep-research-pro-preview-12-2025")!,
        abortSignal: controller.signal,
      })
      expect(response.usage?.raw).toEqual(raw)
      expect(response.cost_usd).toBe(0)
      expect(response.content).toBe("latest text")
      if (outcome === "completed") expect(response.error).toBeUndefined()
      else expect(response.error).toEqual(expect.any(String))
      const { findPartialByResponseId } = await import("../src/lib/persistence")
      const saved = findPartialByResponseId("gemini_lifecycle")
      expect(saved?.metadata.usage?.raw).toEqual(raw)
      expect(saved?.metadata.cost_usd).toBe(0)
      if (outcome === "completed") {
        expect(saved?.metadata.completedAt).toEqual(expect.any(String))
        expect(saved?.content.trim()).toBe("latest text")
      } else expect(saved?.metadata.completedAt).toBeUndefined()
      expect(fetchMock).toHaveBeenCalledTimes(2)
    },
  )

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
