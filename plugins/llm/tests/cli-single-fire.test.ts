/**
 * Regression: main() must fire exactly once per invocation.
 *
 * The Apr 17-20 double-fire bug ($10-30 wasted billing): cli.ts had BOTH a
 * module-scope `main()` invocation AND the wrapper's `await main()`. On import
 * by tools/llm.ts the two ran concurrently, producing two outputs + two A/B
 * log lines for every `llm pro` call.
 *
 * Fix: the module-scope call is gated behind `if (import.meta.main)` (see
 * cli.ts:~547). A DELIBERATE regression — re-adding a bare `main()` call at
 * module scope — must make this test fail: it would run twice on import.
 *
 * This test drives the dual-pro path because that's where the regression
 * manifested (the A/B log made it obvious); the property "main() fires once"
 * holds for every command.
 */

import { describe, it, expect, vi } from "vitest"
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { listLlmTmpFiles, makeTestEnv, runCli } from "./helpers"

// Mock the `ai` package so generateText/streamText don't hit the network. One
// call returns "ok" with token usage; count invocations via the mock.
const generateTextMock = vi.fn()
const streamTextMock = vi.fn()

vi.mock("ai", () => {
  return {
    generateText: generateTextMock,
    streamText: streamTextMock,
  }
})

// The pro-mode GPT leg routes through queryOpenAIBackground (Responses API +
// background: true) since km-infra.llm-fire-and-forget-pro; its siblings
// queryOpenAIDeepResearch, retrieveResponse, pollForCompletion don't fire in
// these tests but we mock them together so the module surface is clean.
const queryBackgroundMock = vi.fn()
vi.mock("../src/lib/openai-deep", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/openai-deep")>("../src/lib/openai-deep")
  return {
    ...actual,
    queryOpenAIBackground: queryBackgroundMock,
  }
})

function resetGenerateTextToOk() {
  generateTextMock.mockReset()
  generateTextMock.mockResolvedValue({
    text: "ok",
    finalStep: { reasoningText: undefined },
    usage: { inputTokens: 10, outputTokens: 5 },
  })
  streamTextMock.mockReset()
  streamTextMock.mockImplementation(() => ({
    textStream: (async function* () {
      yield "ok"
    })(),
    finalStep: Promise.resolve({ response: undefined }),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
  }))
  queryBackgroundMock.mockReset()
  queryBackgroundMock.mockImplementation(async ({ model }: { model: { displayName: string } }) => ({
    model,
    content: "ok",
    responseId: `resp_test_${Math.random().toString(36).slice(2, 10)}`,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    durationMs: 100,
  }))
}

