/**
 * 29325: a failed STORED response loses its provider cause across the
 * await/recover rails, and `recover` exits 0 where `await` exits 1.
 *
 * Specimen (recorded live 2026-10-14, metadata only, no key):
 * /hh/var/@dev10/28925/turn369-provider-failure.json — reading a stored OpenAI
 * response through the declared SDK returns
 *   { status: "failed",
 *     error: { code: "credit_balance_exhausted",
 *              message: "You have no credits remaining. Add credits…" },
 *     usage: null, output: [] }
 *
 * Two defects:
 *   (a) openai-deep.ts `retrieveResponse` omits `response.error` from its
 *       normalized return, so a failed stored response reads as
 *       `{ status: "failed", content: "" }` with no cause; `llm await` then
 *       prints only "Response failed".
 *   (b) recover.ts's classifyRecovery "failed" branch prints the status, deletes
 *       the partial, and returns — the process exits 0 — while runAwait emits the
 *       same failure and exits 1.
 *
 * No live call, no credits spent, no key printed: the SDK client is mocked with
 * the recorded payload.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { makeTestEnv } from "./helpers"

const { retrieveMock } = vi.hoisted(() => ({ retrieveMock: vi.fn() }))

vi.mock("openai", () => ({
  default: class {
    responses = { retrieve: retrieveMock }
  },
}))

const RESPONSE_ID = "resp_077c50b9cbe3e70f006acf8ab4445087d1b1e2c0541035f882"

/** The recorded failed stored response (metadata only; no key). */
function recordedFailedResponse() {
  return {
    status: "failed",
    error: {
      code: "credit_balance_exhausted",
      message:
        "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
    },
    usage: null,
    output: [],
  }
}

describe("29325 a failed stored response keeps its provider cause", () => {
  let env: ReturnType<typeof makeTestEnv>

  beforeEach(() => {
    env = makeTestEnv()
    retrieveMock.mockReset()
    retrieveMock.mockResolvedValue(recordedFailedResponse())
  })

  it("(a) retrieveResponse surfaces the provider code and message", async () => {
    const { retrieveResponse } = await import("../src/lib/openai-deep")
    const result = await retrieveResponse(RESPONSE_ID)
    expect(result.status).toBe("failed")
    expect(result.error, "a failed response must carry the provider cause").toBeDefined()
    expect(result.error).toContain("credit_balance_exhausted")
    expect(result.error).toContain("no credits remaining")
  })

  it("(a) `llm await` names the cause instead of only 'Response failed'", async () => {
    const { runAwait } = await import("../src/cmd/recover")
    await expect(runAwait({ responseId: RESPONSE_ID })).rejects.toThrow(/__exit_1/)
    const emitted = env.stderr.join("\n") + "\n" + env.stdout.join("\n")
    expect(emitted).toContain("credit_balance_exhausted")
    expect(emitted).toContain("no credits remaining")
  })

  it("(b) recover's terminal on a failed stored response is non-zero and named", async () => {
    const { runRecover } = await import("../src/cmd/recover")
    await expect(
      runRecover({ responseId: RESPONSE_ID, clean: false, cleanStale: false, includeAll: false }),
    ).rejects.toThrow(/__exit_1/)
    expect(env.exitCodes, "recover must exit non-zero on a failed response").toEqual([1])
    const emitted = env.stderr.join("\n") + "\n" + env.stdout.join("\n")
    expect(emitted).toContain("credit_balance_exhausted")
  })
})
