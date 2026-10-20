/**
 * Regression: standard `llm pro` calls must be recoverable via responseId,
 * matching the `--deep` path. Introduced by km-infra.llm-fire-and-forget-pro
 * after the removal of the dual-pro wall-clock timeout — a 30+ min Pro call
 * should survive SIGINT / wall-clock / network hiccup and be recoverable
 * later via `bun llm recover <id>`.
 *
 * The contract under test:
 *   1. queryOpenAIBackground persists a partial (with responseId) BEFORE
 *      polling, so process death after create doesn't lose the work.
 *   2. In the happy path (background completes during poll), content is
 *      returned inline and the partial is cleaned up.
 *   3. In fire-and-forget mode, the function returns { content: "", responseId }
 *      immediately — caller is expected to surface the ID.
 *   4. A pro-mode responseId can be recovered via pollResponseToCompletion
 *      (the recover/await code path) — falls through to OpenAI's retrieve
 *      because the model isn't Gemini.
 *
 * All OpenAI API calls are intercepted at the `openai` package boundary so
 * no real network hits happen.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs"
import { makeTestEnv } from "./helpers"

// Intercept the OpenAI SDK — queryOpenAIBackground uses `openai.responses.create`
// and `openai.responses.retrieve` via the memoized client. Replacing the
// constructor lets us assert exact call sequences without a live API.
const responsesCreateMock = vi.fn()
const responsesRetrieveMock = vi.fn()

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      responses = {
        create: responsesCreateMock,
        retrieve: responsesRetrieveMock,
      }
    },
  }
})

beforeEach(() => {
  responsesCreateMock.mockReset()
  responsesRetrieveMock.mockReset()
})

describe("queryOpenAIBackground — persistence and recovery", () => {
  // REST receipts may omit counts even though the SDK's static response type
  // requires them. Complete fixtures miss synthetic totals and NaN classes.
  it.each([
    { raw: {}, counts: {}, classes: {} },
    { raw: { input_tokens: 7 }, counts: { promptTokens: 7 }, classes: { input: 7 } },
    { raw: { output_tokens: 3 }, counts: { completionTokens: 3 }, classes: { output: 3 } },
    {
      raw: { input_tokens: 7, output_tokens: 3 },
      counts: { promptTokens: 7, completionTokens: 3 },
      classes: { input: 7, output: 3 },
    },
    {
      raw: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      counts: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      classes: { input: 0, output: 0 },
    },
  ])("preserves reported REST counts without filling gaps: $raw", async ({ raw, counts, classes }) => {
    makeTestEnv()
    vi.resetModules()
    const original = { ...raw, cost_usd: 0, invoice: "partial-rest" }
    const originalResponse = {
      id: "resp_partial_counts",
      status: "completed",
      usage: original,
      output: [{ type: "message", content: [{ type: "output_text", text: "original answer" }] }],
    }
    responsesCreateMock.mockResolvedValue(originalResponse)
    responsesRetrieveMock.mockResolvedValue(originalResponse)
    const { queryOpenAIBackground } = await import("../src/lib/openai-deep")
    const { getModel } = await import("../src/lib/types")
    const model = getModel("gpt-5.4-pro")
    if (!model) throw new Error("required gpt-5.4-pro fixture model absent")
    const response = await queryOpenAIBackground({ prompt: "probe", model })
    expect(response.error).toBeUndefined()
    expect(response.cost_usd).toBe(0)
    expect(JSON.parse(JSON.stringify(response.usage))).toEqual({ ...counts, classes, raw: original })
    const { findPartialByResponseId } = await import("../src/lib/persistence")
    expect(findPartialByResponseId("resp_partial_counts")?.metadata.usage).toEqual(response.usage)
  })
  // A failed disk write must not erase the paid response already accepted
  // from the provider. Normal successful persistence never exercises this.
  it.each([
    "background-initial",
    "deep-initial",
    "background-poll",
    "deep-poll",
    "background-missing",
    "deep-missing",
    "background-header",
    "deep-header",
  ])("retains the original response when %s persistence fails", async (route) => {
    makeTestEnv()
    vi.resetModules()
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000)
    const responseId = `resp_disk_${route}`
    const p = await import("../src/lib/persistence")
    const path = p.getPartialPath(responseId)
    const initialFailure = route.endsWith("initial")
    if (initialFailure) mkdirSync(path)
    const raw = { input_tokens: 7, output_tokens: 3, cost_usd: 0, invoice: route }
    const paid = {
      id: responseId,
      status: "completed",
      usage: raw,
      output: [{ type: "message", content: [{ type: "output_text", text: "paid original" }] }],
    }
    responsesCreateMock.mockResolvedValue(initialFailure ? paid : { id: responseId })
    responsesRetrieveMock.mockImplementation(async () => {
      renameSync(path, `${path}.retained`)
      if (route.endsWith("header")) writeFileSync(path, "original partial with damaged metadata")
      else if (!route.endsWith("missing")) mkdirSync(path)
      return paid
    })
    const api = await import("../src/lib/openai-deep")
    const model = (await import("../src/lib/types")).getModel("gpt-5.4-pro")!
    const result = route.startsWith("background")
      ? await api.queryOpenAIBackground({ model, prompt: "question" })
      : await api.queryOpenAIDeepResearch({ model, topic: "question", background: true })
    expect(result).toMatchObject({ responseId, content: "paid original", cost_usd: 0, usage: { raw } })
    expect(result.error).toContain(path)
    if (route.endsWith("header")) {
      expect(readFileSync(path, "utf8")).toBe("original partial with damaged metadata")
    }
    if (route.endsWith("missing")) expect(existsSync(path)).toBe(false)
    expect(responsesCreateMock).toHaveBeenCalledTimes(1)
    expect(responsesRetrieveMock).toHaveBeenCalledTimes(initialFailure ? 0 : 1)
  })

  // Poll observations belong to the original request; a local stop or failed
  // retrieval cannot erase its last available receipt or create a new bill.
  it.each(["aborted", "timeout", "error"])("keeps last poll facts on %s", async (status) => {
    makeTestEnv()
    vi.resetModules()
    const raw = { input_tokens: 7, output_tokens: 3, cost_usd: 0, invoice: "last-poll" }
    responsesRetrieveMock.mockResolvedValueOnce({
      status: "in_progress",
      usage: raw,
      output: [{ type: "message", content: [{ type: "output_text", text: "pending original" }] }],
    })
    if (status === "error") responsesRetrieveMock.mockRejectedValueOnce(new Error("retrieval failed"))
    const ac = new AbortController()
    const { pollForCompletion } = await import("../src/lib/openai-deep")
    const result = await pollForCompletion("resp_last_receipt", {
      intervalMs: 0,
      maxAttempts: status === "timeout" ? 1 : 2,
      abortSignal: ac.signal,
      onProgress: () => {
        if (status === "aborted") ac.abort("local stop")
      },
    })
    expect(result).toMatchObject({ status, content: "pending original", cost_usd: 0, usage: { raw } })
    expect(responsesRetrieveMock).toHaveBeenCalledTimes(status === "error" ? 2 : 1)
  })

  it.each(["background", "deep"])("retains the initial create receipt if %s polling aborts", async (route) => {
    makeTestEnv()
    vi.resetModules()
    const raw = { input_tokens: 7, output_tokens: 3, cost_usd: 0, invoice: "initial-create" }
    responsesCreateMock.mockResolvedValue({ id: "resp_initial_receipt", status: "queued", usage: raw })
    const ac = new AbortController()
    ac.abort("local stop")
    const api = await import("../src/lib/openai-deep")
    const model = (await import("../src/lib/types")).getModel("gpt-5.4-pro")!
    const result =
      route === "background"
        ? await api.queryOpenAIBackground({ model, prompt: "question", abortSignal: ac.signal })
        : await api.queryOpenAIDeepResearch({ model, topic: "question", background: true, abortSignal: ac.signal })
    expect(result).toMatchObject({ cost_usd: 0, usage: { raw } })
    expect(result.error).toContain("aborted")
    expect(responsesRetrieveMock).not.toHaveBeenCalled()
    const partial = (await import("../src/lib/persistence")).findPartialByResponseId("resp_initial_receipt")
    expect(partial?.metadata.usage?.raw).toEqual(raw)
    expect(partial?.metadata.cost_usd).toBe(0)
  })

  it.each(["background", "deep-sync", "deep-poll", "background-fire-and-forget", "deep-fire-and-forget"])(
    "preserves a terminal output-token stop through %s and await",
    async (route) => {
      const env = makeTestEnv()
      const responseId = `resp_token_stop_${route}`
      const terminal = {
        id: responseId,
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        max_output_tokens: 4096,
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "partial answer" }],
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 3 },
          total_tokens: 15,
          cost_usd: 0,
          invoice: "original-terminal",
        },
      }
      const fireAndForget = route.endsWith("fire-and-forget")
      responsesCreateMock.mockResolvedValue(route === "deep-sync" || fireAndForget ? terminal : { id: responseId })
      responsesRetrieveMock.mockResolvedValue(terminal)
      vi.resetModules()
      const api = await import("../src/lib/openai-deep")
      const model = (await import("../src/lib/types")).getModel("gpt-5.4-pro")!
      const result = route.startsWith("background")
        ? await api.queryOpenAIBackground({
            prompt: "question",
            model,
            topic: "partial",
            maxOutputTokens: 4096,
            fireAndForget,
          })
        : await api.queryOpenAIDeepResearch({
            topic: "question",
            model,
            background: route !== "deep-sync",
            maxOutputTokens: 4096,
            fireAndForget,
          })
      expect(result).toMatchObject({
        content: "partial answer",
        finishReason: "length",
        rawFinishReason: "max_output_tokens",
        appliedMaxOutputTokens: 4096,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })
      expect(result.error).toBeUndefined()
      expect(result.cost_usd).toBe(0)
      expect(result.usage?.raw).toEqual(terminal.usage)
      expect(result.usage?.classes).toEqual({
        input: 8,
        output: 5,
        cache_read: 2,
        reasoning: 3,
      })
      expect(responsesRetrieveMock).toHaveBeenCalledTimes(route === "deep-sync" || fireAndForget ? 0 : 1)
      const { findPartialByResponseId } = await import("../src/lib/persistence")
      const partial = findPartialByResponseId(responseId)
      if (route !== "deep-sync") {
        expect(partial?.content).toContain("partial answer")
        expect(partial?.metadata.completedAt).toBeUndefined()
        expect(partial?.metadata.usage?.raw).toEqual(terminal.usage)
        expect(partial?.metadata.cost_usd).toBe(0)
      }
      const { runAwait, runRecover } = await import("../src/cmd/recover")
      await expect(runAwait({ responseId })).rejects.toThrow("__exit_1")
      const envelope = JSON.parse(env.stdout.filter((line) => line.startsWith("{")).at(-1)!)
      expect(envelope).toMatchObject({
        status: "incomplete",
        cost_usd: 0,
        usage: { raw: terminal.usage },
        rawFinishReason: "max_output_tokens",
        chars: "partial answer".length,
      })
      expect(findPartialByResponseId(responseId)?.metadata.completedAt).toBeUndefined()
      await expect(
        runRecover({
          responseId,
          clean: false,
          cleanStale: false,
          includeAll: false,
        }),
      ).rejects.toThrow("__exit_1")
      const recovered = JSON.parse(env.stdout.filter((line) => line.startsWith("{")).at(-1)!)
      expect(recovered).toMatchObject({
        status: "incomplete",
        cost_usd: 0,
        usage: { raw: terminal.usage },
        rawFinishReason: "max_output_tokens",
        chars: "partial answer".length,
      })
      if (route === "deep-fire-and-forget") {
        const retrievesBeforeDeep = responsesRetrieveMock.mock.calls.length
        const { runDeep } = await import("../src/cmd/deep")
        await expect(
          runDeep({
            topic: "question",
            modelOverride: (await import("../src/lib/types")).getModel("o3-deep-research-2025-06-26"),
            streamToken: () => {},
            buildContext: async () => undefined,
            outputFile: `${env.tmpDir}/initial-deep.md`,
            sessionTag: "initial-deep",
            skipRecover: true,
            skipConfirm: true,
            maxOutputTokens: 4096,
            dryRun: false,
          }),
        ).rejects.toThrow("__exit_1")
        const deep = JSON.parse(env.stdout.filter((line) => line.startsWith("{")).at(-1)!)
        expect(deep).toMatchObject({
          status: "incomplete",
          rawFinishReason: "max_output_tokens",
          chars: "partial answer".length,
        })
        expect(responsesRetrieveMock).toHaveBeenCalledTimes(retrievesBeforeDeep)
      }
    },
  )

  it("persists a partial before polling, returns content on completion", async () => {
    const env = makeTestEnv()
    const responseId = "resp_pro_happy_1"

    responsesCreateMock.mockResolvedValueOnce({ id: responseId })
    responsesRetrieveMock.mockResolvedValueOnce({
      id: responseId,
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "hello from pro" }],
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cost_usd: 0,
        invoice: "saved-original",
      },
    })

    vi.resetModules()
    const { queryOpenAIBackground } = await import("../src/lib/openai-deep")
    const { getModel } = await import("../src/lib/types")
    const gptPro = getModel("gpt-5.4-pro")!

    const result = await queryOpenAIBackground({
      prompt: "say hi",
      model: gptPro,
      topic: "greeting",
      maxOutputTokens: 4096,
    })

    expect(result.responseId).toBe(responseId)
    expect(result.content).toBe("hello from pro")
    // Happy path KEEPS the partial on disk as a recovery cache — the caller
    // (dual-pro / ask) may be SIGKILLed between leg-completion and final
    // output write, and the OpenAI response object can re-enter `queued`,
    // making fresh API recovery impossible. The on-disk partial is the only
    // durable record. cleanupPartials(24h) ages out completed entries.
    const { findPartialByResponseId } = await import("../src/lib/persistence")
    const cachedPartial = findPartialByResponseId(responseId)
    expect(cachedPartial).not.toBeNull()
    expect(cachedPartial!.content).toContain("hello from pro")
    expect(cachedPartial!.metadata.completedAt).toBeDefined()
    expect(cachedPartial!.metadata.usage?.totalTokens).toBeUndefined()
    expect(cachedPartial!.metadata.usage?.raw).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cost_usd: 0,
      invoice: "saved-original",
    })
    expect(cachedPartial!.metadata.cost_usd).toBe(0)
    expect(responsesCreateMock).toHaveBeenCalledTimes(1)
    // create() must have requested background mode — that's the whole reason
    // we're on this path. Without it the ID isn't captured before polling and
    // a mid-call crash loses the work.
    const createArgs = responsesCreateMock.mock.calls[0]![0]
    expect(createArgs.background).toBe(true)
    expect(createArgs.max_output_tokens).toBe(4096)
    // The string sent to OpenAI is resolved via the endpoint's apiModelId —
    // our internal SKU "gpt-5.4-pro" maps to OpenAI's API ID "gpt-5-pro".
    // (See PROVIDER_ENDPOINTS in types.ts.)
    expect(createArgs.model).toBe("gpt-5-pro")
    // Responses-API background path should NOT inject the web_search_preview
    // tool — that's for deep research only. Standard pro is a plain completion.
    expect(createArgs.tools).toBeUndefined()
    // Recover the actual producer's saved receipt, without a fresh provider call.
    const { runRecover } = await import("../src/cmd/recover")
    await runRecover({
      responseId,
      clean: false,
      cleanStale: false,
      includeAll: false,
    })
    const recovered = JSON.parse(env.stdout.filter((line) => line.startsWith("{")).at(-1)!)
    expect(recovered).toHaveProperty("cost_usd", 0)
    expect(recovered).toHaveProperty("usage", cachedPartial!.metadata.usage)
    expect(responsesRetrieveMock).toHaveBeenCalledTimes(1)
  })

  // Dedicated deep research adds a wrapper that consumes the same context budget as the topic.
  it.each([false, true])("budgets the actual deep prompt for background=%s", async (background) => {
    makeTestEnv()
    responsesCreateMock.mockResolvedValueOnce({
      id: "resp_deep_bound",
      output: [],
    })
    vi.resetModules()
    const { queryOpenAIDeepResearch } = await import("../src/lib/openai-deep")
    const { getModel } = await import("../src/lib/types")
    const model = {
      ...getModel("o3-deep-research-2025-06-26")!,
      reasoning: { contextWindow: 5000, maxOutputTokens: 4000 },
    }
    await queryOpenAIDeepResearch({
      topic: "probe",
      model,
      background,
      fireAndForget: true,
      noPersist: true,
      maxOutputTokens: 3000,
    })
    const args = responsesCreateMock.mock.calls[0]![0]
    // Literal independent budget: context less actual serialized prompt estimate and safety margin.
    expect(args.max_output_tokens).toBe(5000 - Math.ceil(args.input.length / 3.5) - 4096)
  })

  it.each([0, 1.5, Number.NaN])("refuses invalid native bound %s before OpenAI dispatch", async (maxOutputTokens) => {
    makeTestEnv()
    vi.resetModules()
    const { queryOpenAIBackground, queryOpenAIDeepResearch } = await import("../src/lib/openai-deep")
    const { getModel } = await import("../src/lib/types")
    for (const result of [
      await queryOpenAIBackground({
        prompt: "probe",
        model: getModel("gpt-5.4-pro")!,
        maxOutputTokens,
      }),
      await queryOpenAIDeepResearch({
        topic: "probe",
        model: getModel("o3-deep-research-2025-06-26")!,
        maxOutputTokens,
      }),
    ]) {
      expect(result.error).toContain("positive safe integer")
    }
    expect(responsesCreateMock).not.toHaveBeenCalled()
  })

  it.each([undefined, 4096])(
    "fire-and-forget returns empty content + responseId, keeps partial on disk (cap: %s)",
    async (maxOutputTokens) => {
      makeTestEnv()
      const responseId = "resp_pro_faf_1"

      responsesCreateMock.mockResolvedValueOnce({ id: responseId })

      vi.resetModules()
      const { queryOpenAIBackground } = await import("../src/lib/openai-deep")
      const { getModel } = await import("../src/lib/types")
      const { findPartialByResponseId } = await import("../src/lib/persistence")
      const gptPro = getModel("gpt-5.4-pro")!

      const result = await queryOpenAIBackground({
        prompt: "long pro query",
        model: gptPro,
        topic: "long query",
        fireAndForget: true,
        maxOutputTokens,
      })

      expect(result.responseId).toBe(responseId)
      expect(result.content).toBe("")
      expect(result.usage).toBeUndefined() // pending work has no measured token facts yet
      expect(result.cost_usd).toBeUndefined()
      expect(result.appliedMaxOutputTokens).toBe(maxOutputTokens)
      expect(result.finishReason).toBeUndefined()
      expect(result.rawFinishReason).toBeUndefined()
      // Poll must NOT run in fire-and-forget mode — otherwise we'd block on it.
      expect(responsesRetrieveMock).not.toHaveBeenCalled()
      if (maxOutputTokens === undefined) {
        expect(responsesCreateMock.mock.calls[0]![0]).not.toHaveProperty("max_output_tokens")
      } else {
        expect(responsesCreateMock.mock.calls[0]![0].max_output_tokens).toBe(maxOutputTokens)
      }

      // The partial must be on disk so `bun llm recover <id>` finds it later.
      const partial = findPartialByResponseId(responseId)
      expect(partial).not.toBeNull()
      expect(partial!.metadata.responseId).toBe(responseId)
      expect(partial!.metadata.modelId).toBe("gpt-5.4-pro")
      expect(partial!.metadata.topic).toBe("long query")
      // No completion timestamp — still "in progress".
      expect(partial!.metadata.completedAt).toBeUndefined()
    },
  )

  it("persists responseId before the poll loop runs", async () => {
    // Critical invariant: even if polling blows up, the ID must already be
    // on disk. Otherwise a process crash between create() and first retrieve()
    // loses the work permanently. We simulate retrieve() throwing and confirm
    // the partial is still findable.
    makeTestEnv()
    const responseId = "resp_pro_crash_safe"

    responsesCreateMock.mockResolvedValueOnce({ id: responseId })
    responsesRetrieveMock.mockRejectedValue(new Error("network exploded"))

    vi.resetModules()
    const { queryOpenAIBackground } = await import("../src/lib/openai-deep")
    const { getModel } = await import("../src/lib/types")
    const { findPartialByResponseId } = await import("../src/lib/persistence")
    const gptPro = getModel("gpt-5.4-pro")!

    // Call with abortSignal pre-aborted so the poll loop short-circuits
    // without actually hitting the mocked-to-throw retrieve.
    const ac = new AbortController()
    ac.abort("test-preempt")
    const result = await queryOpenAIBackground({
      prompt: "crashy",
      model: gptPro,
      abortSignal: ac.signal,
    })

    // We don't care what status the poll returned — we care that the partial
    // was written before polling started.
    expect(result.responseId).toBe(responseId)
    const partial = findPartialByResponseId(responseId)
    expect(partial).not.toBeNull()
    expect(partial!.metadata.responseId).toBe(responseId)
  })
})

describe("recover <id> works for pro-mode responseIds", () => {
  it("falls through to OpenAI retrieveResponse for non-deep-research OpenAI partials", async () => {
    // A pro-mode partial (persisted by queryOpenAIBackground with gpt-5.4-pro)
    // must recover via OpenAI's retrieveResponse, not Gemini's pollForGemini.
    // pollResponseToCompletion picks the provider from the persisted modelId.
    makeTestEnv()
    const responseId = "resp_pro_recover_1"

    responsesRetrieveMock.mockResolvedValueOnce({
      id: responseId,
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "recovered pro answer" }],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
    })

    // Seed a pro-mode partial as if queryOpenAIBackground had written it.
    vi.resetModules()
    const persistence = await import("../src/lib/persistence")
    const path = persistence.getPartialPath(responseId)
    persistence.writePartialHeader(path, {
      responseId,
      model: "GPT-5.4 Pro",
      modelId: "gpt-5.4-pro",
      topic: "pro recovery test",
      startedAt: new Date().toISOString(),
    })

    const { pollResponseToCompletion } = await import("../src/lib/dispatch")
    const result = await pollResponseToCompletion(responseId, /* silent */ true)

    expect(result.status).toBe("completed")
    expect(result.content).toBe("recovered pro answer")
    // Single retrieveResponse call — first call returned "completed", so the
    // poll loop doesn't spin.
    expect(responsesRetrieveMock).toHaveBeenCalledTimes(1)
  })

  it("partial on disk is discoverable by findPartialByResponseId with pro model metadata", async () => {
    // The partial file written by queryOpenAIBackground carries enough context
    // for listPartials / `llm partials` to show the user what's recoverable.
    makeTestEnv()
    const responseId = "resp_pro_listable"

    responsesCreateMock.mockResolvedValueOnce({ id: responseId })

    vi.resetModules()
    const { queryOpenAIBackground } = await import("../src/lib/openai-deep")
    const { getModel } = await import("../src/lib/types")
    const persistence = await import("../src/lib/persistence")
    const gptPro = getModel("gpt-5.4-pro")!

    await queryOpenAIBackground({
      prompt: "listable pro query",
      model: gptPro,
      topic: "listable query",
      fireAndForget: true,
    })

    // listPartials returns all incomplete partials — ours should be among them.
    const all = persistence.listPartials({ includeCompleted: false })
    const ours = all.find((p) => p.metadata.responseId === responseId)
    expect(ours).toBeDefined()
    expect(ours!.metadata.model).toBe("GPT-5.4 Pro")
    expect(ours!.metadata.modelId).toBe("gpt-5.4-pro")
    expect(ours!.metadata.topic).toBe("listable query")
    expect(existsSync(ours!.path)).toBe(true)
  })
})

