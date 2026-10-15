/**
 * 28886: the llm CLI reported OpenAI and Google failures as "unclassified provider error" and
 * `llm --help` called both "ready" for ten days.
 *
 * Two independent defects:
 *
 *   1. A streaming provider failure is described correctly from `streamText`'s `onError`, and then
 *      the `textStream` loop throws the ai-sdk's synthetic `NoOutputGeneratedError` ("No output
 *      generated. Check the stream for errors."). `queryModel`'s catch re-described THAT wrapper,
 *      discarding the real cause. Both providers failed this way: Google answers a bad key with
 *      HTTP 400 ("API key not valid", `reason: API_KEY_INVALID`) and OpenAI an exhausted balance
 *      with HTTP 429 (`insufficient_quota`, "You have no credits remaining").
 *   2. `--help` derived readiness from key PRESENCE alone, so a provider whose last call failed
 *      still read "ready".
 *
 * Every provider payload below is recorded verbatim from the live calls — no live calls in tests.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { makeTestEnv, runCli } from "./helpers"
import { describeDispatchFailure } from "../src/index"

const { streamTextMock, generateTextMock } = vi.hoisted(() => ({
  streamTextMock: vi.fn(),
  generateTextMock: vi.fn(),
}))
vi.mock("ai", () => ({ generateText: generateTextMock, streamText: streamTextMock }))

/** Recorded live 2026-10-13: `GET .../models/gemini-3-pro-preview:generateContent` with an invalid key. */
function googleInvalidKeyError(): Error {
  const responseBody = JSON.stringify({
    error: {
      code: 400,
      message: "API key not valid. Please pass a valid API key.",
      status: "INVALID_ARGUMENT",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "API_KEY_INVALID",
          domain: "googleapis.com",
          metadata: { service: "generativelanguage.googleapis.com" },
        },
      ],
    },
  })
  return Object.assign(new Error("API key not valid. Please pass a valid API key."), {
    name: "AI_APICallError",
    statusCode: 400,
    responseBody,
  })
}

/** Recorded live 2026-10-13: OpenAI with a zero balance, as the ai-sdk retry wrapper delivers it. */
function openAiNoCreditsError(): Error {
  const apiError = Object.assign(
    new Error(
      "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
    ),
    {
      name: "AI_APICallError",
      statusCode: 429,
      responseBody: JSON.stringify({
        type: "error",
        error: {
          type: "insufficient_quota",
          code: "credit_balance_exhausted",
          message: "You have no credits remaining.",
          param: null,
        },
      }),
    },
  )
  return Object.assign(new Error("Failed after 3 attempts"), {
    name: "AI_RetryError",
    lastError: apiError,
  })
}

/** The ai-sdk's evidence-free wrapper, thrown by `textStream` after `onError` reported the cause. */
function noOutputGeneratedError(): Error {
  return Object.assign(new Error("No output generated. Check the stream for errors."), {
    name: "AI_NoOutputGeneratedError",
  })
}

afterEach(() => {
  streamTextMock.mockReset()
  generateTextMock.mockReset()
  delete process.env.RECALL_LLM_DENY_PROVIDERS
})

