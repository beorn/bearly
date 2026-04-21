/**
 * Regression: pollResponseToCompletion must route Gemini-provider partials
 * to pollForGeminiCompletion, NOT to OpenAI's retrieveResponse.
 *
 * Bug (dispatch.ts pre-fix): hardcoded `retrieveResponse(responseId)` for every
 * recovered partial, which silently failed ("response not found") when the
 * partial was persisted from gemini-deep. Fix: look up the partial, resolve its
 * model's provider, and dispatch accordingly (dispatch.ts:~814).
 *
 * The assertion shape: a Gemini partial on disk → gemini poll is called at
 * least once, OpenAI retrieve is never called.
 */

import { describe, it, expect, vi } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeTestEnv } from "./helpers"

// Stub both poll paths at the module level. resolveResponseToCompletion uses
// dynamic imports (`await import("./gemini-deep")`) and top-level imports
// (`retrieveResponse` from "./openai-deep"), so we mock both files.
const pollGeminiMock = vi.fn()
const retrieveOpenAIMock = vi.fn()
const pollOpenAIMock = vi.fn()

vi.mock("../src/lib/gemini-deep", () => ({
  pollForGeminiCompletion: pollGeminiMock,
  isGeminiDeepResearch: () => false,
  queryGeminiDeepResearch: vi.fn(),
}))

vi.mock("../src/lib/openai-deep", () => ({
  retrieveResponse: retrieveOpenAIMock,
  pollForCompletion: pollOpenAIMock,
  isOpenAIDeepResearch: () => false,
  queryOpenAIDeepResearch: vi.fn(),
}))

describe("recovery routing", () => {
  it("Gemini partial routes to pollForGeminiCompletion (not retrieveResponse)", async () => {
    makeTestEnv()

    pollGeminiMock.mockReset()
    pollGeminiMock.mockResolvedValue({
      status: "completed",
      content: "gemini result",
      usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
    })
    retrieveOpenAIMock.mockReset()
    retrieveOpenAIMock.mockRejectedValue(new Error("SHOULD NOT BE CALLED"))
    pollOpenAIMock.mockReset()
    pollOpenAIMock.mockRejectedValue(new Error("SHOULD NOT BE CALLED"))

    // Persist a Gemini partial on disk. findPartialByResponseId walks the
    // ~/.cache/tools/llm-partials dir under HOME (which makeTestEnv isolates).
    vi.resetModules()
    const persistence = await import("../src/lib/persistence")
    const responseId = "gemini_regression_test_12345"
    const path = persistence.getPartialPath(responseId)
    persistence.writePartialHeader(path, {
      responseId,
      model: "Gemini 3 Pro",
      modelId: "gemini-3-pro-preview", // registered Google model
      topic: "regression test",
      startedAt: new Date().toISOString(),
    })

    const dispatch = await import("../src/lib/dispatch")
    const result = await dispatch.pollResponseToCompletion(responseId, /* silentProgress */ true)

    expect(pollGeminiMock).toHaveBeenCalledTimes(1)
    expect(pollGeminiMock).toHaveBeenCalledWith(responseId, expect.any(Object))
    expect(retrieveOpenAIMock).not.toHaveBeenCalled()
    expect(pollOpenAIMock).not.toHaveBeenCalled()
    expect(result.status).toBe("completed")
    expect(result.content).toBe("gemini result")
  }, 10_000)

  it("OpenAI-ish partial (or no partial) falls through to retrieveResponse", async () => {
    makeTestEnv()

    pollGeminiMock.mockReset()
    pollGeminiMock.mockRejectedValue(new Error("SHOULD NOT BE CALLED"))
    retrieveOpenAIMock.mockReset()
    retrieveOpenAIMock.mockResolvedValue({
      status: "completed",
      content: "openai result",
      usage: { promptTokens: 50, completionTokens: 100, totalTokens: 150 },
    })
    pollOpenAIMock.mockReset()

    vi.resetModules()
    // No partial written → falls through to the historical default (OpenAI).
    // retrieveResponse returns "completed" immediately, so no polling loop.
    const dispatch = await import("../src/lib/dispatch")
    const result = await dispatch.pollResponseToCompletion("resp_nonexistent", /* silentProgress */ true)

    expect(retrieveOpenAIMock).toHaveBeenCalledTimes(1)
    expect(pollGeminiMock).not.toHaveBeenCalled()
    expect(result.status).toBe("completed")
  }, 10_000)
})
