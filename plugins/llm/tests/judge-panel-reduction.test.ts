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
import { spawnSync } from "node:child_process"
import { makeTestEnv, type TestEnv } from "./helpers"
import type { ProCompletion } from "../src/lib/format"

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
  async function runPro(
    env: TestEnv,
    flags = ["--challenger", "gemini-3-pro-preview"],
  ): Promise<{
    report: string
    entry: Record<string, unknown>
    envelope: { status: string; completion?: ProCompletion }
  }> {
    vi.resetModules()
    process.argv = ["node", "cli.ts", "pro", "-y", "--full-paths", ...flags, "which storage layer?"]
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
    return {
      report,
      entry: JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>,
      envelope: JSON.parse(jsonLine!) as { status: string; completion?: ProCompletion },
    }
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

  // 26561 acceptance: completed controls and every incomplete panel boundary.
  // Existing reduction tests cover surviving verdicts; these rows additionally
  // distinguish missing opinions, missing judges, and explicit judge waiver.
  // @failure a missing opinion or judge is reported as completed
  // @level l3
  // @consumer CLI callers and process-status readers
  // @testonly none
  it.each([
    { name: "all legs and judges", flags: ["--legs", "4"], failure: "none", status: "completed", returned: 4 },
    {
      name: "all legs without judge",
      flags: ["--no-challenger", "--no-judge"],
      failure: "none",
      status: "completed",
      returned: 2,
    },
    {
      name: "three of four with verdict",
      flags: ["--legs", "4"],
      failure: "anchor",
      status: "incomplete",
      returned: 3,
    },
    { name: "every judge failed", flags: ["--no-challenger"], failure: "judges", status: "incomplete", returned: 2 },
    {
      name: "unavailable configured mainstay",
      flags: ["--no-challenger"],
      failure: "unavailable",
      status: "incomplete",
      returned: 1,
    },
    {
      name: "no judge still requires every leg",
      flags: ["--no-challenger", "--no-judge"],
      failure: "anchor",
      status: "incomplete",
      returned: 1,
    },
    { name: "no answer", flags: ["--no-challenger"], failure: "all", status: "failed", returned: 0 },
    { name: "timed out mainstay", flags: ["--no-challenger"], failure: "timeout", status: "incomplete", returned: 1 },
  ])(
    "26561 $name",
    async ({ flags, failure, status, returned }) => {
      const env = makeTestEnv()
      queryBackgroundMock.mockReset()
      if (failure === "anchor" || failure === "all") {
        queryBackgroundMock.mockRejectedValue(new Error("anchor dispatch failed"))
      } else if (failure === "timeout") queryBackgroundMock.mockImplementation(() => new Promise(() => {}))
      else {
        queryBackgroundMock.mockImplementation(async ({ model }: { model: unknown }) => ({
          model,
          content: "anchor opinion",
          durationMs: 1,
        }))
      }
      if (failure === "unavailable") delete process.env.OPENAI_API_KEY
      generateTextMock.mockReset()
      generateTextMock.mockImplementation(async (args: Parameters<typeof promptText>[0]) => {
        const judging = promptText(args).includes("STRICT JSON")
        if (failure === "all" || (judging && failure === "judges")) throw new Error("provider dispatch failed")
        return {
          text: judging ? JUDGE_JSON : "available configured opinion",
          finalStep: { reasoningText: undefined },
          usage: { inputTokens: 100, outputTokens: 50 },
        }
      })
      const previousTimeout = process.env.LLM_LEG_TIMEOUT_MS
      if (failure === "timeout") process.env.LLM_LEG_TIMEOUT_MS = "25"
      const { report, entry, envelope } = await (async () => {
        try {
          return await runPro(env, flags)
        } finally {
          if (failure === "timeout") {
            if (previousTimeout === undefined) delete process.env.LLM_LEG_TIMEOUT_MS
            else process.env.LLM_LEG_TIMEOUT_MS = previousTimeout
          }
        }
      })()
      expect(envelope.status).toBe(status)
      expect(entry.status).toBe(status)
      expect(entry.completion).toEqual(envelope.completion)
      expect(envelope.completion?.returned).toHaveLength(returned)
      expect(env.exitCodes).toEqual(status === "completed" ? [] : [1])
      if (failure === "unavailable") {
        expect(queryBackgroundMock).not.toHaveBeenCalled()
        expect(envelope.completion?.missing).toEqual([
          expect.objectContaining({ slot: "a", cause: "unavailable", model: "gpt-5.4-pro" }),
        ])
      }
      if (failure === "timeout") expect(envelope.completion?.missing[0]?.cause).toBe("timed-out")
      if (failure === "judges") {
        expect(envelope.completion?.judges.failed).toHaveLength(1)
        expect(envelope.completion?.judges.required).toEqual(["ab"])
      }
      if (failure === "anchor" && returned === 3) expect((entry.judge as { winner?: string }).winner).toBeDefined()
      if (returned > 0) expect(report).toContain("available configured opinion")
      if (status !== "completed") {
        const last = env.stderr.at(-1)
        expect(last).toContain(`${status}: ${returned}/`)
        expect(last).toContain("report=")
        expect(last).toContain("follow-up=")
        expect(last).toContain("do not rerun the whole paid panel")
        expect(last).not.toContain("\n")
      }
    },
    20_000,
  )

  // @failure a mocked exit passes while the real incomplete CLI exits zero
  // @level l3
  // @consumer callers reading the native process status
  // @testonly none
  it("26561 preserves report, envelope and log before the real child exits 1", () => {
    const env = makeTestEnv()
    const outputFile = join(env.tmpDir, "native-panel.md")
    const source = `
      globalThis.fetch = async () => new Response(JSON.stringify({
        id: "resp_native", object: "response", created_at: 0, status: "completed", model: "moonshotai/kimi-k2.6",
        output: [{ type: "message", id: "msg_native", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "retained native opinion", annotations: [] }] }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, error: null, incomplete_details: null
      }), { headers: { "content-type": "application/json" } });
      const { runProDual } = await import("./vendor/bearly/plugins/llm/src/cmd/pro.ts");
      await runProDual({ question: "native incomplete witness", outputFile: ${JSON.stringify(outputFile)},
        sessionTag: "native-panel", modelOverride: undefined, imagePath: undefined,
        noChallenger: true, noJudge: true, skipConfirm: true,
        streamToken: () => {}, buildContext: async () => undefined });
    `
    const child = spawnSync("@in", ["--", "bun", "--eval", source], {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 15_000,
      env: {
        PATH: process.env.PATH,
        HOME: env.homeDir,
        TMPDIR: env.tmpDir,
        CLAUDE_PROJECT_DIR: env.tmpDir,
        OPENROUTER_API_KEY: "native-test-key",
        LLM_NO_ENV_AUTOLOAD: "1",
        LLM_SKIP_MODEL_LIVENESS: "1",
        LLM_NO_HISTORY: "1",
        LLM_NO_AUTO_PRICING: "1",
        LLM_NO_CACHE: "1",
        LLM_LEG_TIMEOUT_MS: "2000",
      },
    })
    expect(child.error, child.stderr).toBeUndefined()
    expect(child.status, child.stderr).toBe(1)
    const envelope = JSON.parse(child.stdout.trim()) as { status: string; completion: ProCompletion }
    expect(envelope.status, child.stderr).toBe("incomplete")
    expect(envelope.completion.returned).toEqual(["b"])
    expect(envelope.completion.missing[0]).toMatchObject({ slot: "a", cause: "unavailable" })
    expect(readFileSync(outputFile, "utf-8")).toContain("retained native opinion")
    const log = join(env.homeDir, ".claude/projects", env.tmpDir.replace(/\//g, "-"), "memory/ab-pro.jsonl")
    const entry = JSON.parse(readFileSync(log, "utf-8").trim()) as { status: string; completion: ProCompletion }
    expect(entry.status).toBe("incomplete")
    expect(entry.completion).toEqual(envelope.completion)
  }, 20_000)

  it("still returns a JUDGED verdict when the anchor leg is a dead model, and names the missing leg", async () => {
    const env = makeTestEnv()
    // THE MUTATION: leg A's model is dead. It is the anchor, so before this fix
    // the judge was skipped outright and the caller received unjudged opinions.
    queryBackgroundMock.mockReset()
    queryBackgroundMock.mockRejectedValue(new Error("Model moonshotai/kimi-k3 is unavailable or renamed"))
    generateTextMock.mockReset()
    generateTextMock.mockImplementation(async (args: Parameters<typeof promptText>[0]) => {
      if (promptText(args).includes("STRICT JSON")) {
        return {
          text: JUDGE_JSON,
          finalStep: { reasoningText: undefined },
          usage: { inputTokens: 200, outputTokens: 80 },
        }
      }
      return {
        text: "a surviving leg's answer",
        finalStep: { reasoningText: undefined },
        usage: { inputTokens: 100, outputTokens: 50 },
      }
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
    // 26561 AC2: a real reduced verdict still lacks a requested opinion.
    expect(
      env.exitCodes.some((code) => code !== 0),
      "judging survivors must not hide a missing requested leg",
    ).toBe(true)
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
        return {
          text: "the only answer",
          finalStep: { reasoningText: undefined },
          usage: { inputTokens: 100, outputTokens: 50 },
        }
      }
      return { text: "", finalStep: { reasoningText: undefined }, usage: { inputTokens: 10, outputTokens: 0 } }
    })

    const { report } = await runPro(env)

    const line1 = readerLine1(report)
    expect(line1, "line 1 must say the run was not judged").toMatch(/NOT JUDGED/)
    expect(line1, "and give the reason a reader can act on").toMatch(/panel of one cannot be scored/)
    expect(line1).toMatch(/^# Dual-Pro Response — 1\/\d+ legs · /)
    expect(report, "the legs that did not return are still named").toMatch(/\*\*Missing legs\*\*:/)

    // 26561 AC2: the existing warning above protects readers, but an
    // exit-code-only caller still treats this unjudged panel as successful.
    // Extend this same CLI witness so retained opinions cannot hide that fault.
    // @failure an incomplete Pro panel is accepted as a finished review
    // @level l3
    // @consumer CLI callers using process status and the JSON envelope
    // @testonly none
    expect(
      env.exitCodes.some((code) => code !== 0),
      "an incomplete panel must fail without explicit acceptance",
    ).toBe(true)
    const envelopeLine = env.stdout.find((line) => line.trim().startsWith("{") && line.includes('"file"'))!
    expect(
      (JSON.parse(envelopeLine) as { status?: string }).status,
      "machine callers must see incomplete panel completion",
    ).toBe("incomplete")
    expect(report, "the successful opinion survives the failure status").toContain("the only answer")
  }, 20_000)

  /**
   * 26561 AC1/2: one failed pair must not hide behind another pair's winner.
   * Existing singleton/reduced-panel cases lose a leg; this arm returns every
   * opinion and loses only one required judge, which those cases cannot catch.
   * @failure a partially judged panel exits success with a synthesized winner
   * @level l3
   * @consumer Pro CLI exit-code and JSON callers
   * @testonly none
   */
  it("preserves a surviving judge result but fails when another required pair cannot be judged", async () => {
    const env = makeTestEnv()
    queryBackgroundMock.mockReset()
    queryBackgroundMock.mockImplementation(async ({ model }: { model: { displayName: string } }) => ({
      model,
      content: "anchor opinion",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      durationMs: 10,
    }))
    generateTextMock.mockReset()
    let judges = 0
    generateTextMock.mockImplementation(async (args: Parameters<typeof promptText>[0]) => {
      const judging = promptText(args).includes("STRICT JSON")
      if (judging && ++judges === 1) throw new Error("one requested judge did not return")
      return {
        text: judging ? JUDGE_JSON : "contender opinion",
        finalStep: { reasoningText: undefined },
        usage: { inputTokens: 100, outputTokens: 50 },
      }
    })
    const { report, entry } = await runPro(env)
    expect(judges, "the three opinions require two pairwise judges").toBe(2)
    expect((entry.judge as { winner?: string }).winner, "the valid pair's verdict is retained").toBeDefined()
    expect(report).toContain("anchor opinion")
    expect(
      env.exitCodes.some((code) => code !== 0),
      "one missing judge must make the panel incomplete",
    ).toBe(true)
    const envelopeLine = env.stdout.find((line) => line.trim().startsWith("{") && line.includes('"file"'))!
    expect((JSON.parse(envelopeLine) as { status?: string }).status).toBe("incomplete")
  }, 20_000)
})

describe("24533 row 4 — a dead model is dropped BEFORE it is dispatched", () => {
  /**
   * THE ROW THIS PINS, and why the unit test for `checkModelLiveness` is not
   * enough on its own: a liveness verdict nothing acts on is a report, not a
   * preflight. So this arm asserts the CONSEQUENCE — the dead model's leg
   * never reaches `generateText` at all — rather than that a function returned
   * the word "absent".
   *
   * It also covers the seam. Every other test in this file sets
   * LLM_SKIP_MODEL_LIVENESS=1 (fake keys must not fire real catalog requests),
   * so this is the one place the wiring runs. I found the wiring uncovered by
   * noticing the catalog cache file never appeared after a green run.
   */
  it("never dispatches a leg whose model the provider does not serve, and still returns", async () => {
    const env = makeTestEnv()
    queryBackgroundMock.mockReset()
    queryBackgroundMock.mockImplementation(async ({ model }: { model: unknown }) => ({
      model,
      content: "the available anchor opinion",
      durationMs: 1,
    }))
    delete process.env.LLM_SKIP_MODEL_LIVENESS
    // The challenger must sit on a provider we CAN read a catalog for. The
    // first draft of this arm used `gemini-3-pro-preview` — a google model,
    // and google has no catalog reader, so it came back `unverified` and was
    // correctly NOT dropped. The arm failed and was right to: an unverifiable
    // model is not a dead one. `moonshotai/kimi-k3` is the real specimen and
    // is routed through OpenRouter, which we can read.
    vi.stubGlobal("fetch", async () => ({
      // Both mainstays, by their WIRE ids (openai is sent `gpt-5-pro` for our
      // `gpt-5.4-pro`), and deliberately not the challenger. A first draft
      // served neither mainstay and tripped the empty-panel guard instead —
      // which is that guard working, not this arm.
      json: async () => ({ data: [{ id: "gpt-5-pro" }, { id: "moonshotai/kimi-k2.6" }] }),
      ok: true,
      status: 200,
    }))
    const dispatched: string[] = []
    generateTextMock.mockImplementation(async (args: { model?: { modelId?: string } }) => {
      dispatched.push(String((args.model as { modelId?: string } | undefined)?.modelId ?? "unknown"))
      return { text: "an answer", finalStep: { reasoningText: undefined }, usage: { totalTokens: 10 } }
    })

    vi.resetModules()
    process.argv = ["node", "cli.ts", "pro", "-y", "--full-paths", "--challenger", "moonshotai/kimi-k3", "q?"]
    const mod = await import("../src/cli")
    try {
      await mod.main()
    } catch (e) {
      if (!/^__exit_/.test((e as Error).message)) throw e
    }

    const stderr = env.stderr.join(" ")
    expect(stderr, "the drop must be announced, never silent").toMatch(/dropped before dispatch/u)
    expect(stderr).toMatch(/kimi-k3/u)
    expect(
      dispatched.some((id) => id.includes("kimi-k3")),
      "a model the catalog does not serve must never reach a dispatch",
    ).toBe(false)
    expect(dispatched.length, "the surviving mainstays still run").toBeGreaterThan(0)
    vi.unstubAllGlobals()
    // 26561 AC1/2: dropping before dispatch must retain the requested roster.
    expect(
      env.exitCodes.some((code) => code !== 0),
      "a preflight drop is an incomplete requested panel",
    ).toBe(true)
    const envelopeLine = env.stdout.find((line) => line.trim().startsWith("{") && line.includes('"file"'))
    expect(envelopeLine).toBeDefined()
    const envelope = JSON.parse(envelopeLine ?? "null") as { status: string; completion: ProCompletion }
    expect(envelope.status).toBe("incomplete")
    expect(envelope.completion.requested).toHaveLength(3)
    expect(envelope.completion.missing).toEqual([
      expect.objectContaining({ slot: "c", model: "moonshotai/kimi-k3", cause: "dropped-before-dispatch" }),
    ])
  })
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
        return {
          text: JUDGE_JSON,
          finalStep: { reasoningText: undefined },
          usage: { inputTokens: 200, outputTokens: 80 },
        }
      }
      legCalls += 1
      if (legCalls === 1) throw new Error("OpenRouter request failed: unauthorized (invalid api key)")
      return {
        text: "sibling openrouter answer",
        finalStep: { reasoningText: undefined },
        usage: { inputTokens: 100, outputTokens: 50 },
      }
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
        return {
          text: JUDGE_JSON,
          finalStep: { reasoningText: undefined },
          usage: { inputTokens: 200, outputTokens: 80 },
        }
      }
      return {
        text: "an answer",
        finalStep: { reasoningText: undefined },
        usage: { inputTokens: 100, outputTokens: 50 },
      }
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
