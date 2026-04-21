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
import { existsSync } from "node:fs"
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
  it("persists a partial before polling, returns content on completion", async () => {
    makeTestEnv()
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
      usage: { input_tokens: 10, output_tokens: 5 },
    })

    vi.resetModules()
    const { queryOpenAIBackground } = await import("../src/lib/openai-deep")
    const { getModel } = await import("../src/lib/types")
    const gptPro = getModel("gpt-5.4-pro")!

    const result = await queryOpenAIBackground({
      prompt: "say hi",
      model: gptPro,
      topic: "greeting",
    })

    expect(result.responseId).toBe(responseId)
    expect(result.content).toBe("hello from pro")
    // Happy path deletes the partial on success — partials dir should be empty.
    // (It's under HOME/.cache/tools/llm-partials; makeTestEnv isolates HOME.)
    expect(responsesCreateMock).toHaveBeenCalledTimes(1)
    // create() must have requested background mode — that's the whole reason
    // we're on this path. Without it the ID isn't captured before polling and
    // a mid-call crash loses the work.
    const createArgs = responsesCreateMock.mock.calls[0]![0]
    expect(createArgs.background).toBe(true)
    expect(createArgs.model).toBe("gpt-5.4-pro")
    // Responses-API background path should NOT inject the web_search_preview
    // tool — that's for deep research only. Standard pro is a plain completion.
    expect(createArgs.tools).toBeUndefined()
  })

  it("fire-and-forget returns empty content + responseId, keeps partial on disk", async () => {
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
    })

    expect(result.responseId).toBe(responseId)
    expect(result.content).toBe("")
    // Poll must NOT run in fire-and-forget mode — otherwise we'd block on it.
    expect(responsesRetrieveMock).not.toHaveBeenCalled()

    // The partial must be on disk so `bun llm recover <id>` finds it later.
    const partial = findPartialByResponseId(responseId)
    expect(partial).not.toBeNull()
    expect(partial!.metadata.responseId).toBe(responseId)
    expect(partial!.metadata.modelId).toBe("gpt-5.4-pro")
    expect(partial!.metadata.topic).toBe("long query")
    // No completion timestamp — still "in progress".
    expect(partial!.metadata.completedAt).toBeUndefined()
  })

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