describe("dispatch failure classes on recorded provider responses", () => {
  it("names the auth class for Google's HTTP 400 invalid key, quoting the provider", () => {
    const described = describeDispatchFailure(googleInvalidKeyError(), {
      provider: "google",
      modelId: "gemini-3-pro-preview",
    })

    expect(described.kind).toBe("auth")
    expect(described.scope).toBe("provider")
    expect(described.observation).toMatchObject({ status: "refusing", kind: "auth" })
    expect(described.message).toMatch(/auth failed/iu)
    expect(described.message).toContain("API key not valid")
    expect(described.message).not.toMatch(/unclassified/iu)
  })

  it("names the quota class for OpenAI's HTTP 429 exhausted balance through the retry wrapper", () => {
    const described = describeDispatchFailure(openAiNoCreditsError(), {
      provider: "openai",
      modelId: "gpt-5.4",
    })

    expect(described.kind).toBe("quota")
    expect(described.scope).toBe("provider")
    expect(described.observation).toMatchObject({ status: "refusing", kind: "quota" })
    expect(described.message).toMatch(/insufficient quota/iu)
    expect(described.message).toContain("You have no credits remaining")
    expect(described.message).not.toMatch(/unclassified/iu)
  })

  it("names the model class for a rejected model id", () => {
    const described = describeDispatchFailure(new Error("The model `gemini-x` does not exist"), {
      provider: "google",
    })

    expect(described.kind).toBe("model-unavailable")
    expect(described.scope).toBe("model")
  })

  it("names the transport class for a refused connection", () => {
    const described = describeDispatchFailure(new Error("fetch failed: ECONNREFUSED"), {
      provider: "openrouter",
    })

    expect(described.kind).toBe("transport")
    expect(described.scope).toBe("provider")
    expect(described.message).toMatch(/transport failure/iu)
    expect(described.message).not.toMatch(/unclassified/iu)
  })

  it("never says 'unclassified' and names the classes it checked when nothing matches", () => {
    const described = describeDispatchFailure(
      Object.assign(new Error("request rejected"), {
        statusCode: 400,
        responseBody: JSON.stringify({ error: { code: "route_policy", message: "unsupported request option" } }),
      }),
      { provider: "openrouter", modelId: "test/model" },
    )

    expect(described.kind).toBe("unknown")
    expect(described.message).not.toMatch(/unclassified/iu)
    expect(described.message).toContain("HTTP 400")
    expect(described.message).toContain("auth, quota, model, transport")
    expect(described.message).toContain("unsupported request option")
  })

  // 29473: a subscription CLI route fails with no HTTP status, so there is no body to append, and the unmatched
  // branch said only that nothing matched. Recall's planner reported "Google dispatch failed … with no HTTP status"
  // for two hours while the agy one-shot was being aborted by the planner's 8 s budget.
  it.each([
    [
      "agy CLI (Antigravity Ultra subscription (agy)) failed for Gemini 2.0 Flash Lite (aborted): no stderr",
      "google",
      "Google dispatch through the agy CLI one-shot failed for Gemini 2.0 Flash Lite (aborted: the caller's time budget or signal stopped it).",
    ],
    [
      "codex CLI (codex CLI login (ChatGPT subscription or the seat's CODEX_HOME provider)) failed for GPT-5 nano (exit 1): prompt=private-text sk-test-123",
      "openai",
      "OpenAI dispatch through the codex CLI one-shot failed for GPT-5 nano (exit 1).",
    ],
  ])(
    "a subscription CLI failure names its route and outcome, never its raw detail: %s",
    (error, provider, expected) => {
      const described = describeDispatchFailure(new Error(error), { provider, modelId: "m" })

      expect(described).toMatchObject({ kind: "unknown", scope: "call", message: expected })
      expect(described.message).not.toMatch(/private-text|sk-test-123|no stderr|matched none/)
    },
  )
})

describe("streaming failures survive the ai-sdk's synthetic no-output wrapper", () => {
  it("reports Google's invalid key instead of 'No output generated'", async () => {
    makeTestEnv()
    streamTextMock.mockImplementation((options: { onError?: (arg: { error: unknown }) => void }) => {
      options.onError?.({ error: googleInvalidKeyError() })
      return {
        textStream: (async function* () {
          throw noOutputGeneratedError()
        })(),
        usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
      }
    })
    vi.resetModules()
    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")

    const { response } = await queryModel({
      question: "hi",
      model: getModel("gemini-3-pro-preview")!,
      stream: true,
      onToken: vi.fn(),
      observationStore: null,
    })

    expect(response.error).toMatch(/auth failed/iu)
    expect(response.error).toContain("API key not valid")
    expect(response.error).not.toMatch(/unclassified|no output generated/iu)
  })

  it("reports OpenAI's exhausted balance instead of 'No output generated'", async () => {
    makeTestEnv()
    streamTextMock.mockImplementation((options: { onError?: (arg: { error: unknown }) => void }) => {
      options.onError?.({ error: openAiNoCreditsError() })
      return {
        textStream: (async function* () {
          throw noOutputGeneratedError()
        })(),
        usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
      }
    })
    vi.resetModules()
    const { queryModel } = await import("../src/lib/research")
    const { getModel } = await import("../src/lib/types")

    const { response } = await queryModel({
      question: "hi",
      model: getModel("gpt-5.4")!,
      stream: true,
      onToken: vi.fn(),
      observationStore: null,
    })

    expect(response.error).toMatch(/insufficient quota/iu)
    expect(response.error).toContain("You have no credits remaining")
    expect(response.error).not.toMatch(/unclassified|no output generated/iu)
  })
})

