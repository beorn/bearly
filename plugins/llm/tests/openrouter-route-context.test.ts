/**
 * @failure OpenRouter load-balances a 117k DeepSeek /pro prompt onto a DeepInfra
 *   route whose window is 32768, so the DeepSeek opinion is lost even though the
 *   CLI advertises the model's 128k registry window. Recurrence: live catalog
 *   lists DeepInfra at 163840, so the pin *selects* that provider for a 128846
 *   token prompt and the 32k route still fires.
 * @level l1 — queryModel dispatch over a recorded token/window pair and a stubbed
 *   OpenRouter endpoints list
 * @consumer bun llm pro DeepSeek legs (ask → queryModel → OpenRouter)
 * @testonly none
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeTestEnv } from "./helpers"

/**
 * Recorded 2026-10-09 /pro specimen
 * `/hh/var/@dev6/1179-pro-snapshot-id.json`:
 * DeepInfra `max_num_tokens (32768)` against prompt length 117114.
 * 27977 classifies that refusal after dispatch; this file pins that the
 * request never goes to that route.
 */
const SPECIMEN_PROMPT_TOKENS = 117_114
const SPECIMEN_ROUTE_WINDOW = 32_768
const FITTING_WINDOW = 128_000
/** Live OpenRouter endpoints cache 2026-10-10T00:20:17Z — `/hh/var/@dev13/28425/live-endpoints-cache.json`. */
const LIVE_CATALOG_STREAMLAKE = 128_000
const LIVE_CATALOG_DEEPINFRA = 163_840
const RECURRENCE_PROMPT_TOKENS = 128_846

const generateTextMock = vi.fn()
const streamTextMock = vi.fn()
vi.mock("ai", () => ({ generateText: generateTextMock, streamText: streamTextMock }))

function resetMocksToOk() {
  generateTextMock.mockReset()
  generateTextMock.mockResolvedValue({
    text: "ok",
    finalStep: { reasoningText: undefined },
    usage: { inputTokens: SPECIMEN_PROMPT_TOKENS, outputTokens: 5 },
  })
  streamTextMock.mockReset()
  streamTextMock.mockImplementation(() => ({
    textStream: (async function* () {
      yield "ok"
    })(),
    finalStep: Promise.resolve({ response: undefined }),
    usage: Promise.resolve({ inputTokens: SPECIMEN_PROMPT_TOKENS, outputTokens: 5 }),
  }))
}

/** `estimateTokens` is ceil(chars / 3.5); this length is exactly 117114 tokens. */
function promptOfRecordedTokenCount(): string {
  return "x".repeat(Math.round(SPECIMEN_PROMPT_TOKENS * 3.5))
}

function promptOfRecurrenceTokenCount(): string {
  return "x".repeat(Math.round(RECURRENCE_PROMPT_TOKENS * 3.5))
}

function endpointsBody(routes: ReadonlyArray<{ provider_name: string; context_length: number }>): string {
  return JSON.stringify({
    data: {
      id: "deepseek/deepseek-chat",
      endpoints: routes.map((route) => ({
        name: `${route.provider_name} | DeepSeek Chat`,
        provider_name: route.provider_name,
        context_length: route.context_length,
      })),
    },
  })
}

function stubEndpointsFetch(routes: ReadonlyArray<{ provider_name: string; context_length: number }>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.includes("/endpoints")) {
        throw new Error(`unexpected fetch in 28425 test: ${url}`)
      }
      expect(url, "endpoints URL keeps the model slash").toContain(
        "openrouter.ai/api/v1/models/deepseek/deepseek-chat/endpoints",
      )
      return new Response(endpointsBody(routes), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }),
  )
}

