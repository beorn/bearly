/**
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
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { makeTestEnv } from "./helpers"

const generateTextMock = vi.fn()
const streamTextMock = vi.fn()

vi.mock("ai", () => ({
  generateText: generateTextMock,
  streamText: streamTextMock,
}))

function abProLogPath(home: string): string {
  // Mirrors dispatch.ts:appendAbProLog — CLAUDE_PROJECT_DIR or cwd, /-encoded.
  const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const encoded = projectRoot.replace(/\//g, "-")
  return join(home, ".claude/projects", encoded, "memory/ab-pro.jsonl")
}

async function runDualPro() {
  vi.resetModules()
  process.argv = ["node", "cli.ts", "pro", "-y", "test question"]
  const mod = await import("../src/cli")
  try {
    await mod.main()
  } catch (e) {
    // process.exit mock throws; that's fine — still return.
    if (!/^__exit_/.test((e as Error).message)) throw e
  }
}

describe("dual-pro failure modes", () => {
  it("empty-content from GPT side is surfaced as failure", async () => {
    const env = makeTestEnv()

    // GPT returns empty content; K2.6 returns good content. The order inside
    // Promise.allSettled is stable by index (gpt first, kimi second), but
    // generateText is shared — we keyed by the model id in the prompt/messages.
    // Simpler: first call = gpt, second call = kimi (dispatch.ts fires them in
    // that order inside `await Promise.allSettled([...])`).
    generateTextMock.mockReset()
    generateTextMock
      .mockResolvedValueOnce({
        text: "", // empty — fulfilled-but-empty, the regression case
        reasoning: [],
        usage: { inputTokens: 10, outputTokens: 0 },
      })
      .mockResolvedValueOnce({
        text: "Kimi's answer",
        reasoning: [],
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

  it("both legs failing exits 1 with diagnostic stderr", async () => {
    const env = makeTestEnv()

    generateTextMock.mockReset()
    generateTextMock
      .mockRejectedValueOnce(new Error("OpenAI 500"))
      .mockRejectedValueOnce(new Error("OpenRouter 503"))

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
})
