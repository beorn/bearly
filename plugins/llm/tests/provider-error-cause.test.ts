/**
 * @failure An unclassified provider error loses its HTTP status, the provider's
 *          error code and message, the model and the panel slot, so a caller
 *          cannot tell a dead key, a rate limit and an outage apart (27038).
 * @level l2
 * @consumer llm pro recovery legs; any --json caller branching on provider_error
 * @testonly none
 *
 * Specimen: /hh/var/@dev10/26873/c-code-root-pro-deepseek-recovery.json — a
 * bounded DeepSeek recovery leg ended in 3 s with `provider_error` and
 * "OpenRouter dispatch failed: unclassified provider error", and the envelope,
 * stderr and saved report all omitted the status, the provider's own code and
 * message, and the slot the leg belonged to.
 *
 * No live call and no key: `ai` is mocked with the provider's response shape.
 */

import { describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeTestEnv, runCli } from "./helpers"

const generateTextMock = vi.fn()
const streamTextMock = vi.fn()
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: generateTextMock,
  streamText: streamTextMock,
}))

const queryBackgroundMock = vi.fn()
vi.mock("../src/lib/openai-deep", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/openai-deep")>("../src/lib/openai-deep")
  return { ...actual, queryOpenAIBackground: queryBackgroundMock }
})

/** OpenRouter's own shape: `error.code` is the HTTP status, upstream detail is under `metadata`. */
function openRouterError(body: Record<string, unknown>, status = 500): Error {
  return Object.assign(new Error("OpenRouter dispatch failed: unclassified provider error"), {
    status,
    responseBody: body,
  })
}

/** The pro path streams: streamText reports through onError and ends empty (28886). */
function mockStreamFailure(error: unknown): void {
  streamTextMock.mockReset()
  const finalStep = Promise.resolve({ usage: undefined })
  streamTextMock.mockImplementation((opts: { onError?: (event: { error: unknown }) => void }) => {
    opts.onError?.({ error })
    return {
      // The provider reported the failure and produced no text.
      textStream: {
        [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
      },
      usage: undefined,
      finalStep,
      finishReason: "error",
      rawFinishReason: "error",
    }
  })
  generateTextMock.mockReset()
  generateTextMock.mockRejectedValue(error)
}

async function runLeg(
  slot: string,
): Promise<{ env: ReturnType<typeof makeTestEnv>; envelope: Record<string, unknown> }> {
  const env = makeTestEnv()
  const result = await runCli([
    "pro",
    "--model",
    "deepseek/deepseek-chat",
    "--slot",
    slot,
    "--json",
    "--full-paths",
    "recover the missing opinion",
  ])
  expect(result.error, "the CLI must not crash past its own error path").toBeUndefined()
  expect(result.exited).toBe(1)
  const envelopeLine = env.stdout
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .at(-1)
  expect(envelopeLine, "one JSON envelope is emitted").toBeDefined()
  return { env, envelope: JSON.parse(envelopeLine!) as Record<string, unknown> }
}

describe("27038 an unclassified provider error keeps its cause", () => {
  it("carries the real OpenRouter body, the model and the slot into the envelope, stderr and the report", async () => {
    mockStreamFailure(
      openRouterError({
        error: {
          code: 500,
          message: "Provider returned error",
          metadata: {
            provider_name: "DeepSeek",
            raw: "upstream exploded while reading key sk-or-v1-0123456789abcdef",
          },
        },
      }),
    )
    const { env, envelope } = await runLeg("c")

    expect(envelope.code).toBe("provider_error")
    expect(envelope.slot).toBe("c")
    expect(envelope.model).toBe("DeepSeek Chat V3")
    expect(envelope.httpStatus).toBe(500)
    // OpenRouter's numeric error.code IS the status; it is never restated as a
    // provider code, which the honest absence shows (27038 review).
    expect(envelope.providerCode).toBeUndefined()
    const envelopeError = String(envelope.error)
    for (const needle of ["HTTP 500", "upstream exploded", "Provider returned error", "DeepSeek"]) {
      expect(envelopeError, `the envelope error names ${needle}`).toContain(needle)
    }
    expect(envelopeError).not.toContain("sk-or-v1-0123456789abcdef")
    expect(envelopeError).toContain("[REDACTED]")

    const stderr = env.stderr.join("\n")
    for (const needle of ["HTTP 500", "upstream exploded", "DeepSeek Chat V3", "Slot: c"]) {
      expect(stderr, `stderr names ${needle}`).toContain(needle)
    }
    expect(stderr).not.toContain("sk-or-v1-0123456789abcdef")

    const report = readFileSync(String(envelope.file), "utf8")
    for (const needle of ["HTTP 500", "upstream exploded", "DeepSeek Chat V3", "Slot**: c"]) {
      expect(report, `the saved report names ${needle}`).toContain(needle)
    }
    expect(report).not.toContain("sk-or-v1-0123456789abcdef")
  })

  it("carries a string error code from an OpenAI-compatible body into the envelope", async () => {
    mockStreamFailure(
      openRouterError({
        error: { code: "provider_internal", message: "upstream exploded while reading key sk-or-v1-0123456789abcdef" },
      }),
    )
    const { envelope } = await runLeg("a")

    expect(envelope.httpStatus).toBe(500)
    expect(envelope.providerCode).toBe("provider_internal")
    expect(String(envelope.error)).toContain("provider code provider_internal")
    expect(String(envelope.error)).not.toContain("sk-or-v1-0123456789abcdef")
  })

  it("redacts a secret that arrives as the provider's own code, on the envelope field as on the message", async () => {
    mockStreamFailure(
      openRouterError({
        error: { code: "sk-or-v1-0123456789abcdef", message: "bad credential" },
      }),
    )
    const { envelope } = await runLeg("d")

    expect(envelope.providerCode).toBe("[REDACTED]")
    expect(String(envelope.error)).not.toContain("sk-or-v1-0123456789abcdef")
    expect(String(envelope.error)).toContain("provider code [REDACTED]")
  })

  it("names the absence when the error carries no HTTP status, instead of dropping the cause silently", async () => {
    mockStreamFailure(Object.assign(new Error("socket closed before headers"), {}))
    const { env, envelope } = await runLeg("b")

    expect(envelope.slot).toBe("b")
    expect(String(envelope.error)).toContain("with no HTTP status")
    // The classifier drops unvetted raw text on purpose; what must never be
    // silent is that no status existed at all.
    expect(String(envelope.error)).not.toContain("unclassified provider error")
    expect(envelope.httpStatus).toBeUndefined()
    expect(envelope.providerCode).toBeUndefined()
    expect(env.stderr.join("\n")).toContain("Slot: b")
  })
})