describe("recover <id> fast-path: completed local partial bypasses OpenAI re-poll", () => {
  // Regression: dual-pro 2026-05-13 SIGKILL incident. Workflow ran:
  //   1. queryOpenAIBackground completes Pro leg → content in memory.
  //   2. Wrapper SIGKILLed mid-judging → in-memory content lost.
  //   3. `bun llm recover <id>` finds the partial (now persisted by my fix),
  //      but PRE-fix would still re-poll OpenAI which had requeued the
  //      response object (status=queued, output=[]) — recovery hangs and
  //      ultimately fails. Fast-path: return the cached partial directly,
  //      skip the re-poll. The OpenAI response object's lifecycle is its own
  //      problem; the local cache is canonical.
  it.each([
    {
      header: "usage_prompt: 42\nusage_completion: 100\nusage_total: 142",
      tokens: { prompt: 42, completion: 100, total: 142 },
      priced: true,
    },
    { header: "usage_prompt: 42", tokens: { prompt: 42 }, priced: false },
    { header: "usage_completion: 100", tokens: { completion: 100 }, priced: false },
    { header: "usage_total: 142", tokens: { total: 142 }, priced: false },
    { header: "usage_prompt: 0", tokens: { prompt: 0 }, priced: false },
  ])(
    "returns legacy cached content without inventing counts or charge: $header",
    async ({ header, tokens, priced }) => {
      const env = makeTestEnv()
      const responseId = "resp_pro_cached_recovery"

      // Seed a completed partial on disk as queryOpenAIBackground would now write.
      vi.resetModules()
      const persistence = await import("../src/lib/persistence")
      const path = persistence.getPartialPath(responseId)
      persistence.writePartialHeader(path, {
        responseId,
        model: "GPT-5.4 Pro",
        modelId: "gpt-5.4-pro",
        topic: "cached-recovery-test",
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      })
      persistence.appendPartial(path, "cached pro response body")
      persistence.completePartial(path, {
        delete: false,
        usage: { promptTokens: 42, completionTokens: 100, totalTokens: 142 },
      })
      writeFileSync(path, readFileSync(path, "utf8").replace(/^receipt: .*$/m, header))

      // Both OpenAI mock paths MUST stay unused. If runRecover re-polls
      // OpenAI for a partial we already have, that's the bug.
      responsesCreateMock.mockReset()
      responsesRetrieveMock.mockReset()
      responsesRetrieveMock.mockRejectedValue(new Error("SHOULD NOT BE CALLED"))

      const { runRecover } = await import("../src/cmd/recover")
      await runRecover({
        responseId,
        clean: false,
        cleanStale: false,
        includeAll: false,
      })

      expect(responsesRetrieveMock).not.toHaveBeenCalled()
      expect(responsesCreateMock).not.toHaveBeenCalled()
      const recovered = JSON.parse(env.stdout.filter((line) => line.startsWith("{")).at(-1)!)
      expect(recovered).toHaveProperty("tokens", tokens)
      expect(recovered).toHaveProperty(priced ? "list_equivalent_usd" : "list_equivalent_reason")
      expect(recovered).not.toHaveProperty("cost_usd")
      expect(recovered).toHaveProperty("cost_usd_reason", expect.stringMatching(/\S/))
      expect(recovered).toHaveProperty("usage", {
        ...(tokens.prompt === undefined ? {} : { promptTokens: tokens.prompt }),
        ...(tokens.completion === undefined ? {} : { completionTokens: tokens.completion }),
        ...(tokens.total === undefined ? {} : { totalTokens: tokens.total }),
      })

      // Partial stays on disk for the NEXT recovery — re-runs of `bun llm
      // recover <id>` should keep working from the same cache.
      const stillCached = persistence.findPartialByResponseId(responseId)
      expect(stillCached).not.toBeNull()
      expect(stillCached!.content).toContain("cached pro response body")
    },
  )
})

