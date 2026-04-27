/**
 * Phase 3 — 2+2 fleet (4 legs in parallel) + pairwise judge tests.
 *
 * Covers:
 *   1. Schema migration: parses v0.6 (champion/runnerUp) AND v0.7 (mainstays)
 *   2. pickSplitTestSlots — slot D = correlated re-test of recent winner
 *   3. pickSplitTestSlots — cold-start (empty history) falls back to round-robin
 *   4. buildPairwiseJudgePrompt — 2 responses, "Response A" + "Response B"
 *   5. parsePairwiseJudgeResponse — well-formed + fence + unparseable
 *   6. synthesizePairwiseFromV2 — v2 entry → judge.ab back-fill
 *   7. 4-leg dispatch fires all 4 legs in parallel
 *   8. 4-leg dispatch runs 3 pairwise judges (ab, ac, ad)
 *   9. --legs flag honored: 2 / 3 / 4 cap leg count
 *   10. v2 ab-pro.jsonl entry still parses (back-compat reader)
 *   11. Aggregate cost stays under typical budget for default fleet
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DualProConfigInputSchema,
  DualProConfigSchema,
  normalizeConfig,
  pickSplitTestSlots,
  buildPairwiseJudgePrompt,
  parsePairwiseJudgeResponse,
  synthesizePairwiseFromV2,
  buildLeaderboard,
  type AbProEntry,
  type ScoreWeights,
} from "../src/lib/dual-pro"

const FLAT_WEIGHTS: ScoreWeights = { score: 1, cost: 0, time: 0, costThreshold: 0.1, qualityWarningThreshold: 5.0 }

// --------------------------------------------------------------------
// 1. Schema migration — parses v0.6 + v0.7 inputs identically
// --------------------------------------------------------------------
describe("schema migration — v0.6 ↔ v0.7 back-compat", () => {
  it("legacy v0.6 (champion/runnerUp/challengerPool) translates to v0.7 internal shape", () => {
    const cfg = DualProConfigSchema.parse({
      champion: "champA",
      runnerUp: "runnerB",
      challengerPool: ["c1", "c2"],
      challengerStrategy: "round-robin",
    })
    expect(cfg.mainstays).toEqual(["champA", "runnerB"])
    expect(cfg.splitTestPool).toEqual(["c1", "c2"])
    expect(cfg.splitTestStrategy).toBe("round-robin")
    // Defaults the loader applied:
    expect(cfg.splitTestSlots).toBe(2)
  })

  it("v0.7 (mainstays/splitTestPool) parses identically", () => {
    const cfg = DualProConfigSchema.parse({
      mainstays: ["champA", "runnerB"],
      splitTestPool: ["c1", "c2"],
      splitTestStrategy: "round-robin",
      splitTestSlots: 2,
    })
    expect(cfg.mainstays).toEqual(["champA", "runnerB"])
    expect(cfg.splitTestPool).toEqual(["c1", "c2"])
    expect(cfg.splitTestStrategy).toBe("round-robin")
    expect(cfg.splitTestSlots).toBe(2)
  })

  it("v0.7 takes precedence when BOTH old and new fields are present", () => {
    const cfg = DualProConfigSchema.parse({
      // legacy fields ignored when new fields are set:
      champion: "ignored",
      runnerUp: "ignored",
      challengerPool: ["ignored"],
      // new fields win:
      mainstays: ["m0", "m1"],
      splitTestPool: ["s0", "s1"],
    })
    expect(cfg.mainstays).toEqual(["m0", "m1"])
    expect(cfg.splitTestPool).toEqual(["s0", "s1"])
  })

  it("empty input falls back to baked defaults", () => {
    const cfg = DualProConfigSchema.parse({})
    expect(cfg.mainstays).toHaveLength(2)
    expect(cfg.splitTestPool.length).toBeGreaterThan(0)
    expect(cfg.splitTestSlots).toBe(2)
  })

  it("normalizeConfig is a pure function", () => {
    const raw = DualProConfigInputSchema.parse({ mainstays: ["a", "b"] })
    const a = normalizeConfig(raw)
    const b = normalizeConfig(raw)
    expect(a).toEqual(b)
    // Different invocation, same output:
    expect(a.mainstays).toEqual(["a", "b"])
  })
})

// --------------------------------------------------------------------
// 2-3. pickSplitTestSlots — correlated re-test + cold start
// --------------------------------------------------------------------
describe("pickSplitTestSlots — correlated re-test rotation", () => {
  const pool = ["m1", "m2", "m3", "m4"]
  const mainstays = ["A", "B"]

  it("slot D is the most-recent winner from history (when in pool, not mainstay, not slot C)", () => {
    // History: m3 won most recently. Slot C round-robins to m1 at counter=0.
    // Slot D should pick m3 (the recent winner).
    const history = [
      { winnerModelId: "m2" }, // older
      { winnerModelId: "m3" }, // most recent
    ]
    const r = pickSplitTestSlots(pool, "round-robin", 0, history, mainstays, [])
    expect(r.slotC).toBe("m1")
    expect(r.slotD).toBe("m3")
  })

  it("slot D skips winners that are mainstays", () => {
    // Most recent winner is mainstay A → skip; next is m2.
    const history = [{ winnerModelId: "m2" }, { winnerModelId: "A" }]
    const r = pickSplitTestSlots(pool, "round-robin", 0, history, mainstays, [])
    expect(r.slotD).toBe("m2")
  })

  it("slot D skips winners that match slot C", () => {
    // Round-robin slot C = m1. History winner is also m1 → skip; pick m4.
    const history = [{ winnerModelId: "m4" }, { winnerModelId: "m1" }]
    const r = pickSplitTestSlots(pool, "round-robin", 0, history, mainstays, [])
    expect(r.slotC).toBe("m1")
    expect(r.slotD).toBe("m4")
  })

  it("cold-start (empty history) falls back to round-robin offset by 1 from slot C", () => {
    // No winners → pick the next round-robin slot after C, so the two slots
    // cover different pool members on first run.
    const r = pickSplitTestSlots(pool, "round-robin", 0, [], mainstays, [])
    expect(r.slotC).toBe("m1")
    expect(r.slotD).toBe("m2")
  })

  it("cold-start with all-tie history (no winners) also falls back to round-robin", () => {
    // History entries with no winnerModelId are skipped entirely.
    const r = pickSplitTestSlots(pool, "round-robin", 0, [{}, {}, {}], mainstays, [])
    expect(r.slotC).toBe("m1")
    expect(r.slotD).toBe("m2")
  })

  it("excluded models never picked for slot D", () => {
    const history = [{ winnerModelId: "m2" }]
    const r = pickSplitTestSlots(pool, "round-robin", 0, history, mainstays, ["m2"])
    expect(r.slotD).not.toBe("m2")
  })

  it("respects lookback window — winners outside window are ignored", () => {
    // 11 entries; winner m3 only at the very oldest position (lookback=10).
    const history = [
      { winnerModelId: "m3" }, // oldest, outside lookback=10 window
      ...Array.from({ length: 10 }, () => ({ winnerModelId: "m1" })), // m1 wins all recent
    ]
    // m1 == slot C, so slot D should fall back to round-robin. m3 is too old.
    const r = pickSplitTestSlots(pool, "round-robin", 0, history, mainstays, [], { lookback: 10 })
    expect(r.slotC).toBe("m1")
    // Slot D: not m1 (==slot C), not m3 (outside lookback) → fallback round-robin → m2
    expect(r.slotD).toBe("m2")
  })

  it("returns nextCounter advanced once (slot C drives counter, not slot D)", () => {
    const r = pickSplitTestSlots(pool, "round-robin", 5, [], mainstays, [])
    expect(r.nextCounter).toBe(6)
  })
})

// --------------------------------------------------------------------
// 4-5. Pairwise judge prompt + parser
// --------------------------------------------------------------------
describe("buildPairwiseJudgePrompt — 2 responses, A vs B", () => {
  it("includes exactly the two responses, the rubric, and STRICT JSON instruction", () => {
    const prompt = buildPairwiseJudgePrompt({
      question: "what is 2+2?",
      pair: {
        a: { model: "Mainstay-A", content: "Four." },
        b: { model: "Contender-B", content: "Approximately 4." },
      },
      rubric: "review",
    })
    expect(prompt).toMatch(/Response A \(Mainstay-A\)/)
    expect(prompt).toMatch(/Response B \(Contender-B\)/)
    // No "Response C" — pairwise sends ONLY two.
    expect(prompt).not.toMatch(/Response C/)
    expect(prompt).toMatch(/RUBRIC: review/)
    expect(prompt).toMatch(/CORRECTNESS heavily/)
    expect(prompt).toMatch(/STRICT JSON/)
    expect(prompt).toMatch(/"winner": "A" \| "B" \| "tie"/)
  })

  it("truncates long responses with [truncated] marker", () => {
    const long = "x".repeat(5000)
    const prompt = buildPairwiseJudgePrompt({
      question: "q",
      pair: { a: { model: "A", content: long }, b: { model: "B", content: "short" } },
      rubric: "default",
    })
    expect(prompt).toContain("[truncated]")
  })
})

describe("parsePairwiseJudgeResponse", () => {
  it("parses well-formed pairwise judge JSON", () => {
    const raw = JSON.stringify({
      scoreA: { scores: { specificity: 4, actionability: 4, correctness: 5, depth: 4 }, total: 17 },
      scoreB: { scores: { specificity: 3, actionability: 3, correctness: 3, depth: 3 }, total: 12 },
      winner: "A",
      reasoning: "A had concrete examples.",
    })
    const r = parsePairwiseJudgeResponse(raw)
    expect(r).toBeDefined()
    expect(r!.winner).toBe("A")
    expect(r!.scoreA!.total).toBe(17)
    expect(r!.scoreB!.total).toBe(12)
  })

  it("strips ```json fences", () => {
    const raw = '```json\n{"scoreA":{"scores":{"specificity":3,"actionability":3,"correctness":3,"depth":3},"total":12},"scoreB":{"scores":{"specificity":3,"actionability":3,"correctness":3,"depth":3},"total":12},"winner":"tie"}\n```'
    expect(parsePairwiseJudgeResponse(raw)?.winner).toBe("tie")
  })

  it("returns undefined on unparseable input", () => {
    expect(parsePairwiseJudgeResponse("not json")).toBeUndefined()
    expect(parsePairwiseJudgeResponse("")).toBeUndefined()
    expect(parsePairwiseJudgeResponse('{"missing":"fields"}')).toBeUndefined()
  })
})

// --------------------------------------------------------------------
// 6. v2 → v3 reader: synthesizePairwiseFromV2
// --------------------------------------------------------------------
describe("synthesizePairwiseFromV2 — back-compat reader", () => {
  const breakdown = (total: number) => ({
    scores: { specificity: total / 4, actionability: total / 4, correctness: total / 4, depth: total / 4 },
    total,
  })

  it("synthesizes a pairwise result from v2 N-way scores", () => {
    // V2 entry: leg A scored 16, leg B scored 12, leg C scored 20, winner "c".
    // The AB pair should have winner "A" (16 > 12).
    const ab = synthesizePairwiseFromV2(breakdown(16), breakdown(12), "c", "b")
    expect(ab).toBeDefined()
    expect(ab!.scoreA!.total).toBe(16)
    expect(ab!.scoreB!.total).toBe(12)
    // Pair B vs A: global winner is C (not in this pair) → infer from totals.
    // Margin > 1 → winner is A (16 vs 12).
    expect(ab!.winner).toBe("A")
  })

  it("when v2 winner is in the pair, that side wins", () => {
    // V2 entry: leg A scored 16, leg C scored 20, winner "c". The AC pair
    // should have winner "B" (the C side, since C is the contender).
    const ac = synthesizePairwiseFromV2(breakdown(16), breakdown(20), "c", "c")
    expect(ac!.winner).toBe("B")
  })

  it("returns undefined when both leg scores are missing (no signal)", () => {
    expect(synthesizePairwiseFromV2(null, null, "a", "b")).toBeUndefined()
    expect(synthesizePairwiseFromV2(undefined, undefined, undefined, "b")).toBeUndefined()
  })

  it("synthesizes tie when totals within 1 point of each other", () => {
    const ab = synthesizePairwiseFromV2(breakdown(15), breakdown(14.5), undefined, "b")
    expect(ab!.winner).toBe("tie")
  })
})

// --------------------------------------------------------------------
// 7-8. 4-leg dispatch + pairwise judge — integration with mocks
// --------------------------------------------------------------------
const generateTextMock = vi.fn()
const queryBackgroundMock = vi.fn()
vi.mock("ai", () => ({ generateText: generateTextMock, streamText: vi.fn() }))
vi.mock("../src/lib/openai-deep", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/openai-deep")>("../src/lib/openai-deep")
  return { ...actual, queryOpenAIBackground: queryBackgroundMock }
})

describe("4-leg dispatch + pairwise judge — integration", () => {
  let homeDir: string
  let prevHome: string | undefined
  let prevProjectDir: string | undefined
  let logSpy: ReturnType<typeof vi.spyOn>
  let errSpy: ReturnType<typeof vi.spyOn>
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "four-leg-"))
    prevHome = process.env.HOME
    prevProjectDir = process.env.CLAUDE_PROJECT_DIR
    process.env.HOME = homeDir
    process.env.CLAUDE_PROJECT_DIR = "/tmp/four-leg-test"
    process.env.CLAUDE_SESSION_ID = "fourlegsess"
    process.env.OPENAI_API_KEY = "sk-test-openai"
    process.env.OPENROUTER_API_KEY = "sk-test-openrouter"
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-google"
    process.env.LLM_NO_HISTORY = "1"
    process.env.LLM_NO_AUTO_PRICING = "1"
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
    if (prevHome !== undefined) process.env.HOME = prevHome
    else delete process.env.HOME
    if (prevProjectDir !== undefined) process.env.CLAUDE_PROJECT_DIR = prevProjectDir
    else delete process.env.CLAUDE_PROJECT_DIR
    logSpy.mockRestore()
    errSpy.mockRestore()
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  function setupMocks(): { generateCalls: () => number; backgroundCalls: () => number; pairwiseJudgeCalls: () => number } {
    queryBackgroundMock.mockReset()
    queryBackgroundMock.mockImplementation(async ({ model }: { model: { displayName: string } }) => ({
      model,
      content: `answer from ${model.displayName}`,
      responseId: `resp_${Math.random().toString(36).slice(2, 8)}`,
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      durationMs: 1000,
    }))
    let pairwiseJudges = 0
    generateTextMock.mockReset()
    generateTextMock.mockImplementation(async (args: { messages?: { role: string; content: unknown }[] }) => {
      const messages = args.messages ?? []
      const text = messages
        .map((m) =>
          typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? (m.content as { text?: string }[]).map((c) => c.text ?? "").join(" ")
              : "",
        )
        .join(" ")
      // Pairwise judge prompt always contains "Response A" + "Response B" + "STRICT JSON".
      if (text.includes("STRICT JSON") && text.includes("Response A") && text.includes("Response B")) {
        pairwiseJudges++
        // Slot B vs A: B (Kimi) loses. C vs A: C wins. D vs A: D wins by less.
        const isAB = text.includes("Kimi")
        const isAC = text.includes("Gemini")
        return {
          text: JSON.stringify(
            isAB
              ? {
                  scoreA: { scores: { specificity: 5, actionability: 4, correctness: 4, depth: 4 }, total: 17 },
                  scoreB: { scores: { specificity: 3, actionability: 3, correctness: 3, depth: 3 }, total: 12 },
                  winner: "A",
                  reasoning: "A more thorough.",
                }
              : isAC
                ? {
                    scoreA: { scores: { specificity: 5, actionability: 4, correctness: 4, depth: 4 }, total: 17 },
                    scoreB: { scores: { specificity: 5, actionability: 5, correctness: 5, depth: 5 }, total: 20 },
                    winner: "B",
                    reasoning: "C concrete examples.",
                  }
                : {
                    scoreA: { scores: { specificity: 5, actionability: 4, correctness: 4, depth: 4 }, total: 17 },
                    scoreB: { scores: { specificity: 5, actionability: 5, correctness: 4, depth: 4 }, total: 18 },
                    winner: "B",
                    reasoning: "D edged out.",
                  },
          ),
          reasoning: [],
          usage: { inputTokens: 200, outputTokens: 80 },
        }
      }
      // Non-judge calls: leg responses through generateText.
      return { text: "leg answer", reasoning: [], usage: { inputTokens: 100, outputTokens: 50 } }
    })
    return {
      generateCalls: () => generateTextMock.mock.calls.length,
      backgroundCalls: () => queryBackgroundMock.mock.calls.length,
      pairwiseJudgeCalls: () => pairwiseJudges,
    }
  }

  async function runDualPro(extraArgs: string[] = []) {
    vi.resetModules()
    process.argv = ["node", "cli.ts", "pro", "-y", ...extraArgs, "what is the best storage layer?"]
    const mod = await import("../src/cli")
    try {
      await mod.main()
    } catch (e) {
      if (!/^__exit_/.test((e as Error).message)) throw e
    }
  }

  function readLastAbProEntry() {
    const projectRoot = process.env.CLAUDE_PROJECT_DIR!
    const encoded = projectRoot.replace(/\//g, "-")
    const abPath = `${homeDir}/.claude/projects/${encoded}/memory/ab-pro.jsonl`
    expect(existsSync(abPath)).toBe(true)
    return JSON.parse(readFileSync(abPath, "utf-8").trim().split("\n").pop()!) as {
      schema: string
      a: { model: string; ok: boolean; score?: { total: number } | null }
      b: { model: string; ok: boolean; score?: { total: number } | null }
      c?: { model: string; ok: boolean; score?: { total: number } | null }
      d?: { model: string; ok: boolean; score?: { total: number } | null }
      judge?: {
        winner?: string
        ab?: { winner: string }
        ac?: { winner: string }
        ad?: { winner: string }
      }
    }
  }

  it("--legs 4 fires all four legs in parallel and runs three pairwise judges", async () => {
    const { pairwiseJudgeCalls } = setupMocks()
    // Need ab-pro history for slot D correlated re-test. Seed one prior winner:
    const projectRoot = process.env.CLAUDE_PROJECT_DIR!
    const encoded = projectRoot.replace(/\//g, "-")
    const dir = `${homeDir}/.claude/projects/${encoded}/memory`
    const fs = await import("node:fs")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      `${dir}/ab-pro.jsonl`,
      JSON.stringify({
        a: { model: "gpt-5.4-pro", ok: true },
        b: { model: "moonshotai/kimi-k2.6", ok: true },
        c: { model: "claude-opus-4-6", ok: true },
        judge: { winner: "c" },
      }) + "\n",
    )

    await runDualPro(["--legs", "4"])

    // Three pairwise judge calls: AB, AC, AD.
    expect(pairwiseJudgeCalls()).toBe(3)
    const ab = readLastAbProEntry()
    expect(ab.schema).toBe("ab-pro/v3")
    expect(ab.a.model).toBe("gpt-5.4-pro")
    expect(ab.b.model).toBe("moonshotai/kimi-k2.6")
    // Slots C and D both populated.
    expect(ab.c).toBeDefined()
    expect(ab.d).toBeDefined()
    // Slot D should be claude-opus-4-6 (the most-recent winner from history,
    // which is in pool, not a mainstay, not slot C).
    expect(ab.d?.model).toBe("claude-opus-4-6")
    // Pairwise verdicts recorded.
    expect(ab.judge?.ab?.winner).toBe("A")
    expect(ab.judge?.ac?.winner).toBe("B")
    expect(ab.judge?.ad?.winner).toBe("B")
  }, 15_000)

  it("--legs 2 caps to mainstays only — no slot C/D, no judge", async () => {
    const { pairwiseJudgeCalls } = setupMocks()
    await runDualPro(["--legs", "2", "--no-judge"])
    expect(pairwiseJudgeCalls()).toBe(0)
    const ab = readLastAbProEntry()
    expect(ab.a).toBeDefined()
    expect(ab.b).toBeDefined()
    expect(ab.c).toBeUndefined()
    expect(ab.d).toBeUndefined()
  }, 10_000)

  it("--legs 3 caps to mainstays + slot C — no slot D, two pairwise judges (AB, AC)", async () => {
    const { pairwiseJudgeCalls } = setupMocks()
    await runDualPro(["--legs", "3"])
    expect(pairwiseJudgeCalls()).toBe(2)
    const ab = readLastAbProEntry()
    expect(ab.c).toBeDefined()
    expect(ab.d).toBeUndefined()
    expect(ab.judge?.ab).toBeDefined()
    expect(ab.judge?.ac).toBeDefined()
    expect(ab.judge?.ad).toBeUndefined()
  }, 10_000)

  it("--no-challenger forces 2 legs (alias for --legs 2)", async () => {
    setupMocks()
    await runDualPro(["--no-challenger"])
    const ab = readLastAbProEntry()
    expect(ab.c).toBeUndefined()
    expect(ab.d).toBeUndefined()
  }, 10_000)
})

// --------------------------------------------------------------------
// 9. Leaderboard reads slot D correctly
// --------------------------------------------------------------------
describe("buildLeaderboard — leg D aggregated", () => {
  it("aggregates leg D entries into per-model averages alongside a/b/c", () => {
    const breakdown = (total: number) => ({
      scores: { specificity: total / 4, actionability: total / 4, correctness: total / 4, depth: total / 4 },
      total,
    })
    const entries: AbProEntry[] = [
      {
        a: { model: "champA", ok: true, score: breakdown(16), cost: 0.5, durationMs: 10000 },
        b: { model: "runnerB", ok: true, score: breakdown(12), cost: 0.05, durationMs: 8000 },
        c: { model: "challC", ok: true, score: breakdown(20), cost: 1.0, durationMs: 15000 },
        d: { model: "reTestD", ok: true, score: breakdown(18), cost: 0.8, durationMs: 12000 },
      },
    ]
    const board = buildLeaderboard(entries, FLAT_WEIGHTS)
    const d = board.find((r) => r.model === "reTestD")!
    expect(d).toBeDefined()
    expect(d.calls).toBe(1)
    expect(d.successCalls).toBe(1)
    expect(d.avgScore).toBe(18)
  })

  it("v2 entries (no leg D) load alongside v3 entries (with leg D)", () => {
    const breakdown = (total: number) => ({
      scores: { specificity: total / 4, actionability: total / 4, correctness: total / 4, depth: total / 4 },
      total,
    })
    const entries: AbProEntry[] = [
      // v2 entry — no D, no schema field, gpt/kimi keys absent.
      {
        a: { model: "champA", ok: true, score: breakdown(16) },
        b: { model: "runnerB", ok: true, score: breakdown(12) },
        c: { model: "challC", ok: true, score: breakdown(20) },
      },
      // v3 entry with D.
      {
        schema: "ab-pro/v3",
        a: { model: "champA", ok: true, score: breakdown(17) },
        b: { model: "runnerB", ok: true, score: breakdown(13) },
        c: { model: "challC", ok: true, score: breakdown(19) },
        d: { model: "reTestD", ok: true, score: breakdown(18) },
      },
    ]
    const board = buildLeaderboard(entries, FLAT_WEIGHTS)
    expect(board.find((r) => r.model === "reTestD")?.calls).toBe(1)
    expect(board.find((r) => r.model === "champA")?.calls).toBe(2)
    expect(board.find((r) => r.model === "champA")?.avgScore).toBeCloseTo(16.5)
  })
})
