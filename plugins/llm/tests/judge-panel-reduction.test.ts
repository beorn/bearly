/**
 * @hh/tooling/24533 — the /pro judge must not be gated on one leg.
 *
 * THE DEFECT THIS PINS. `pro.ts` ran the judge only `if (!options.noJudge &&
 * anyLegOk && legA.ok)`. One dead anchor model therefore turned every judged
 * dispatch into a set of UNJUDGED OPINIONS that still presented as a `/pro`
 * verdict — three specimens across three days, all the same dead model, found
 * only because three authors happened to read a status block below the answers.
 *
 * THE MUTATION THE BEAD ASKS FOR, and the first arm is exactly it: point a leg
 * at a dead model and the run must still return a JUDGED verdict that NAMES the
 * missing leg.
 *
 * THE SECOND ARM IS WHY THE FIRST ONE MEANS ANYTHING. An arm that only asserts
 * "a verdict came back" passes just as well against code that judges
 * unconditionally, including against a panel of one scored against itself — which
 * would reintroduce the same false authority by a different route. So the pair:
 * two survivors MUST be judged, one survivor MUST NOT be, and the refusal must
 * say why. Together they pin the boundary rather than one side of it.
 */

import { describe, it, expect } from "vitest"
import { vi } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { makeTestEnv, type TestEnv } from "./helpers"

const generateTextMock = vi.fn()
const queryBackgroundMock = vi.fn()
vi.mock("ai", () => ({ generateText: generateTextMock, streamText: vi.fn() }))
vi.mock("../src/lib/openai-deep", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/openai-deep")>("../src/lib/openai-deep")
  return { ...actual, queryOpenAIBackground: queryBackgroundMock }
})

/** Text of every message in a dispatch, so a judge call can be told from a leg call. */
function promptText(args: { messages?: { role: string; content: unknown }[] }): string {
  return (args.messages ?? [])
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? (m.content as { text?: string }[]).map((c) => c.text ?? "").join(" ")
          : "",
    )
    .join(" ")
}

const JUDGE_JSON = JSON.stringify({
  scoreA: { scores: { specificity: 4, actionability: 4, correctness: 4, depth: 4 }, total: 16 },
  scoreB: { scores: { specificity: 5, actionability: 5, correctness: 5, depth: 5 }, total: 20 },
  winner: "B",
  reasoning: "contender was more concrete.",
})

