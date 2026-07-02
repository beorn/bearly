/**
 * Regression: provider errors must be SURFACED, not swallowed into the generic
 * "Model returned empty response... silent failure" message.
 *
 * 2026-07-02 incident: with OpenAI billing exhausted, `bun llm "q"` printed
 * "Model returned empty response (no content). This is a silent failure." The
 * real cause — an `insufficient_quota` error streamed by the provider — was
 * captured by `streamText`'s `onError` but never propagated: the streaming
 * branch of `queryModel` read only `textStream` (which ends empty on error),
 * and `askAndFinish` passed only `response.content` to `finishResponse`,
 * dropping `response.error`. Same class hid a transient Gemini failure behind
 * an "instant empty response".
 *
 * Sibling fix: the post-command pricing auto-update banner listed ~30 provider
 * ids ("New models — add to MODELS") that were almost all dated snapshots /
 * apiModelId aliases of already-registered models, which read as "your model
 * was rejected". `filterNewModelCandidates` collapses that noise.
 */

import { describe, it, expect, vi } from "vitest"
import { makeTestEnv, runCli } from "./helpers"
import { describeProviderError } from "../src/lib/research"
import { filterNewModelCandidates } from "../src/cmd/pricing"

// Mock `ai` so the CLI never touches the network. streamText is driven per-test.
// `vi.hoisted` is required because a static import above (research.ts) pulls in
// "ai" at module-load, which runs the mock factory before plain consts would
// initialise.
const { generateTextMock, streamTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  streamTextMock: vi.fn(),
}))
vi.mock("ai", () => ({ generateText: generateTextMock, streamText: streamTextMock }))

/** The EXACT object `streamText` forwards to `onError` when OpenAI streams an
 *  insufficient_quota error — captured live 2026-07-02. A plain object (NOT an
 *  Error), no top-level `.message`; the detail is nested under `.error`. This
 *  is the shape that made the old code print `[object Object]`. */
function quotaStreamError(): unknown {
  return {
    type: "error",
    sequence_number: 2,
    error: {
      type: "insufficient_quota",
      code: "insufficient_quota",
      message:
        "You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.",
      param: null,
    },
  }
}

/** The alternate shape: an SDK APICallError whose useful detail is in
 *  `responseBody`, not the retry-wrapper `.message`. */
function quotaApiError(): Error {
  return Object.assign(new Error("Failed after 3 attempts"), {
    statusCode: 429,
    responseBody: JSON.stringify({
      error: { type: "insufficient_quota", message: "You exceeded your current quota." },
    }),
  })
}

describe("describeProviderError", () => {
  it("surfaces insufficient_quota from the real streamed object (not [object Object])", () => {
    const msg = describeProviderError(quotaStreamError(), "openai")
    expect(msg).toMatch(/insufficient_quota/i)
    expect(msg).toMatch(/quota exhausted/i)
    // Points the user at a working provider instead of dead-ending.
    expect(msg).toMatch(/--model/)
    expect(msg).not.toMatch(/\[object Object\]/)
  })

  it("also surfaces insufficient_quota from an SDK APICallError (detail in responseBody)", () => {
    const msg = describeProviderError(quotaApiError(), "openai")
    expect(msg).toMatch(/quota exhausted/i)
    expect(msg).not.toBe("Failed after 3 attempts")
  })

  it("detects rate limits (429)", () => {
    expect(describeProviderError(new Error("429 Too Many Requests"), "openai")).toMatch(/rate-limited/i)
  })

  it("detects renamed / unavailable model ids", () => {
    const msg = describeProviderError(new Error("The model `gemini-x` does not exist"), "google")
    expect(msg).toMatch(/renamed or unavailable/i)
  })

  it("detects auth failures", () => {
    expect(describeProviderError(new Error("401 invalid_api_key"), "openrouter")).toMatch(/auth failed/i)
  })

  it("falls back to the raw message when nothing matches", () => {
    expect(describeProviderError(new Error("socket hang up"), "xai")).toBe("socket hang up")
  })
})

describe("filterNewModelCandidates — de-noise the auto-discovery banner", () => {
  // `gpt-5-pro` is our `gpt-5.4-pro` alias; `gpt-5` our `gpt-5.4` alias.
  const known = ["gpt-5.4", "o3-mini", "gpt-5", "o4-mini-deep-research-2025-06-26"]
  const apiIds = ["gpt-5", "gpt-5-pro"]

  it("drops dated snapshots of known base ids", () => {
    expect(filterNewModelCandidates(["o3-mini-2025-01-31", "gpt-5-2025-08-07"], known, apiIds)).toEqual([])
  })

  it("drops apiModelId aliases and their dated snapshots", () => {
    expect(filterNewModelCandidates(["gpt-5-pro", "gpt-5-pro-2025-10-06"], known, apiIds)).toEqual([])
  })

  it("drops an undated id whose dated form we already track", () => {
    expect(filterNewModelCandidates(["o4-mini-deep-research"], known, apiIds)).toEqual([])
  })

  it("drops OpenAI non-SKU surfaces (chat-latest, search-api)", () => {
    const out = filterNewModelCandidates(
      ["gpt-5-chat-latest", "gpt-5-search-api", "gpt-5-search-api-2025-10-14"],
      known,
      apiIds,
    )
    expect(out).toEqual([])
  })

  it("collapses a dated variant when its base is also a candidate", () => {
    expect(filterNewModelCandidates(["gpt-5.4-mini", "gpt-5.4-mini-2026-03-17"], known, apiIds)).toEqual([
      "gpt-5.4-mini",
    ])
  })

  it("keeps genuinely new base models", () => {
    expect(filterNewModelCandidates(["gpt-5.2-codex", "gpt-6"], known, apiIds)).toEqual(["gpt-5.2-codex", "gpt-6"])
  })
})

describe("queryModel streaming path — the empty-response silent failure fix", () => {
  it("empty stream + onError(insufficient_quota) exits nonzero with the actionable message", async () => {
    const env = makeTestEnv()
    generateTextMock.mockReset()
    streamTextMock.mockReset()
    // Mirror the real AI SDK behaviour: provider error is forwarded to onError,
    // the text stream ends empty, and the usage promise still resolves.
    streamTextMock.mockImplementation((opts: { onError?: (e: { error: unknown }) => void }) => {
      opts.onError?.({ error: quotaStreamError() })
      return {
        textStream: (async function* () {})(),
        usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
      }
    })

    const { exited } = await runCli(["-y", "reply with the single word alive"])

    expect(exited).toBe(1)
    const out = [...env.stderr, ...env.stdout].join("\n")
    // The real cause is surfaced instead of "silent failure".
    expect(out).toMatch(/insufficient_quota/i)
    expect(out).not.toMatch(/This is a silent failure/)
  })
})
