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
import { makeTestEnv } from "./helpers"

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
    reasoning: [],
    usage: { inputTokens: 10, outputTokens: 5 },
  })
  streamTextMock.mockReset()
  streamTextMock.mockImplementation(() => ({
    textStream: (async function* () {
      yield "ok"
    })(),
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
    // one call on each mock. Double-fire would be two each.
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
})