describe("24533 — a failed leg reduces the panel, it never cancels the verdict", () => {
  /** Mirrors dispatch.ts:appendAbProLog — CLAUDE_PROJECT_DIR or cwd, /-encoded. */
  function abProLogPath(home: string): string {
    const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd()
    return join(home, ".claude/projects", projectRoot.replace(/\//g, "-"), "memory/ab-pro.jsonl")
  }

  /** Run `pro` with 3 legs and return the rendered report plus the ab-pro entry. */
  async function runPro(env: TestEnv): Promise<{ report: string; entry: Record<string, unknown> }> {
    vi.resetModules()
    process.argv = [
      "node",
      "cli.ts",
      "pro",
      "-y",
      "--full-paths",
      "--challenger",
      "gemini-3-pro-preview",
      "which storage layer?",
    ]
    const mod = await import("../src/cli")
    try {
      await mod.main()
    } catch (e) {
      if (!/^__exit_/.test((e as Error).message)) throw e
    }
    const jsonLine = env.stdout.find((l) => l.trim().startsWith("{") && l.includes('"file"'))
    expect(
      jsonLine,
      `pro must emit its output envelope; stderr was: ${env.stderr.join(" | ").slice(0, 400)}`,
    ).toBeDefined()
    const report = readFileSync((JSON.parse(jsonLine!) as { file: string }).file, "utf-8")
    const abPath = abProLogPath(env.homeDir)
    expect(existsSync(abPath), "the A/B log must be written even on a degraded run").toBe(true)
    const lines = readFileSync(abPath, "utf-8").trim().split("\n")
    return { report, entry: JSON.parse(lines[lines.length - 1]!) as Record<string, unknown> }
  }

  /**
   * The first line a READER reaches. `finalizeOutput` prepends an
   * `<!-- llm-meta: … -->` comment for machine consumers; it is not what the
   * acceptance means by "the output a reader reaches first", and asserting on
   * the raw first line would pin the metadata format instead of the status.
   */
  function readerLine1(report: string): string {
    return report.split("\n").find((l) => l.trim() !== "" && !l.trim().startsWith("<!--"))!
  }

  it("still returns a JUDGED verdict when the anchor leg is a dead model, and names the missing leg", async () => {
    const env = makeTestEnv()
    // THE MUTATION: leg A's model is dead. It is the anchor, so before this fix
    // the judge was skipped outright and the caller received unjudged opinions.
    queryBackgroundMock.mockReset()
    queryBackgroundMock.mockRejectedValue(new Error("Model moonshotai/kimi-k3 is unavailable or renamed"))
    generateTextMock.mockReset()
    generateTextMock.mockImplementation(async (args: Parameters<typeof promptText>[0]) => {
      if (promptText(args).includes("STRICT JSON")) {
        return { text: JUDGE_JSON, reasoning: [], usage: { inputTokens: 200, outputTokens: 80 } }
      }
      return { text: "a surviving leg's answer", reasoning: [], usage: { inputTokens: 100, outputTokens: 50 } }
    })

    const { report, entry } = await runPro(env)

    // The verdict exists. This is the whole point of the bead.
    const judge = entry.judge as { winner?: string; error?: string } | undefined
    expect(judge?.winner, "a reduced panel must still produce a winner").toBeDefined()
    expect(judge?.error ?? "", "the judge must not report itself skipped").not.toMatch(/anchor leg A failed/)

    // And the reader is told, on the line they reach first, that it was reduced.
    const line1 = readerLine1(report)
    expect(line1, "line 1 states legs ran / legs asked for").toMatch(/^# Dual-Pro Response — \d+\/\d+ legs · /)
    expect(line1, "line 1 names the judging model, not just that judging happened").toMatch(/judged by /)
    expect(line1).not.toMatch(/NOT JUDGED/)
    expect(report, "the dead leg is named where the reader reaches it").toMatch(/\*\*Missing legs\*\*:/)
    expect(report).toMatch(/unavailable or renamed/)
  }, 20_000)

  it("does NOT fabricate a verdict when only one leg returns, and says why on line 1", async () => {
    const env = makeTestEnv()
    // The discriminating half. One opinion cannot be scored against anything, so
    // the honest outcome is a named refusal — not a verdict, and not silence.
    queryBackgroundMock.mockReset()
    queryBackgroundMock.mockRejectedValue(new Error("Model moonshotai/kimi-k3 is unavailable or renamed"))
    generateTextMock.mockReset()
    let legCalls = 0
    generateTextMock.mockImplementation(async (args: Parameters<typeof promptText>[0]) => {
      if (promptText(args).includes("STRICT JSON")) {
        throw new Error("the judge must never be called with a panel of one")
      }
      legCalls += 1
      // First surviving leg answers; every other leg returns empty, which
      // dual-pro already normalizes to a failure.
      if (legCalls === 1) {
        return { text: "the only answer", reasoning: [], usage: { inputTokens: 100, outputTokens: 50 } }
      }
      return { text: "", reasoning: [], usage: { inputTokens: 10, outputTokens: 0 } }
    })

    const { report } = await runPro(env)

    const line1 = readerLine1(report)
    expect(line1, "line 1 must say the run was not judged").toMatch(/NOT JUDGED/)
    expect(line1, "and give the reason a reader can act on").toMatch(/panel of one cannot be scored/)
    expect(line1).toMatch(/^# Dual-Pro Response — 1\/\d+ legs · /)
    expect(report, "the legs that did not return are still named").toMatch(/\*\*Missing legs\*\*:/)
  }, 20_000)
})

describe("24533 — a dispatch error never blames a credential that is working in the same run", () => {
  /**
   * DEFECT 2. The classifier is per-error: it sees one failure and cannot know
   * that three other models authenticated with the same key seconds earlier. So
   * it printed "check OPENROUTER_API_KEY" for a key that was demonstrably fine,
   * and sent three authors chasing a credential instead of a dead model id.
   *
   * The run knows. Both legs below are on openrouter; one fails with an auth
   * verdict and the other succeeds, so the verdict is rewritten to name the
   * model and the route.
   */
  it("rewrites an auth verdict to name the model and route when a sibling leg reached the same provider", async () => {
    const env = makeTestEnv()
    // Leg A (openai) answers, so the run still produces a report.
    queryBackgroundMock.mockReset()
    queryBackgroundMock.mockImplementation(async ({ model }: { model: { displayName: string } }) => ({
      model,
      content: "leg A answer",
      responseId: "resp_a",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      durationMs: 10,
    }))
    // Legs B and C are BOTH openrouter. The first to dispatch fails with an auth
    // verdict; the second succeeds, which is the proof the credential works.
    generateTextMock.mockReset()
    let legCalls = 0
    generateTextMock.mockImplementation(async (args: Parameters<typeof promptText>[0]) => {
      if (promptText(args).includes("STRICT JSON")) {
        return { text: JUDGE_JSON, reasoning: [], usage: { inputTokens: 200, outputTokens: 80 } }
      }
      legCalls += 1
      if (legCalls === 1) throw new Error("OpenRouter request failed: unauthorized (invalid api key)")
      return { text: "sibling openrouter answer", reasoning: [], usage: { inputTokens: 100, outputTokens: 50 } }
    })

    vi.resetModules()
    process.argv = [
      "node",
      "cli.ts",
      "pro",
      "-y",
      "--full-paths",
      "--challenger",
      "deepseek/deepseek-chat",
      "which storage layer?",
    ]
    const mod = await import("../src/cli")
    try {
      await mod.main()
    } catch (e) {
      if (!/^__exit_/.test((e as Error).message)) throw e
    }
    const jsonLine = env.stdout.find((l) => l.trim().startsWith("{") && l.includes('"file"'))
    expect(jsonLine, "pro must emit its output envelope").toBeDefined()
    const report = readFileSync((JSON.parse(jsonLine!) as { file: string }).file, "utf-8")

    expect(report, "the reader is told plainly it is not the credential").toMatch(/NOT a credentials problem/)
    expect(report, "and which route actually failed is named").toMatch(/failed on openrouter/)
    expect(
      report,
      "the env var must NOT be offered as the cure anywhere, including inside the quoted upstream text",
    ).not.toMatch(/check OPENROUTER_API_KEY/)
  }, 20_000)
})

describe("24533 — the cost estimate is derived from the models actually selected", () => {
  /**
   * DEFECT 4. `totalEstStr` was a tier band: `~$5-15` whenever fewer than two
   * Pro-tier legs were selected — including when NONE were. A measured 2-leg run
   * cost $0.0015 against that printed $5-15. Four orders of magnitude, on the
   * line that gates the spend confirmation.
   */
  it("prints a registry-derived figure with its token assumption, never the hardcoded band", async () => {
    const env = makeTestEnv()
    queryBackgroundMock.mockReset()
    queryBackgroundMock.mockImplementation(async ({ model }: { model: { displayName: string } }) => ({
      model,
      content: "leg A answer",
      responseId: "resp_cost",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      durationMs: 10,
    }))
    generateTextMock.mockReset()
    generateTextMock.mockImplementation(async (args: Parameters<typeof promptText>[0]) => {
      if (promptText(args).includes("STRICT JSON")) {
        return { text: JUDGE_JSON, reasoning: [], usage: { inputTokens: 200, outputTokens: 80 } }
      }
      return { text: "an answer", reasoning: [], usage: { inputTokens: 100, outputTokens: 50 } }
    })

    vi.resetModules()
    process.argv = ["node", "cli.ts", "pro", "-y", "--full-paths", "--no-challenger", "which storage layer?"]
    const mod = await import("../src/cli")
    try {
      await mod.main()
    } catch (e) {
      if (!/^__exit_/.test((e as Error).message)) throw e
    }

    const stderr = env.stderr.join("\n")
    const estimateLine = stderr.split("\n").find((l) => l.includes("Estimated cost:"))
    expect(estimateLine, "the run must still print an estimate").toBeDefined()
    // The band is the defect. Any occurrence of it means the figure was invented.
    expect(estimateLine!, "the hardcoded tier band must be gone").not.toMatch(/\$5-15/)
    // A derived figure states what it assumed, so a reader can judge it.
    expect(estimateLine!, "the estimate names its token assumption").toMatch(/in \/ .* out tokens/)
    expect(estimateLine!, "and is priced from the registry").toMatch(/registry prices for \d+ legs/)
  }, 20_000)
})
