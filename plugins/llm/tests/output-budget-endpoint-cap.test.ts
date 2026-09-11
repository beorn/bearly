/**
 * Bead 22972 — the /pro output budget ignored the endpoint's own cap.
 *
 * `computeMaxOutputTokens` returned `contextWindow − input − safety` and
 * ignored `maxOutputTokens` whenever both were set. `contextWindow` is the
 * COMBINED input+output limit, so that asked every endpoint for its entire
 * remaining window on every call: 16× over the advertised ceiling on Gemini 3
 * Flash, 32× on Inkling, 10× on DeepSeek R1.
 *
 * It stayed invisible because most providers silently clamp an over-large
 * `max_tokens`. OpenRouter instead prices it as a CREDIT RESERVATION, so a leg
 * 402s once `requested × outputPrice` exceeds the balance — and the 402 fell
 * through to the auth branch and printed "check OPENROUTER_API_KEY" for a key
 * that was working in the same run. Two mainstays were retired as dead models
 * on that message: DeepSeek R1 (2026-08-19) and Kimi K3 (2026-09-11). Both
 * were measured alive and answering immediately after this fix landed.
 *
 * The arms below are the three ways it can come back: the clamp stops being
 * taken, the registry gains a model without an endpoint cap, or the 402 goes
 * back to blaming the credential.
 */

import { describe, it, expect } from "vitest"
import { describeDispatchFailure } from "../src/lib/dispatch-error"
import { computeMaxOutputTokens, MAX_USEFUL_OUTPUT_TOKENS } from "../src/lib/research"
import { MODELS } from "../src/lib/types"
import type { Model } from "../src/lib/types"

/**
 * The 402 OpenRouter actually returned for `moonshotai/kimi-k3`, captured live
 * 2026-09-11 through our own dispatch path. Verbatim: the remedy sentence in
 * the body is what the new message quotes back, so a reworded fixture would
 * stop testing the thing that reaches the reader.
 */
function creditReservation402(): unknown {
  const error = new Error(
    "This request requires more credits, or fewer max_tokens. You requested up to 943716 tokens, " +
      "but can only afford 538968. To increase, visit https://openrouter.ai/settings/credits and add more credits",
  )
  return Object.assign(error, { name: "AI_APICallError", statusCode: 402 })
}

const target = {
  provider: "openrouter" as const,
  modelId: "moonshotai/kimi-k3",
  displayName: "Kimi K3",
}

describe("22972 — a 402 is an output-budget refusal, never a credentials one", () => {
  it("never blames the credential, and names the parameter to change", () => {
    const described = describeDispatchFailure(creditReservation402(), target)

    // The whole point: this message existed to stop saying "check the key".
    expect(described.message).not.toMatch(/OPENROUTER_API_KEY/iu)
    expect(described.message).not.toMatch(/auth failed/iu)

    expect(described.kind).toBe("output-budget")
    expect(described.message).toMatch(/NOT a credentials problem/iu)
    expect(described.message).toMatch(/maxOutputTokens/u)
    expect(described.message).toMatch(/max_completion_tokens/u)
    // Both numbers, so the reader can size the fix without a second round trip.
    expect(described.message).toContain("943716")
    expect(described.message).toContain("538968")
  })

  it("is scoped to the CALL, so it cannot mark the whole provider refusing", () => {
    // The same credential and route serve every other leg in the same dispatch.
    // A provider-scoped refusal here would take working models down with it —
    // and would persist a provider observation saying so.
    const described = describeDispatchFailure(creditReservation402(), target)
    expect(described.scope).toBe("call")
    expect(described.observation).toBeUndefined()
  })

  it("still classifies a real auth failure as auth (the new branch swallows nothing)", () => {
    const unauthorized = Object.assign(new Error("Unauthorized: invalid api key"), { statusCode: 401 })
    const described = describeDispatchFailure(unauthorized, target)
    expect(described.kind).toBe("auth")
    expect(described.message).toMatch(/OPENROUTER_API_KEY/u)
  })
})

describe("22972 — the budget is the smallest of every bound that applies", () => {
  const base: Omit<Model, "reasoning"> = {
    provider: "openrouter",
    modelId: "test/model",
    displayName: "Test",
    isDeepResearch: false,
    costTier: "low",
    inputPricePerM: 1,
    outputPricePerM: 1,
    typicalLatencyMs: 1000,
  }
  const tiny = [{ role: "user", content: "Hello" }]

  it("clamps to the endpoint ceiling instead of the window's headroom", () => {
    // The exact Inkling shape: a 32768 endpoint cap behind a 1048576 window.
    const model = { ...base, reasoning: { contextWindow: 1_048_576, maxOutputTokens: 32_768 } } as Model
    expect(computeMaxOutputTokens(model, tiny)).toBe(32_768)
  })

  it("never asks for more than a real completion needs, even with a huge cap", () => {
    // Kimi K3's own endpoint ceiling is 943718 — legal, and still absurd to
    // reserve. Largest completion in 38 measured records: 26472 tokens.
    const model = { ...base, reasoning: { contextWindow: 1_048_576, maxOutputTokens: 943_718 } } as Model
    expect(computeMaxOutputTokens(model, tiny)).toBe(MAX_USEFUL_OUTPUT_TOKENS)
  })
})

describe("22972 — the registry cannot regain the shape that caused it", () => {
  it("every SKU declaring a contextWindow also declares its endpoint output cap", () => {
    // This is the arm that catches the NEXT occurrence. Both retirements began
    // with a model entering the registry carrying only a combined window, which
    // reads as complete and silently means "ask for everything".
    const missing = MODELS.filter((m) => m.reasoning?.contextWindow && m.reasoning.maxOutputTokens === undefined).map(
      (m) => m.modelId,
    )
    expect(missing, `add maxOutputTokens (the endpoint's max_completion_tokens) for: ${missing.join(", ")}`).toEqual([])
  })

  it("no SKU claims an output cap larger than its own context window", () => {
    const impossible = MODELS.filter(
      (m) =>
        m.reasoning?.contextWindow &&
        m.reasoning.maxOutputTokens !== undefined &&
        m.reasoning.maxOutputTokens > m.reasoning.contextWindow,
    ).map((m) => m.modelId)
    expect(impossible).toEqual([])
  })
})
