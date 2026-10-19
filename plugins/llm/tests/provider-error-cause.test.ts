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
vi.mock("ai", () => ({ generateText: generateTextMock, streamText: streamTextMock }))

const queryBackgroundMock = vi.fn()
vi.mock("../src/lib/openai-deep", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/openai-deep")>("../src/lib/openai-deep")
  return { ...actual, queryOpenAIBackground: queryBackgroundMock }
})

/** An unknown OpenRouter failure: a 500 with a body none of the known classes match. */
function unknownOpenRouterError(): Error {
  return Object.assign(new Error("OpenRouter dispatch failed: unclassified provider error"), {
    status: 500,
    responseBody: {
      error: {
        code: "provider_internal",
        message: "upstream exploded while reading key sk-or-v1-0123456789abcdef",
      },
    },
  })
}

describe("27038 an unclassified provider error keeps its cause", () => {
  it("carries status, provider code/message, model and slot into the envelope, stderr and the report", async () => {
    const env = makeTestEnv()
    // The pro path streams: streamText reports the provider error through
    // `onError` and ends the text stream empty, then the SDK rejects the
    // iteration with its evidence-free "no output generated" wrapper. Mock
    // that shape, not a thrown generateText rejection (28886).
    streamTextMock.mockReset()
    streamTextMock.mockImplementation((opts: { onError?: (event: { error: unknown }) => void }) => {
      let consumed = false
      return {
        textStream: (async function* () {
          if (!consumed) {
            consumed = true
            opts.onError?.({ error: unknownOpenRouterError() })
          }
        })(),
        usage: Promise.resolve(undefined),
        finishReason: Promise.resolve("error"),
        rawFinishReason: Promise.resolve("error"),
      }
    })
    generateTextMock.mockReset()
    generateTextMock.mockRejectedValue(unknownOpenRouterError())

    const result = await runCli([
      "pro",
      "--model",
      "deepseek/deepseek-chat",
      "--slot",
      "c",
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
    const envelope = JSON.parse(envelopeLine!) as Record<string, unknown>

    expect(envelope.code).toBe("provider_error")
    expect(envelope.slot).toBe("c")
    expect(envelope.model).toBe("DeepSeek Chat V3")
    expect(envelope.httpStatus).toBe(500)
    expect(envelope.providerCode).toBe("provider_internal")
    const envelopeError = String(envelope.error)
    for (const needle of ["HTTP 500", "provider_internal", "upstream exploded"]) {
      expect(envelopeError, `the envelope error names ${needle}`).toContain(needle)
    }
    expect(envelopeError).not.toContain("sk-or-v1-0123456789abcdef")
    expect(envelopeError).toContain("[REDACTED]")

    const stderr = env.stderr.join("\n")
    for (const needle of ["HTTP 500", "provider_internal", "upstream exploded", "DeepSeek Chat V3", "Slot: c"]) {
      expect(stderr, `stderr names ${needle}`).toContain(needle)
    }
    expect(stderr).not.toContain("sk-or-v1-0123456789abcdef")

    const report = readFileSync(String(envelope.file), "utf8")
    for (const needle of ["HTTP 500", "provider_internal", "upstream exploded", "DeepSeek Chat V3", "Slot**: c"]) {
      expect(report, `the saved report names ${needle}`).toContain(needle)
    }
    expect(report).not.toContain("sk-or-v1-0123456789abcdef")
  })
})