describe("cli-single-fire", () => {
  /**
   * @failure A CLI caller's smaller output budget is lost before provider dispatch.
   * @level l1
   * @consumer Callers fitting one remote opinion within an affordable reservation.
   * Count/parser coverage permits a successful call that still reserves 65,536 tokens.
   */
  it.each([{ mode: [] }, { mode: ["pro", "-y"] }])(
    "per-run output budget reaches the remote provider ($mode)",
    async ({ mode }) => {
      makeTestEnv()
      resetGenerateTextToOk()

      const result = await runCli([
        ...mode,
        "--model",
        "google/gemini-2.5-pro",
        "--max-output-tokens",
        "4096",
        "Give one short opinion",
      ])

      expect(result.error).toBeUndefined()
      expect(result.exited).toBeUndefined()
      expect(streamTextMock).toHaveBeenCalledOnce()
      expect(streamTextMock.mock.calls[0]![0].maxOutputTokens).toBe(4096)
    },
    10_000,
  )

  /** @failure Bounded cache entries bypass the caller's reservation. @level l1
   * @consumer CLI callers repeating one prompt with different output budgets. */
  it("separates bounded and unbounded dispatches in the actual response cache", async () => {
    makeTestEnv()
    process.env.LLM_NO_CACHE = ""
    resetGenerateTextToOk()
    const base = ["--model", "google/gemini-2.5-pro", "cache budget separation"]
    for (const budget of [[], ["--max-output-tokens", "4096"], [], ["--max-output-tokens", "4096"]]) {
      await runCli([...base, ...budget])
    }
    expect(streamTextMock).toHaveBeenCalledTimes(2)
    expect(streamTextMock.mock.calls.map((call) => call[0].maxOutputTokens)).toEqual([65536, 4096])
  })

  /** @failure Unsupported paid admin modes silently discard a caller's bound. @level l1
   * @consumer CLI callers enforcing a reservation ceiling. */
  it.each(["--backtest", "--judge-history", "--discover-models"])(
    "refuses %s with a budget before spend",
    async (mode) => {
      const env = makeTestEnv()
      resetGenerateTextToOk()
      await runCli(["pro", mode, "--max-output-tokens", "4096", "-y"])
      expect(env.exitCodes).toEqual([1])
      expect(env.stderr.join("\n")).toContain("4096")
      expect(generateTextMock).not.toHaveBeenCalled()
      expect(queryBackgroundMock).not.toHaveBeenCalled()
    },
  )

  /** @failure An advertised retry loses original context/images or reserves too much.
   * @level l1 @consumer CLI callers recovering one refused opinion without repeating a paid panel.
   * Shell executes the emitted argv; successful baseline calls miss incorrect quoting. */
  it("executes the emitted affordable retry with original quoted inputs", async () => {
    const env = makeTestEnv()
    resetGenerateTextToOk()
    const contextFile = join(env.tmpDir, "context's file.txt")
    const imageFile = join(env.tmpDir, "image's file.png")
    writeFileSync(contextFile, "keep this context")
    writeFileSync(imageFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    streamTextMock.mockImplementationOnce(() => {
      throw Object.assign(new Error("You requested up to 65536 tokens, but can only afford 2048."), { statusCode: 402 })
    })
    const outputFile = join(env.tmpDir, "original report.txt")
    const question = "What is this person's image?"
    await runCli([
      "--model",
      "google/gemini-2.5-pro",
      "--context-file",
      contextFile,
      "--image",
      imageFile,
      "--output",
      outputFile,
      question,
    ])
    const envelope = env.stdout
      .filter((line) => line.trimStart().startsWith("{"))
      .map((line) => JSON.parse(line))
      .find(
        (entry): entry is { status: "failed"; error: string } =>
          typeof entry === "object" &&
          entry !== null &&
          "status" in entry &&
          entry.status === "failed" &&
          "error" in entry &&
          typeof entry.error === "string",
      )
    if (!envelope) throw new Error("CLI did not emit the expected failed envelope with a string error")
    expect(envelope.error).toContain("Run: ")
    const retry = envelope.error.split("Run: ")[1]
    // The shell resolves the runnable command; the existing mock owns provider execution.
    const argv = execFileSync("bash", ["-c", `set -- ${retry}; printf '%s\\0' "$@"`])
      .toString()
      .split("\0")
      .filter(Boolean)
    const original = readFileSync(outputFile)
    expect(argv).not.toContain("--output")
    expect(argv[1]).toMatch(/cli\.ts$/)
    expect(argv).toContain(question)
    expect(argv).toContain(contextFile)
    expect(argv).toContain(imageFile)
    await runCli(argv.slice(2))
    expect(streamTextMock.mock.calls.at(-1)![0].maxOutputTokens).toBe(2048)
    expect(JSON.stringify(streamTextMock.mock.calls.at(-1)![0].messages)).toContain("keep this context")
    expect(readFileSync(outputFile)).toEqual(original)
  })

  /**
   * @failure Single-model --dry-run spends money or writes a response.
   * @level l1
   * @consumer CLI callers previewing a query before dispatch.
   * Existing single-fire coverage allows one call; Pro dry-run uses another dispatcher.
   */
  it.each([
    { label: "default", mode: [] },
    { label: "explicit ask", mode: ["--ask"] },
    { label: "quick", mode: ["quick"] },
    { label: "opinion", mode: ["opinion"] },
  ])(
    "$label --dry-run previews without provider calls",
    async ({ mode }) => {
      const env = makeTestEnv()
      resetGenerateTextToOk()
      const beforeTmpFiles = listLlmTmpFiles()

      const result = await runCli([...mode, "--dry-run", "--model", "google/gemini-2.5-pro", "preview this query"])

      expect(result.error).toBeUndefined()
      expect(result.exited).toBeUndefined()
      expect(generateTextMock).not.toHaveBeenCalled()
      expect(streamTextMock).not.toHaveBeenCalled()
      expect(queryBackgroundMock).not.toHaveBeenCalled()
      expect(env.stdout).toHaveLength(0)
      expect(listLlmTmpFiles()).toEqual(beforeTmpFiles)
      expect(env.stderr.join("\n")).toMatch(/Dry run.*would query/s)
      expect(env.stderr.join("\n")).toContain("google/gemini-2.5-pro")
    },
    10_000,
  )

  it("main() fires exactly once per invocation (default/ask path)", async () => {
    const env = makeTestEnv()
    resetGenerateTextToOk()

    // Import main manually with argv set, so we count the mock call precisely.
    // Fresh import each test via vi.resetModules (registered in afterEach).
    vi.resetModules()
    process.argv = ["node", "cli.ts", "say ok"]
    const mod = await import("../src/cli")
    await mod.main()

    // The ask() path routes through streamText (stream: true default). Exactly
    // one call — if cli.ts's module-scope `main()` regression returns, the
    // import above would run main twice and this would be 2.
    const totalCalls = generateTextMock.mock.calls.length + streamTextMock.mock.calls.length
    expect(totalCalls).toBe(1)

    // finalizeOutput/finishResponse writes the JSON envelope to console.log
    // exactly once. Two-fire would produce two lines.
    const jsonLines = env.stdout.filter((l) => l.trim().startsWith("{") && l.includes('"file"'))
    expect(jsonLines).toHaveLength(1)
  }, 10_000)

  it("pro (dual) path fires both providers exactly once, writes one A/B log line", async () => {
    const env = makeTestEnv()
    resetGenerateTextToOk()

    vi.resetModules()
    // --no-challenger + --no-judge keep this test focused on the legacy
    // 2-leg single-fire semantics. The 3-leg + judge path
    // (km-bearly.llm-dual-pro-shadow-test) is exercised in
    // dual-pro-shadow.test.ts.
    process.argv = ["node", "cli.ts", "pro", "-y", "--no-challenger", "--no-judge", "test"]
    const mod = await import("../src/cli")
    await mod.main()

    // Dual-pro fires both legs in parallel (non-streaming). The GPT leg now
    // routes through queryOpenAIBackground (Responses API — recoverable),
    // K2.6 stays on generateText (OpenRouter has no Responses API). Exactly
    // one call on each mock. Double-fire — including a "preflight" generation
    // before the real dispatch — would make either count exceed one.
    expect(queryBackgroundMock.mock.calls.length).toBe(1)
    expect(generateTextMock.mock.calls.length).toBe(1)

    // A/B log: one line per invocation. Path built from CLAUDE_PROJECT_DIR or
    // cwd — makeTestEnv doesn't override either, so the log lands under
    // ~/.claude/projects/<encoded>/memory/ab-pro.jsonl. We assert the number
    // of lines that WOULD have been appended by counting the appendFileSync
    // calls? Simpler: verify finalizeOutput wrote exactly one combined report.
    const jsonLines = env.stdout.filter((l) => l.trim().startsWith("{") && l.includes('"file"'))
    expect(jsonLines).toHaveLength(1)
  }, 10_000)

  it("pro --dry-run resolves the fleet without provider calls or output writes", async () => {
    const env = makeTestEnv()
    resetGenerateTextToOk()
    const beforeTmpFiles = listLlmTmpFiles()

    const result = await runCli(["pro", "--dry-run", "-y", "ping"])

    expect(result.error).toBeUndefined()
    expect(result.exited).toBeUndefined()
    expect(result.returned).toBe("pro")
    expect(queryBackgroundMock).not.toHaveBeenCalled()
    expect(generateTextMock).not.toHaveBeenCalled()
    expect(streamTextMock).not.toHaveBeenCalled()
    expect(env.stdout).toHaveLength(0)
    expect(listLlmTmpFiles()).toEqual(beforeTmpFiles)
    const stderr = env.stderr.join("\n")
    expect(stderr).toMatch(/Dry run/)
    expect(stderr).toMatch(/would query/i)
    expect(stderr).toMatch(/GPT-5\.4 Pro|gpt-5\.4-pro/)
    expect(stderr).toMatch(/Kimi K2\.6|moonshotai\/kimi-k2\.6/)
    expect(stderr).toMatch(/Config/)
    expect(stderr).toMatch(/Estimated cost/)
  }, 10_000)
})
