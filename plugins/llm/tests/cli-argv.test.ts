/**
 * Regression: CLI argument parsing edge cases.
 *
 * 1. VALUE_FLAGS — `--image screenshot.png describe this` must send "describe
 *    this" as the prompt, NOT "screenshot.png describe this". Before the fix,
 *    extractText didn't know --image consumes its next token, so the path
 *    leaked into the question (cli.ts:~172 VALUE_FLAGS list).
 *
 * 2. --name=value form — `--model=gpt-5.4` must resolve identically to
 *    `--model gpt-5.4`. getArg() used to only match the space-separated form
 *    (cli.ts:~76 getArg).
 *
 * 3. OpenRouter synthesis — `--model owner/custom-model` with OPENROUTER_API_KEY
 *    set produces a synthesized Model(provider: "openrouter", modelId: X)
 *    instead of erroring (cli.ts:~130). Without the key, error() fires.
 */

import { describe, it, expect, vi } from "vitest"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { makeTestEnv } from "./helpers"

const generateTextMock = vi.fn()
const streamTextMock = vi.fn()

vi.mock("ai", () => ({
  generateText: generateTextMock,
  streamText: streamTextMock,
}))

// Mock askAndFinish at the dispatch layer — this is where the CLI hands off
// the resolved Model object. Capturing its first-arg gives us the post-parse
// view: resolved modelOverride (synthesized openrouter Model, getModel
// lookups), imagePath, and the extracted question text. The actual network
// call below doesn't matter for these tests.
const askAndFinishMock = vi.fn()
const runProDualMock = vi.fn()

vi.mock("../src/lib/dispatch", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/dispatch")>("../src/lib/dispatch")
  return {
    ...actual,
    askAndFinish: askAndFinishMock,
    runProDual: runProDualMock,
    // Keep the real maybeAutoUpdatePricing (no-op because LLM_NO_AUTO_PRICING=1).
  }
})

function mockOk() {
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
  askAndFinishMock.mockReset()
  askAndFinishMock.mockResolvedValue(undefined)
  runProDualMock.mockReset()
  runProDualMock.mockResolvedValue(undefined)
}

async function runWithArgv(argv: readonly string[]): Promise<void> {
  vi.resetModules()
  process.argv = ["node", "cli.ts", ...argv]
  // cli.ts parses argv at module scope AND resolves --model / --image there.
  // Errors (unknown model, missing image) throw via the mocked process.exit
  // during import. Wrap both phases — anything non-__exit_ is a real failure.
  try {
    const mod = await import("../src/cli")
    await mod.main()
  } catch (e) {
    if (!/^__exit_/.test((e as Error).message)) throw e
  }
}

function lastAskAndFinishArgs(): Record<string, any> | undefined {
  const calls = askAndFinishMock.mock.calls
  const last = calls[calls.length - 1]
  return last?.[0] as Record<string, any> | undefined
}

describe("cli argv parsing", () => {
  it("--image VALUE does not leak into the user prompt", async () => {
    const env = makeTestEnv()
    // cli.ts calls existsSync() on --image path; create a real file so the
    // guard doesn't error out before extractText runs.
    const imgPath = join(env.tmpDir, "shot.png")
    writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])) // PNG magic
    mockOk()

    await runWithArgv(["--image", imgPath, "describe this"])

    const args = lastAskAndFinishArgs()
    expect(args).toBeDefined()
    // extractText must STRIP the --image path from the prompt. Pre-fix this
    // read as "shot.png describe this" because --image wasn't in VALUE_FLAGS.
    expect(args!.question).toBe("describe this")
    expect(args!.question).not.toContain(imgPath)
    expect(args!.question).not.toContain("shot.png")
    // imagePath is still forwarded as its own field.
    expect(args!.imagePath).toBe(imgPath)
  }, 10_000)

  it("--model=value and --model value resolve identically", async () => {
    makeTestEnv()
    mockOk()

    // Space form.
    askAndFinishMock.mockClear()
    await runWithArgv(["--model", "gpt-5.4", "hello"])
    const spaceForm = lastAskAndFinishArgs()?.modelOverride

    // Equals form.
    askAndFinishMock.mockClear()
    await runWithArgv(["--model=gpt-5.4", "hello"])
    const equalsForm = lastAskAndFinishArgs()?.modelOverride

    expect(spaceForm).toBeDefined()
    expect(equalsForm).toBeDefined()
    expect(spaceForm!.modelId).toBe("gpt-5.4")
    expect(equalsForm!.modelId).toBe("gpt-5.4")
    expect(equalsForm!.provider).toBe(spaceForm!.provider)
    expect(equalsForm!.displayName).toBe(spaceForm!.displayName)
  }, 10_000)

  it("--model owner/custom-model with OPENROUTER_API_KEY → synthesized openrouter Model", async () => {
    makeTestEnv()
    mockOk()

    await runWithArgv(["--model", "acme/custom-7b", "hello"])

    const modelArg = lastAskAndFinishArgs()?.modelOverride
    expect(modelArg).toBeDefined()
    expect(modelArg!.provider).toBe("openrouter")
    expect(modelArg!.modelId).toBe("acme/custom-7b")
    expect(modelArg!.displayName).toBe("acme/custom-7b")
  }, 10_000)

  it("--model owner/custom-model without OPENROUTER_API_KEY → error + exit(1)", async () => {
    const env = makeTestEnv()
    delete process.env.OPENROUTER_API_KEY
    mockOk()

    await runWithArgv(["--model", "acme/custom-7b", "hello"])

    expect(env.exitCodes).toContain(1)
    const stderrAll = env.stderr.join("\n")
    expect(stderrAll).toMatch(/Unknown model:\s+acme\/custom-7b/)
  }, 10_000)
})
