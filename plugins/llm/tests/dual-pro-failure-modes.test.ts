/**
 * @failure Failed judge output loses its cause/content or suppresses surviving opinions.
 * @level l3
 * @consumer llm pro
 *
 * Regression: dual-pro must normalize empty-content fulfilled promises as
 * failures, and must exit non-zero when both legs fail.
 *
 * Bugs fixed:
 *   1. Empty-content normalization — a fulfilled promise with `content: ""`
 *      (reasoning-exhaustion, aborted stream, provider quirk) was treated as
 *      success. Progress line said ✓ while the combined report said ⚠️ Failed.
 *      Now (dispatch.ts:~1126) gptOk/kimiOk require non-empty trimmed content
 *      AND no error.
 *   2. Both-fail exit code — previously exited 0, masking every catastrophic
 *      run. Now exits 1 with a "Both dual-pro legs failed" stderr line
 *      (dispatch.ts:~1197).
 *
 * The A/B log line's `ok: false` field is verified by reading the jsonl file
 * the run appended to under an isolated HOME.
 */

import { describe, it, expect, vi } from "vitest"
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { makeTestEnv, runCli } from "./helpers"
import { execFileSync } from "node:child_process"
import type { ModelResponse } from "../src/lib/types"
import { getMemoryDir } from "../src/lib/dual-pro"

const generateTextMock = vi.fn()
const streamTextMock = vi.fn()

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: generateTextMock,
  streamText: streamTextMock,
}))

// GPT leg in dual-pro now routes through queryOpenAIBackground (Responses
// API) for recoverability. Mock it here; Kimi leg still uses generateText.
const queryBackgroundMock = vi.fn()
vi.mock("../src/lib/openai-deep", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/openai-deep")>("../src/lib/openai-deep")
  return {
    ...actual,
    queryOpenAIBackground: queryBackgroundMock,
  }
})

function abProLogPath(home: string): string {
  return join(getMemoryDir({ ...process.env, HOME: home }), "ab-pro.jsonl")
}

async function runDualPro(outputFile?: string, maxOutputTokens?: number, contextFiles: readonly string[] = []) {
  vi.resetModules()
  // --no-challenger keeps these tests focused on the legacy 2-leg failure
  // modes. The 3-leg path (km-bearly.llm-dual-pro-shadow-test) has its own
  // suite in dual-pro-shadow.test.ts.
  // --full-paths so envelope.file is the absolute path — tests below
  // readFileSync(envelope.file). Default mode (km-bearly.llm-path-leakage)
  // emits a basename only.
  process.argv = [
    "node",
    "cli.ts",
    "pro",
    "-y",
    "--no-challenger",
    "--full-paths",
    ...(outputFile ? ["--output", outputFile] : []),
    ...(maxOutputTokens === undefined ? [] : ["--max-output-tokens", String(maxOutputTokens)]),
    ...contextFiles.flatMap((path) => ["--context-file", path]),
    "test question",
  ]
  const mod = await import("../src/cli")
  try {
    await mod.main()
  } catch (e) {
    // process.exit mock throws; that's fine — still return.
    if (!(e as Error).message.startsWith("__exit_")) throw e
  }
}

