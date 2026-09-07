import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { DEFAULT_CONFIG } from "../src/lib/dual-pro"
import {
  assertDispatchableModelIds,
  formatLegDispatchError,
  getLegTimeoutMs,
  runWithTimeout,
} from "../src/lib/dispatch-safety"
import { describeDispatchFailure } from "../src/lib/dispatch-error"
import { runProDual } from "../src/cmd/pro"
import { getModel } from "../src/lib/types"
import { makeTestEnv } from "./helpers"

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }))

vi.mock("ai", () => ({
  generateText: vi.fn(),
  streamText: streamTextMock,
}))

describe("dual-pro dispatch safety", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("retires dead model ids before dispatch and refreshes the default split-test pool", () => {
    expect(DEFAULT_CONFIG.splitTestPool).toContain("grok-4-1-fast-reasoning")
    expect(DEFAULT_CONFIG.splitTestPool).not.toContain("grok-4")

    expect(() => assertDispatchableModelIds(["gemini-2.5-pro", "grok-4"])).toThrow(
      'Model "grok-4" is unavailable or renamed; replace it with "grok-4-1-fast-reasoning" in dual-pro-config.json.',
    )
  })

  it("makes an actual leg's insufficient-quota error actionable without a probe call", () => {
    const model = { provider: "openai" as const, modelId: "gpt-5.4-pro", displayName: "GPT-5.4 Pro" }
    const error = new Error("insufficient_quota: billing hard limit reached")
    expect(formatLegDispatchError(model, error)).toBe(
      "OpenAI insufficient quota; top up OPENAI_API_KEY billing before retrying.",
    )
    expect(describeDispatchFailure(error, model).message).toBe(formatLegDispatchError(model, error))
  })

  it("passes runWithTimeout's own wrapper message through verbatim (pro-specific partial-results semantics)", () => {
    expect(
      formatLegDispatchError(
        { provider: "openrouter", modelId: "moonshotai/kimi-k2.6", displayName: "Kimi K2.6" },
        new Error("Kimi K2.6 leg timed out after 1s; partial results will be reported."),
      ),
    ).toBe("Kimi K2.6 leg timed out after 1s; partial results will be reported.")
  })

  it("gives generic-timeout callers (e.g. recall's own race, not runWithTimeout) actionable advice that is NOT a credentials fix", () => {
    const result = formatLegDispatchError(
      { provider: "openrouter", modelId: "moonshotai/kimi-k2.6", displayName: "Kimi K2.6" },
      new Error("timed out after 2002ms (given 2000ms)"),
    )
    expect(result).toContain("OpenRouter (moonshotai/kimi-k2.6)")
    expect(result).toContain("not a credentials problem")
    expect(result).toContain("retry with more time, or use a faster model")
  })

  it("aborts a hung leg at the configured ceiling with a loud partial-results error", async () => {
    vi.useFakeTimers()
    const aborted = vi.fn()
    const task = runWithTimeout({
      label: "Kimi K2.6 leg",
      timeoutMs: 1_000,
      run: (signal) =>
        new Promise<never>(() => {
          signal.addEventListener("abort", aborted, { once: true })
        }),
    })
    const rejection = expect(task).rejects.toThrow(
      "Kimi K2.6 leg timed out after 1s; partial results will be reported.",
    )

    await vi.advanceTimersByTimeAsync(1_000)
    await rejection
    expect(aborted).toHaveBeenCalledOnce()
  })

  it("uses a 15-minute default and rejects invalid timeout configuration", () => {
    expect(getLegTimeoutMs({})).toBe(15 * 60 * 1_000)
    expect(getLegTimeoutMs({ LLM_LEG_TIMEOUT_MS: "2500" })).toBe(2_500)
    expect(() => getLegTimeoutMs({ LLM_LEG_TIMEOUT_MS: "never" })).toThrow(
      "LLM_LEG_TIMEOUT_MS must be a positive finite number of milliseconds",
    )
  })

  it("aborts the actual single-model pro provider call at LLM_LEG_TIMEOUT_MS", async () => {
    // The helper test above proves runWithTimeout itself. This crosses the
    // modelOverride branch of runProDual, which used to return before reading
    // the configured timeout.
    vi.useFakeTimers()
    const env = makeTestEnv()
    const previousTimeout = process.env.LLM_LEG_TIMEOUT_MS
    process.env.LLM_LEG_TIMEOUT_MS = "25"

    let releaseStream: (() => void) | undefined
    let providerAborted = false
    let markProviderStarted: (() => void) | undefined
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve
    })
    streamTextMock.mockReset()
    streamTextMock.mockImplementation(({ abortSignal }: { abortSignal?: AbortSignal }) => {
      markProviderStarted?.()
      const untilReleased = new Promise<void>((resolve) => {
        releaseStream = resolve
      })
      abortSignal?.addEventListener(
        "abort",
        () => {
          providerAborted = true
          releaseStream?.()
        },
        { once: true },
      )
      return {
        textStream: (async function* () {
          await untilReleased
        })(),
        usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
      }
    })

    const model = getModel("moonshotai/kimi-k2.6")
    expect(model).toBeDefined()
    const outputFile = `${env.tmpDir}/single-model-timeout.md`
    const run = runProDual({
      question: "Does the configured timeout reach this provider call?",
      modelOverride: model!,
      imagePath: undefined,
      streamToken: () => {},
      buildContext: async () => undefined,
      outputFile,
      sessionTag: "single-model-timeout",
      skipConfirm: true,
    })

    try {
      await providerStarted
      expect(streamTextMock).toHaveBeenCalledOnce()
      expect(streamTextMock.mock.calls[0]?.[0]).toHaveProperty("abortSignal")

      vi.advanceTimersByTime(24)
      expect(providerAborted).toBe(false)
      vi.advanceTimersByTime(1)
      expect(providerAborted).toBe(true)

      await expect(run).rejects.toThrow("__exit_1")
      expect(env.exitCodes).toContain(1)
      const envelopeLine = env.stdout.find((line) => line.includes('"status":"failed"'))
      expect(envelopeLine).toBeDefined()
      const envelope = JSON.parse(envelopeLine!) as { code: string; error: string }
      expect(envelope.code).toBe("provider_error")
      expect(envelope.error).toBe("Kimi K2.6 leg timed out after 25ms; partial results will be reported.")
      expect(readFileSync(outputFile, "utf-8")).toContain(envelope.error)
    } finally {
      releaseStream?.()
      await run.catch(() => undefined)
      if (previousTimeout === undefined) delete process.env.LLM_LEG_TIMEOUT_MS
      else process.env.LLM_LEG_TIMEOUT_MS = previousTimeout
    }
  })
})
