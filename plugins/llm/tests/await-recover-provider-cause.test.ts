/**
 * @failure  a failed STORED response loses its provider cause, and `llm recover`
 *           reports success (exit 0) where `llm await` exits 1, so a caller
 *           cannot tell a failed response from a finished one.
 * @level    l1
 * @consumer @hh/tooling/29325-llm-await-recover-lose-provider-cause
 * @testonly none
 *
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

  // The error-only cases below cannot catch a paid failure losing its receipt
  // or recovery deleting the only durable copy of that original charge.
  it.each(["failed", "cancelled", "expired", "incomplete", "completed", "error", "aborted"])(
    "both commands retain a billed %s response and its saved receipt",
    async (status) => {
      vi.resetModules()
      const persistence = await import("../src/lib/persistence")
      const path = persistence.getPartialPath(RESPONSE_ID)
      const raw = { input_tokens: 20, output_tokens: 8, total_tokens: 28, cost_usd: 0, invoice: "failed-original" }
      const savedUsage = {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        raw: { invoice: "last-saved", cost_usd: 0 },
      }
      persistence.writePartialHeader(path, {
        responseId: RESPONSE_ID,
        model: "GPT-5.4 Pro",
        modelId: "gpt-5.4-pro",
        topic: "paid failure",
        startedAt: new Date().toISOString(),
        usage: savedUsage,
        cost_usd: 0,
      })
      persistence.appendPartial(path, "unfinished body")
      if (status === "aborted") {
        retrieveMock.mockImplementation(async () => {
          process.emit("SIGINT")
          return { status: "in_progress", output: [], usage: raw }
        })
      } else if (status === "error") retrieveMock.mockRejectedValue(new Error("retrieval unavailable"))
      else retrieveMock.mockResolvedValue({ status, output: [], usage: raw })
      const { setJsonMode } = await import("../src/lib/output-mode")
      setJsonMode(true)
      const { runAwait, runRecover } = await import("../src/cmd/recover")
      for (const command of ["await", "recover"]) {
        env.stdout.length = 0
        const run =
          command === "await"
            ? runAwait({ responseId: RESPONSE_ID })
            : runRecover({ responseId: RESPONSE_ID, clean: false, cleanStale: false, includeAll: false })
        await expect(run).rejects.toThrow(status === "aborted" && command === "recover" ? "__exit_130" : "__exit_1")
        const lines = env.stdout.filter((line) => line.trim().startsWith("{"))
        expect(lines).toHaveLength(1)
        const envelope = JSON.parse(lines[0]!)
        expect(envelope).toMatchObject({
          status: "failed",
          responseId: RESPONSE_ID,
          cost_usd: 0,
          usage: { raw: status === "error" ? savedUsage.raw : raw },
        })
        const saved = persistence.findPartialByResponseId(RESPONSE_ID)
        expect(saved?.metadata.cost_usd).toBe(0)
        expect(saved?.metadata.usage?.raw).toEqual(status === "error" ? savedUsage.raw : raw)
        expect(saved?.metadata.completedAt).toBeUndefined()
        expect(saved?.content).toContain("unfinished body")
      }
      expect(retrieveMock).toHaveBeenCalledTimes(2)
    },
  )

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

  it("(b2) recover --json prints exactly one failed envelope on stdout naming the cause", async () => {
    const { setJsonMode } = await import("../src/lib/output-mode")
    setJsonMode(true)
    const { runRecover } = await import("../src/cmd/recover")
    await expect(
      runRecover({ responseId: RESPONSE_ID, clean: false, cleanStale: false, includeAll: false }),
    ).rejects.toThrow(/__exit_1/)
    expect(env.exitCodes, "recover --json must exit non-zero on a failed response").toEqual([1])
    const envelopeLines = env.stdout.filter((line) => line.trim().startsWith("{"))
    expect(envelopeLines, "recover --json prints exactly one JSON envelope on stdout").toHaveLength(1)
    // A malformed envelope must fail loudly here rather than be swallowed.
    const envelope = JSON.parse(envelopeLines[0]!) as Record<string, unknown>
    expect(envelope.status).toBe("failed")
    expect(envelope.responseId).toBe(RESPONSE_ID)
    expect(String(envelope.error)).toContain("Response failed")
    expect(String(envelope.error)).toContain("credit_balance_exhausted")
    expect(String(envelope.error)).toContain("no credits remaining")
  })
})
