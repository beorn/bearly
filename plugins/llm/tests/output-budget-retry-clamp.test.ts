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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Model } from "../src/lib/types"
import { makeTestEnv } from "./helpers"

const { generateTextMock, streamTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  streamTextMock: vi.fn(),
}))
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: generateTextMock,
  streamText: streamTextMock,
}))

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
function contextExceeded(realInputTokens = 1000): Error {
  return new Error(
    "This endpoint's maximum context length is 1048576 tokens. However, you requested about 1048600 tokens " +
      `(${realInputTokens} of text input, 1047600 in the output). Please reduce the length of either one.`,
  )
}

describe("22972 — the context-exceeded retry clamps like the first attempt", () => {
  // The retry announces itself on stderr; capture it so the row can read the
  // announced cap and the strict no-console-output setup stays quiet.
  let stderr: string[] = []

  beforeEach(() => {
    makeTestEnv()
    generateTextMock.mockReset()
    process.env.OPENROUTER_API_KEY ??= "test-key-for-retry-clamp"
    stderr = []
    vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      stderr.push(parts.map(String).join(" "))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    { callerBound: undefined, expectedCap: 32_768, realInputTokens: 1000, expectedRetryCap: 32_768 },
    { callerBound: 4096, expectedCap: 4096, realInputTokens: 1000, expectedRetryCap: 4096 },
    { callerBound: 32_768, expectedCap: 32_768, realInputTokens: 1_030_000, expectedRetryCap: 14_480 },
  ])(
    "reports the applied $expectedRetryCap cap after an initial $expectedCap request",
    async ({ callerBound, expectedCap, realInputTokens, expectedRetryCap }) => {
      generateTextMock.mockRejectedValueOnce(contextExceeded(realInputTokens)).mockResolvedValueOnce({
        text: "ok",
        finishReason: "length",
        rawFinishReason: "max_output_tokens",
        finalStep: { reasoningText: undefined },
        usage: { inputTokens: 1000, outputTokens: 2 },
      })

      const options = { modelObject: model, stream: false, maxOutputTokens: callerBound }
      const response = await ask("say ok", "standard", options)

      expect(generateTextMock).toHaveBeenCalledTimes(2)
      expect(stderr.filter((line) => line.includes("Retrying with cap="))).toEqual([
        expect.stringContaining(`Retrying with cap=${expectedRetryCap}.`),
      ])
      const retryCap = generateTextMock.mock.calls[1]?.[0]?.maxOutputTokens
      expect(response.appliedMaxOutputTokens).toBe(retryCap)
      expect(response.finishReason).toBe("length")
      expect(response.rawFinishReason).toBe("max_output_tokens")

      // Unclamped this would be 1048576 − 1000 − 4096 = 1043480: the same
      // over-ask that 402s an expensive model and retired two mainstays.
      expect(retryCap).not.toBe(1_043_480)
      expect(generateTextMock.mock.calls.map(([call]) => call.maxOutputTokens)).toEqual([expectedCap, expectedRetryCap])
      expect(retryCap).toBeLessThanOrEqual(MAX_USEFUL_OUTPUT_TOKENS)
    },
  )
})
