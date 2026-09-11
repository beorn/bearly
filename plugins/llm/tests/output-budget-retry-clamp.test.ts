/**
 * Bead 22972, second site — the context-exceeded RETRY must clamp too.
 *
 * `queryModel` retries once when a combined-limit provider rejects the first
 * attempt, recomputing the output cap from the REAL input token count the
 * error reports. That recomputation was `contextWindow − realInput − SAFETY`
 * with no ceiling of any kind, so a retry re-issued the very over-ask the
 * first attempt had just been fixed for.
 *
 * This file exists because the fix was invisible without it: stripping the
 * clamp from the retry path left all 417 other tests green (measured
 * 2026-09-11). A second call site is how a one-line fix ships half-done.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Model } from "../src/lib/types"

const { generateTextMock, streamTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  streamTextMock: vi.fn(),
}))
vi.mock("ai", () => ({ generateText: generateTextMock, streamText: streamTextMock }))

const { ask, MAX_USEFUL_OUTPUT_TOKENS } = await import("../src/lib/research")

/** The Inkling shape: a small advertised completion cap behind a huge window. */
const model: Model = {
  provider: "openrouter",
  modelId: "thinkingmachines/inkling",
  displayName: "Inkling",
  isDeepResearch: false,
  costTier: "low",
  inputPricePerM: 1,
  outputPricePerM: 4.05,
  typicalLatencyMs: 1000,
  reasoning: { contextWindow: 1_048_576, maxOutputTokens: 32_768 },
}

/** The real OpenRouter/K2.6 combined-limit refusal, which is what arms the
 *  retry: it reports the true input token count (1000 here). */
function contextExceeded(): Error {
  return new Error(
    "This endpoint's maximum context length is 1048576 tokens. However, you requested about 1048600 tokens " +
      "(1000 of text input, 1047600 in the output). Please reduce the length of either one.",
  )
}

describe("22972 — the context-exceeded retry clamps like the first attempt", () => {
  beforeEach(() => {
    generateTextMock.mockReset()
    process.env.OPENROUTER_API_KEY ??= "test-key-for-retry-clamp"
  })

  it("retries with the endpoint ceiling, not the whole remaining window", async () => {
    generateTextMock
      .mockRejectedValueOnce(contextExceeded())
      .mockResolvedValueOnce({ text: "ok", reasoning: [], usage: { inputTokens: 1000, outputTokens: 2 } })

    await ask("say ok", "standard", { modelObject: model, stream: false })

    expect(generateTextMock).toHaveBeenCalledTimes(2)
    const retryCap = generateTextMock.mock.calls[1]?.[0]?.maxOutputTokens

    // Unclamped this would be 1048576 − 1000 − 4096 = 1043480: the same
    // over-ask that 402s an expensive model and retired two mainstays.
    expect(retryCap).not.toBe(1_043_480)
    expect(retryCap).toBe(32_768)
    expect(retryCap).toBeLessThanOrEqual(MAX_USEFUL_OUTPUT_TOKENS)
  })
})
