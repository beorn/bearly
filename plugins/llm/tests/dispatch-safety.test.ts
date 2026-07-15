import { afterEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "../src/lib/dual-pro"
import type { Provider } from "../src/lib/types"
import {
  assertDispatchableModelIds,
  getLegTimeoutMs,
  preflightProviders,
  runWithTimeout,
} from "../src/lib/dispatch-safety"

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

  it("preflights each provider once and makes insufficient quota actionable before dispatch", async () => {
    const probe = vi.fn(async (provider: Provider) => {
      if (provider === "openai") throw new Error("insufficient_quota: billing hard limit reached")
    })

    await expect(preflightProviders(["openai", "openai", "xai"], { probe, timeoutMs: 1_000 })).rejects.toThrow(
      "OpenAI quota preflight failed: insufficient quota; top up OPENAI_API_KEY billing before retrying.",
    )
    expect(probe).toHaveBeenCalledTimes(2)
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
})