describe("--help provider readiness", () => {
  function writeObservation(homeDir: string, body: string | Record<string, unknown>): void {
    const dir = join(homeDir, ".cache", "bearly-llm", "providers")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "google.json"), typeof body === "string" ? body : JSON.stringify(body))
  }

  function googleObservation(kind: string, observedAt: number, expiresAt: number): Record<string, unknown> {
    return {
      version: 1,
      observation: {
        provider: "google",
        status: "refusing",
        kind,
        source: "dispatch",
        reason: "google auth failed — check GOOGLE_GENERATIVE_AI_API_KEY.",
        observedAt,
        expiresAt,
      },
    }
  }

  function banner(env: { stdout: string[]; stderr: string[] }): string {
    return [...env.stdout, ...env.stderr].join("\n")
  }

  it("prints the last failure class and time for a live refusal, and the exclusion for a denied provider", async () => {
    const env = makeTestEnv()
    delete process.env.LLM_NO_CACHE
    process.env.RECALL_LLM_DENY_PROVIDERS = "openai"
    const observedAt = Date.now() - 60_000
    writeObservation(env.homeDir, googleObservation("auth", observedAt, Date.now() + 30 * 60_000))

    await runCli(["--help"])

    expect(banner(env)).toContain(`last call failed: auth at ${new Date(observedAt).toISOString()}`)
    expect(banner(env)).toContain("excluded by RECALL_LLM_DENY_PROVIDERS")
    expect(banner(env)).not.toMatch(/OpenAI\s+ready/u)
    expect(banner(env)).not.toMatch(/Google\s+ready/u)
  })

  it("still names an expired refusal as historical, never as ready", async () => {
    const env = makeTestEnv()
    delete process.env.LLM_NO_CACHE
    const observedAt = Date.now() - 2 * 60 * 60_000
    writeObservation(env.homeDir, googleObservation("auth", observedAt, Date.now() - 60 * 60_000))

    await runCli(["--help"])

    expect(banner(env)).toContain(`last call failed: auth at ${new Date(observedAt).toISOString()} (expired`)
    expect(banner(env)).not.toMatch(/Google\s+ready/u)
  })

  it("never says ready when the observation store cannot be read", async () => {
    const env = makeTestEnv()
    delete process.env.LLM_NO_CACHE
    writeObservation(env.homeDir, "{ this is not a stored observation")

    await runCli(["--help"])

    expect(banner(env)).toContain("unknown —")
    expect(banner(env)).toMatch(/unreadable/u)
    expect(banner(env)).not.toMatch(/Google\s+ready/u)
  })

  it("never says ready when the observation store is disabled", async () => {
    const env = makeTestEnv()
    // makeTestEnv sets LLM_NO_CACHE=1, which is exactly the disabled case.
    await runCli(["--help"])

    expect(banner(env)).toContain("unknown —")
    expect(banner(env)).toMatch(/disabled/u)
    expect(banner(env)).not.toMatch(/Google\s+ready/u)
  })

  it("never says ready when there is no observation for a keyed provider", async () => {
    const env = makeTestEnv()
    delete process.env.LLM_NO_CACHE

    await runCli(["--help"])

    expect(banner(env)).toContain("no provider observation found")
    expect(banner(env)).not.toMatch(/Google\s+ready/u)
  })
})