describe("dual-pro failure modes", () => {
  /** @failure A targeted retry drops determining source files (29904), overwrites the paid panel, or puts long opinions in argv.
   * @level l1 @consumer Callers recovering one affordable Pro leg or judge pair. */
  it.each(["opinion", "judge", "empty-opinion", "empty-opinion-with-bound", "token-stopped-opinion"] as const)(
    "preserves the panel and source context when executing the %s retry",
    async (refused) => {
      const env = makeTestEnv()
      process.env.LLM_JUDGE_MODEL = "gemini-3-flash-preview"
      const outputFile = join(env.tmpDir, "original's panel.txt")
      const contextFiles = [join(env.tmpDir, "source's context.md"), join(env.tmpDir, "second context.md")]
      for (const path of contextFiles) writeFileSync(path, "DETERMINING_SOURCE_EVIDENCE")
      const emptyOpinion = refused.startsWith("empty-opinion")
      const tokenStopped = refused === "token-stopped-opinion"
      const requestedBound = refused === "empty-opinion-with-bound" || tokenStopped ? 3500 : undefined
      const firstOpinion = "SURVIVING_FIRST_OPINION " + "a".repeat(70000)
      const secondOpinion = "SURVIVING_SECOND_OPINION " + "b".repeat(70000)
      queryBackgroundMock.mockReset().mockResolvedValue({
        model: { displayName: "GPT-5.4 Pro" },
        content: firstOpinion,
        responseId: "resp_preserved",
        durationMs: 10,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      })
      const refusal = Object.assign(new Error("You requested up to 65536 tokens, but can only afford 2048."), {
        statusCode: 402,
      })
      generateTextMock.mockReset()
      if (refused === "judge") {
        generateTextMock.mockResolvedValueOnce({
          text: secondOpinion,
          finalStep: { reasoningText: undefined },
          usage: { inputTokens: 10, outputTokens: 20 },
        })
      }
      if (tokenStopped) {
        generateTextMock.mockResolvedValue({
          text: "RETAINED_PARTIAL_OPINION",
          finishReason: "length",
          rawFinishReason: "max_output_tokens",
          finalStep: { reasoningText: undefined },
          usage: { inputTokens: 10, outputTokens: 5 },
        })
      } else if (emptyOpinion) {
        generateTextMock.mockResolvedValue({ text: "", usage: { inputTokens: 10, outputTokens: 0 } })
      } else {
        generateTextMock.mockRejectedValue(refusal)
      }
      await runDualPro(outputFile, requestedBound, contextFiles)
      const original = readFileSync(outputFile)
      expect(original.toString()).toContain("SURVIVING_FIRST_OPINION")
      const followUpLine = env.stderr.find((line) => line.includes("follow-up="))
      if (!followUpLine) throw new Error("Pro did not emit a targeted follow-up")
      if (tokenStopped) {
        const envelope = JSON.parse(env.stdout.filter((line) => line.startsWith("{")).at(-1)!)
        expect(envelope).toMatchObject({
          b: {
            status: "incomplete",
            finishReason: "length",
            rawFinishReason: "max_output_tokens",
            appliedMaxOutputTokens: requestedBound,
          },
        })
        expect(original.toString()).toContain("RETAINED_PARTIAL_OPINION")
        expect(original.toString()).toContain("max_output_tokens")
        expect(env.stderr.join("\n")).toContain("same bound will stop again")
        expect(env.stderr.join("\n")).toContain("--max-output-tokens")
        expect(env.stderr.join("\n")).not.toContain("account-balance")
      } else if (!emptyOpinion) {
        expect(env.stderr.join("\n")).toContain("account-balance")
        expect(followUpLine).toContain("2048")
      }
      const retry = /follow-up=(.*); do not rerun/.exec(followUpLine)?.[1]
      if (!retry) throw new Error("Pro follow-up did not include its runnable retry")
      const argv = execFileSync("bash", ["-c", `set -- ${retry}; printf '%s\\0' "$@"`])
        .toString()
        .split("\0")
        .filter(Boolean)
      expect(argv).not.toContain("--output")
      expect(argv.every((arg) => Buffer.byteLength(arg) < 32768)).toBe(true)
      if (refused === "judge") {
        expect(argv).toContain("--context-file")
        expect(argv).toContain(outputFile)
        expect(argv.at(-1)).toMatch(/pair.*ab|pairs.*ab/)
        expect(argv.at(-1)).toContain("Rubric:")
        expect(argv.at(-1)).not.toContain("SURVIVING_FIRST_OPINION")
      }
      if (refused !== "judge") {
        const retryFiles = argv.flatMap((arg, index) => (arg === "--context-file" ? [argv[index + 1]] : []))
        expect(retryFiles).toEqual(expect.arrayContaining(contextFiles))
        if (emptyOpinion || tokenStopped) expect(retryFiles).toEqual([...contextFiles, outputFile])
        expect(argv.at(-1)).toBe("test question")
      }
      streamTextMock.mockReset().mockImplementation(() => ({
        textStream: (async function* () {
          yield "recovered opinion or judge"
        })(),
        finalStep: Promise.resolve({ response: undefined }),
        usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
      }))
      const siblingCalls = queryBackgroundMock.mock.calls.length
      const sdkCalls = generateTextMock.mock.calls.length
      const retryResult = await runCli(argv.slice(2))
      expect(retryResult.error).toBeUndefined()
      expect(retryResult.exited).toBeUndefined()
      expect(streamTextMock).toHaveBeenCalledOnce()
      expect(queryBackgroundMock).toHaveBeenCalledTimes(siblingCalls)
      expect(generateTextMock).toHaveBeenCalledTimes(sdkCalls)
      const retryCall = streamTextMock.mock.calls.at(-1)![0]
      if (emptyOpinion || tokenStopped) {
        if (requestedBound !== undefined) expect(retryCall.maxOutputTokens).toBe(requestedBound)
        else expect(argv).not.toContain("--max-output-tokens")
      } else {
        expect(retryCall.maxOutputTokens).toBe(2048)
      }
      if (refused !== "judge") expect(JSON.stringify(retryCall)).toContain("DETERMINING_SOURCE_EVIDENCE")
      expect(readFileSync(outputFile)).toEqual(original)
    },
  )

  it("empty-content from GPT side is surfaced as failure", async () => {
    const env = makeTestEnv()

    // GPT leg routes through queryOpenAIBackground (Responses API) since
    // km-infra.llm-fire-and-forget-pro; K2.6 still uses generateText.
    // Empty content is the fulfilled-but-empty regression case: progress
    // line should say ✗, combined report should say "⚠️  Failed".
    queryBackgroundMock.mockReset()
    queryBackgroundMock.mockResolvedValueOnce({
      model: { displayName: "GPT-5.4 Pro" },
      content: "",
      responseId: "resp_empty_regression",
      usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
      durationMs: 100,
    })
    generateTextMock.mockReset()
    generateTextMock.mockResolvedValueOnce({
      text: "Kimi's answer",
      finalStep: { reasoningText: undefined },
      usage: { inputTokens: 10, outputTokens: 20 },
    })

    await runDualPro()

    // The ✗ line must appear in stderr. Matches the literal emitted in
    // dispatch.ts:~1132: "  ✗ GPT-5.4 Pro: empty content"
    const stderrAll = env.stderr.join("\n")
    expect(stderrAll).toMatch(/✗\s+GPT-5\.4 Pro:\s+empty content/)

    // The combined report (written via finalizeOutput to stdout as JSON
    // envelope + the file) must contain "⚠️  Failed" for GPT. We inspect the
    // final rendered content by reading the produced file from the stdout JSON.
    const jsonLine = env.stdout.find((l) => l.trim().startsWith("{") && l.includes('"file"'))
    expect(jsonLine).toBeDefined()
    const envelope = JSON.parse(jsonLine!) as { file: string }
    const reportText = readFileSync(envelope.file, "utf-8")
    expect(reportText).toMatch(/⚠️\s+Failed/)

    // A/B log: gpt.ok must be false.
    const abPath = abProLogPath(env.homeDir)
    expect(existsSync(abPath)).toBe(true)
    const abLine = readFileSync(abPath, "utf-8").trim().split("\n").pop()!
    const ab = JSON.parse(abLine) as { gpt: { ok: boolean }; kimi: { ok: boolean } }
    expect(ab.gpt.ok).toBe(false)
    expect(ab.kimi.ok).toBe(true)
  }, 10_000)

  // Failed scoring must preserve usable opinions and the exact judge response,
  // not collapse a paid provider call into the old "unparseable" placeholder.
  it.each([false, true])(
    "retains failed-judge diagnostics and both opinions (artifact write fails: %s)",
    async (writeFails) => {
      const env = makeTestEnv()
      process.env.LLM_JUDGE_MODEL = "gemini-3-flash-preview"
      const outputFile = join(env.tmpDir, "review.txt")
      const artifactPath = `${outputFile}.judge-ab.json`
      if (writeFails) mkdirSync(artifactPath)
      const content = JSON.stringify({ winner: "C", scoreA: null, scoreB: null, reasoning: "λ".repeat(5000) })
      queryBackgroundMock.mockReset()
      queryBackgroundMock.mockResolvedValueOnce({
        model: { displayName: "GPT-5.4 Pro" },
        content: "first unranked opinion",
        responseId: "resp_opinion",
        durationMs: 10,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      })
      generateTextMock.mockReset()
      generateTextMock.mockResolvedValueOnce({
        text: "second unranked opinion",
        finalStep: { reasoningText: undefined },
        usage: { inputTokens: 10, outputTokens: 20 },
      })
      generateTextMock.mockResolvedValue({
        text: content,
        finalStep: { reasoningText: undefined },
        usage: { inputTokens: 50, outputTokens: 60 },
      })

      await runDualPro(outputFile)

      const diagnostic = env.stderr.join("\n")
      expect(diagnostic).toContain("schema")
      expect(diagnostic).toContain("winner")
      expect(diagnostic).toContain(artifactPath)
      expect(diagnostic.length).toBeLessThan(6000)
      expect(diagnostic).not.toContain("λ".repeat(100))
      if (writeFails) {
        expect(diagnostic).toContain(`failed to preserve response at ${artifactPath}`)
        expect(diagnostic).not.toContain("complete response and cause:")
      } else {
        const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
          response: ModelResponse
          pair: string
          failure: { kind: string }
          unavailableMetadata: string[]
        }
        expect(Buffer.from(artifact.response.content)).toEqual(Buffer.from(content))
        expect(artifact.pair).toBe("ab")
        expect(artifact.failure.kind).toBe("schema")
        expect(artifact.response.usage).toMatchObject({ promptTokens: 50, completionTokens: 60 })
        expect(artifact.response.model.provider).toBe("openrouter")
        expect(artifact.unavailableMetadata).toContain("responseId")
        expect(artifact.unavailableMetadata).toContain("finishReason")
      }
      const report = readFileSync(outputFile, "utf8")
      expect(report).toContain("first unranked opinion")
      expect(report).toContain("second unranked opinion")
      const ab = JSON.parse(readFileSync(abProLogPath(env.homeDir), "utf8").trim()) as {
        judge: { error: string; winner?: string }
        a: { content: string }
        b: { content: string }
      }
      expect(ab.judge.error).toContain(artifactPath)
      expect(ab.judge.winner).toBeUndefined()
      expect(ab.a.content).toBe("first unranked opinion")
      expect(ab.b.content).toBe("second unranked opinion")
      expect(env.exitCodes).toContain(1)
    },
    10_000,
  )

  it("both legs failing exits 1 with diagnostic stderr", async () => {
    const env = makeTestEnv()

    queryBackgroundMock.mockReset()
    queryBackgroundMock.mockRejectedValueOnce(new Error("OpenAI 500"))
    generateTextMock.mockReset()
    generateTextMock.mockRejectedValueOnce(new Error("OpenRouter 503"))

    await runDualPro()

    // The CLI calls process.exit(1) when both legs fail. Our mock captures the
    // code and throws __exit_1, which runDualPro swallows.
    expect(env.exitCodes).toContain(1)

    const stderrAll = env.stderr.join("\n")
    expect(stderrAll).toMatch(/Both dual-pro legs failed/)

    // A/B log still written (post-mortem record) with both ok=false.
    const abPath = abProLogPath(env.homeDir)
    expect(existsSync(abPath)).toBe(true)
    const ab = JSON.parse(readFileSync(abPath, "utf-8").trim()) as { gpt: { ok: boolean }; kimi: { ok: boolean } }
    expect(ab.gpt.ok).toBe(false)
    expect(ab.kimi.ok).toBe(false)
  }, 10_000)

  it("LLM_DUAL_PRO_B=<unknown> refuses before dispatch with the unknown model named", async () => {
    const env = makeTestEnv()
    process.env.LLM_DUAL_PRO_B = "this-model-does-not-exist"
    try {
      // Invalid requested-panel configuration must refuse before any paid call.
      queryBackgroundMock.mockReset()
      queryBackgroundMock.mockResolvedValueOnce({
        model: { displayName: "GPT-5.4 Pro" },
        content: "single-model answer",
        responseId: "resp_single",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        durationMs: 100,
      })
      generateTextMock.mockReset()

      await expect(runDualPro()).rejects.toThrow("Dual-pro mainstay is not registered: this-model-does-not-exist")

      // The entry point refuses before either provider can be called.
      expect(queryBackgroundMock).not.toHaveBeenCalled()
      expect(generateTextMock).not.toHaveBeenCalled()

      // No panel was dispatched, so there is no A/B log.
      const abPath = abProLogPath(env.homeDir)
      expect(existsSync(abPath)).toBe(false)
    } finally {
      delete process.env.LLM_DUAL_PRO_B
    }
  }, 10_000)

  // Specimen /hh/var/@dev6/1179-pro-logging-report.txt.judge-ab.json:
  // Gemini omitted scoreA.scores.correctness (wrote "output" instead).
  // AC1: retry once with that validation error named; a second miss fails
  // naming the field and keeps both opinions.
  it("retries a schema-miss judge once naming the missing field, then keeps both opinions", async () => {
    const env = makeTestEnv()
    process.env.LLM_JUDGE_MODEL = "gemini-3-flash-preview"
    const outputFile = join(env.tmpDir, "review.txt")
    const specimenJudge = JSON.stringify({
      scoreA: {
        scores: { specificity: 4, actionability: 3, output: 3, depth: 3 },
        total: 13,
      },
      scoreB: {
        scores: { specificity: 5, actionability: 5, correctness: 5, depth: 5 },
        total: 20,
      },
      winner: "B",
      reasoning:
        "Response B provides concrete code primitives, a systematic trade-off table, and a deep architectural understanding of the logging durability requirements requested.",
    })
    queryBackgroundMock.mockReset()
    queryBackgroundMock.mockResolvedValueOnce({
      model: { displayName: "GPT-5.4 Pro" },
      content: "first unranked opinion",
      responseId: "resp_opinion",
      durationMs: 10,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    })
    generateTextMock.mockReset()
    generateTextMock.mockResolvedValueOnce({
      text: "second unranked opinion",
      finalStep: { reasoningText: undefined },
      usage: { inputTokens: 10, raw: { cost_usd: 0, invoice: "partial-panel" } },
    })
    generateTextMock.mockResolvedValue({
      text: specimenJudge,
      finalStep: { reasoningText: undefined },
      usage: { inputTokens: 50, outputTokens: 60 },
    })

    await runDualPro(outputFile, 4096)

    const judgeCalls = generateTextMock.mock.calls.filter((call) => {
      const text = JSON.stringify(call[0] ?? {})
      return text.includes("STRICT JSON") || text.includes("Score each response")
    })
    expect(judgeCalls).toHaveLength(2)
    // The caller's reservation covers opinions, pairwise judging, and schema retry.
    expect(generateTextMock.mock.calls.every((call) => call[0].maxOutputTokens === 4096)).toBe(true)
    expect(queryBackgroundMock.mock.calls[0]![0].maxOutputTokens).toBe(4096)
    // The live Pro log must describe this requested reservation, rather than
    // displaying a model's much larger context capacity as the output cap.
    const budgets = env.stderr.filter((line) => line.includes("output budget:"))
    expect(budgets).toHaveLength(2)
    expect(budgets.every((line) => line.endsWith("4096 tokens (requested)"))).toBe(true)
    expect(JSON.stringify(judgeCalls[1]?.[0] ?? {})).toContain("scoreA.scores.correctness")
    const report = readFileSync(outputFile, "utf8")
    expect(report).toContain("first unranked opinion")
    expect(report).toContain("second unranked opinion")
    expect(report).toContain("scoreA.scores.correctness")
    // One invoked opinion has no output/total counts: a known peer cannot fill
    // those gaps, and the per-leg raw receipt must survive the panel serializer.
    const envelope = JSON.parse(env.stdout.filter((line) => line.trim().startsWith("{")).at(-1)!)
    expect(envelope).toHaveProperty("tokens", { prompt: 20 })
    expect(envelope).toHaveProperty("b.tokens", { prompt: 10 })
    expect(envelope).toHaveProperty("b.usage.raw", { cost_usd: 0, invoice: "partial-panel" })
    expect(envelope).toHaveProperty("b.cost_usd", 0)
    expect(report).toContain("unknown tokens")
    const ab = JSON.parse(readFileSync(abProLogPath(env.homeDir), "utf8").trim()) as {
      judge: { error: string; winner?: string }
      a: { content: string }
      b: { content: string }
    }
    expect(ab.judge.error).toContain("scoreA.scores.correctness")
    expect(ab.judge.winner).toBeUndefined()
    expect(ab.a.content).toBe("first unranked opinion")
    expect(ab.b.content).toBe("second unranked opinion")
    expect(env.exitCodes).toContain(1)
  }, 10_000)
})