describe("isOpenAIBackgroundCapable", () => {
  it("returns true for OpenAI non-deep-research models", async () => {
    const { isOpenAIBackgroundCapable } = await import("../src/lib/openai-deep")
    const { getModel } = await import("../src/lib/types")
    expect(isOpenAIBackgroundCapable(getModel("gpt-5.4-pro")!)).toBe(true)
    expect(isOpenAIBackgroundCapable(getModel("gpt-5.4")!)).toBe(true)
    expect(isOpenAIBackgroundCapable(getModel("o3-pro")!)).toBe(true)
  })

  it("returns false for OpenAI deep-research models (they use queryOpenAIDeepResearch)", async () => {
    const { isOpenAIBackgroundCapable } = await import("../src/lib/openai-deep")
    const { getModel } = await import("../src/lib/types")
    const o3Deep = getModel("o3-deep-research-2025-06-26")!
    expect(o3Deep.isDeepResearch).toBe(true)
    expect(isOpenAIBackgroundCapable(o3Deep)).toBe(false)
  })

  it("returns false for non-OpenAI models (Anthropic, Google, OpenRouter)", async () => {
    const { isOpenAIBackgroundCapable } = await import("../src/lib/openai-deep")
    const { getModel } = await import("../src/lib/types")
    // K2.6 via OpenRouter — the whole reason the Kimi leg stays on generateText.
    expect(isOpenAIBackgroundCapable(getModel("moonshotai/kimi-k2.6")!)).toBe(false)
    expect(isOpenAIBackgroundCapable(getModel("claude-opus-4-6")!)).toBe(false)
    expect(isOpenAIBackgroundCapable(getModel("gemini-3-pro-preview")!)).toBe(false)
  })
})