describe("28425 — OpenRouter must not send a 117k prompt to a 32k route", () => {
  beforeEach(() => {
    resetMocksToOk()
  })

  it("pins only OpenRouter providers whose context fits the recorded 117114-token prompt", async () => {
    makeTestEnv()
    delete process.env.LLM_SKIP_MODEL_LIVENESS
    stubEndpointsFetch([
      { provider_name: "DeepInfra", context_length: SPECIMEN_ROUTE_WINDOW },
      { provider_name: "Together", context_length: FITTING_WINDOW },
      { provider_name: "Fireworks", context_length: 163_840 },
    ])
    vi.resetModules()

    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")
    const model = getModel("deepseek/deepseek-chat")!
    expect(model.reasoning?.contextWindow, "registry still advertises 128k").toBe(128000)

    const { response } = await queryModel({
      question: promptOfRecordedTokenCount(),
      model,
      observationStore: null,
    })

    expect(response.error).toBeUndefined()
    expect(generateTextMock, "fitting routes exist, so the leg still dispatches").toHaveBeenCalledTimes(1)
    const call = generateTextMock.mock.calls[0]![0] as {
      providerOptions?: { openrouter?: { provider?: { only?: string[]; allow_fallbacks?: boolean } } }
    }
    const pin = call.providerOptions?.openrouter?.provider
    expect(pin?.allow_fallbacks).toBe(false)
    expect(pin?.only).toEqual(["Together", "Fireworks"])
    expect(pin?.only, "DeepInfra 32768 is excluded").not.toContain("DeepInfra")
  })

  it("refuses before dispatch when every listed route is the recorded 32768 window", async () => {
    makeTestEnv()
    delete process.env.LLM_SKIP_MODEL_LIVENESS
    stubEndpointsFetch([{ provider_name: "DeepInfra", context_length: SPECIMEN_ROUTE_WINDOW }])
    vi.resetModules()

    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")

    const { response } = await queryModel({
      question: promptOfRecordedTokenCount(),
      model: getModel("deepseek/deepseek-chat")!,
      observationStore: null,
    })

    expect(generateTextMock, "a too-small route never receives the prompt").not.toHaveBeenCalled()
    expect(response.error).toMatch(/CONTEXT LENGTH/)
    expect(response.error).toContain(String(SPECIMEN_PROMPT_TOKENS))
    expect(response.error).toContain(String(SPECIMEN_ROUTE_WINDOW))
    expect(response.error).not.toMatch(/check OPENROUTER_API_KEY/)
  })

  it("refuses a 128846-token prompt when the live catalog lists DeepInfra at 163840", async () => {
    makeTestEnv()
    delete process.env.LLM_SKIP_MODEL_LIVENESS
    stubEndpointsFetch([
      { provider_name: "StreamLake", context_length: LIVE_CATALOG_STREAMLAKE },
      { provider_name: "DeepInfra", context_length: LIVE_CATALOG_DEEPINFRA },
    ])
    vi.resetModules()

    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")

    const { response } = await queryModel({
      question: promptOfRecurrenceTokenCount(),
      model: getModel("deepseek/deepseek-chat")!,
      observationStore: null,
    })

    expect(
      generateTextMock,
      "live catalog DeepInfra 163840 must not receive the 128846-token prompt",
    ).not.toHaveBeenCalled()
    expect(response.error).toMatch(/CONTEXT LENGTH/)
    expect(response.error).toContain(String(RECURRENCE_PROMPT_TOKENS))
    expect(response.error).not.toMatch(/check OPENROUTER_API_KEY/)
  })
})

describe("28425 — pinOpenRouterRoutesForPrompt on the recorded pair", () => {
  it("keeps providers at or above 117114 and drops DeepInfra at 32768", async () => {
    const { pinOpenRouterRoutesForPrompt } = await import("../src/lib/openrouter-route-pin")
    const pin = pinOpenRouterRoutesForPrompt(SPECIMEN_PROMPT_TOKENS, [
      { providerSlug: "DeepInfra", contextLength: SPECIMEN_ROUTE_WINDOW },
      { providerSlug: "Together", contextLength: FITTING_WINDOW },
    ])
    expect(pin).toEqual({ only: ["Together"], allow_fallbacks: false })
  })

  it("names 117114 and 32768 when no listed route fits", async () => {
    const { pinOpenRouterRoutesForPrompt } = await import("../src/lib/openrouter-route-pin")
    expect(() =>
      pinOpenRouterRoutesForPrompt(SPECIMEN_PROMPT_TOKENS, [
        { providerSlug: "DeepInfra", contextLength: SPECIMEN_ROUTE_WINDOW },
      ]),
    ).toThrow(/117114[\s\S]*32768|32768[\s\S]*117114/)
  })

  it("injects the pin into the OpenRouter JSON body the SDK would POST", async () => {
    const { injectOpenRouterProviderPin } = await import("../src/lib/openrouter-route-pin")
    const seen: string[] = []
    const wrapped = injectOpenRouterProviderPin({ only: ["Together"], allow_fallbacks: false }, (async (
      _input,
      init,
    ) => {
      seen.push(String(init?.body ?? ""))
      return new Response("{}", { status: 200 })
    }) as typeof fetch)
    await wrapped("https://openrouter.ai/api/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "deepseek/deepseek-chat" }),
    })
    expect(JSON.parse(seen[0]!)).toEqual({
      model: "deepseek/deepseek-chat",
      provider: { only: ["Together"], allow_fallbacks: false },
    })
  })
})
