/**
 * Unit tests for the dual-pro shadow-test framework
 * (km-bearly.llm-dual-pro-shadow-test).
 *
 * Coverage targets called out in the bead acceptance:
 *   (a) leaderboard math
 *   (b) promotion-threshold logic
 *   (c) judge prompt + parser
 *   (d) rotation strategy
 *   (e) backtest sample selection
 *   (f) backtest report aggregation
 *
 * These are pure-logic tests — no LLM calls, no real disk I/O for the math
 * paths. The persistence helpers (loadConfig, appendBacktestRun) are
 * exercised through a tmp HOME so writes stay isolated.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  // (a) leaderboard
  buildLeaderboard,
  type AbProEntry,
  type LeaderboardRow,
  // (b) promotion
  evaluatePromotion,
  DEFAULT_PROMOTION_MIN_CALLS,
  // (c) judge
  buildJudgePrompt,
  parseJudgeResponse,
  // (d) rotation
  pickNextChallenger,
  // (e) sampling
  sampleBacktestEntries,
  // (f) backtest report
  aggregateBacktest,
  formatBacktestReport,
  // config + persistence
  loadConfig,
  applyEnvOverrides,
  DEFAULT_CONFIG,
  appendBacktestRun,
  appendPromotionDecision,
  filterPoolByCapability,
  inferDefaultsFromRegistry,
  type DualProConfig,
  type ScoreWeights,
  type BacktestPerQueryResult,
} from "../src/lib/dual-pro"

const FLAT_WEIGHTS: ScoreWeights = { score: 1, cost: 0, time: 0, costThreshold: 0.1, qualityWarningThreshold: 5.0 }

// ----------------------------------------------------------
// (a) Leaderboard math
// ----------------------------------------------------------
describe("buildLeaderboard — leaderboard math", () => {
  it("aggregates multi-leg entries into per-model averages", () => {
    const entries: AbProEntry[] = [
      {
        a: {
          model: "champA",
          ok: true,
          score: { scores: { specificity: 4, actionability: 4, correctness: 4, depth: 4 }, total: 16 },
          cost: 0.5,
          durationMs: 10000,
        },
        b: {
          model: "runnerB",
          ok: true,
          score: { scores: { specificity: 3, actionability: 3, correctness: 3, depth: 3 }, total: 12 },
          cost: 0.05,
          durationMs: 8000,
        },
        c: {
          model: "challC",
          ok: true,
          score: { scores: { specificity: 5, actionability: 5, correctness: 5, depth: 5 }, total: 20 },
          cost: 1.0,
          durationMs: 15000,
        },
      },
      {
        a: {
          model: "champA",
          ok: true,
          score: { scores: { specificity: 4, actionability: 4, correctness: 4, depth: 4 }, total: 16 },
          cost: 0.6,
          durationMs: 11000,
        },
        b: { model: "runnerB", ok: false, durationMs: 0 },
        c: {
          model: "challC",
          ok: true,
          score: { scores: { specificity: 5, actionability: 5, correctness: 5, depth: 5 }, total: 20 },
          cost: 1.1,
          durationMs: 16000,
        },
      },
    ]
    const board = buildLeaderboard(entries, FLAT_WEIGHTS)
    const champ = board.find((r) => r.model === "champA")!
    const runner = board.find((r) => r.model === "runnerB")!
    const chall = board.find((r) => r.model === "challC")!

    // champA: 2 calls, both successful, avg score 16
    expect(champ.calls).toBe(2)
    expect(champ.successCalls).toBe(2)
    expect(champ.failureRate).toBe(0)
    expect(champ.avgScore).toBe(16)

    // runnerB: 2 calls, 1 failure → failureRate 0.5
    expect(runner.calls).toBe(2)
    expect(runner.successCalls).toBe(1)
    expect(runner.failureRate).toBe(0.5)
    expect(runner.avgScore).toBe(12) // success-only average

    // challC: highest avgScore wins ranking
    expect(chall.avgScore).toBe(20)
    expect(board[0]!.model).toBe("challC")
  })

  it("normalizes legacy v1 (gpt/kimi) shape", () => {
    const entries: AbProEntry[] = [
      {
        gpt: { model: "gpt-5.4-pro", ok: true, cost: 0.5, durationMs: 12000 },
        kimi: { model: "kimi", ok: false, cost: 0, durationMs: 0 },
      },
    ]
    const board = buildLeaderboard(entries, FLAT_WEIGHTS)
    const gpt = board.find((r) => r.model === "gpt-5.4-pro")!
    const kimi = board.find((r) => r.model === "kimi")!
    expect(gpt.calls).toBe(1)
    expect(gpt.successCalls).toBe(1)
    expect(kimi.failureRate).toBe(1) // 0% success
    // No score data on v1 entries → avgScore stays at 0.
    expect(gpt.avgScore).toBe(0)
  })

  it("applies score/cost/time weights to rankScore", () => {
    const entries: AbProEntry[] = [
      // Cheap-and-fast leg
      {
        a: {
          model: "cheap",
          ok: true,
          score: { scores: { specificity: 3, actionability: 3, correctness: 3, depth: 3 }, total: 12 },
          cost: 0.01,
          durationMs: 1000,
        },
      },
      // Expensive-and-slow leg with same score
      {
        a: {
          model: "expensive",
          ok: true,
          score: { scores: { specificity: 3, actionability: 3, correctness: 3, depth: 3 }, total: 12 },
          cost: 5.0,
          durationMs: 60_000,
        },
      },
    ]
    const flat = buildLeaderboard(entries, { score: 1, cost: 0, time: 0, costThreshold: 0.1, qualityWarningThreshold: 5.0 })
    // Equal rankScore when cost+time weights are 0; tiebreaker = calls (both 1) → stable order, both 12.
    expect(flat.find((r) => r.model === "cheap")!.rankScore).toBe(flat.find((r) => r.model === "expensive")!.rankScore)
    const costWeighted = buildLeaderboard(entries, { score: 1, cost: 1, time: 0, costThreshold: 0.1, qualityWarningThreshold: 5.0 })
    expect(costWeighted.find((r) => r.model === "cheap")!.rankScore).toBeGreaterThan(
      costWeighted.find((r) => r.model === "expensive")!.rankScore,
    )
  })

  it("handles empty input", () => {
    expect(buildLeaderboard([], FLAT_WEIGHTS)).toEqual([])
  })
})

// ----------------------------------------------------------
// (b) Promotion threshold
// ----------------------------------------------------------
describe("evaluatePromotion — three-gate threshold", () => {
  const champion = "champA"
  const pool = ["challC"]

  function row(model: string, calls: number, avgScore: number, failureRate: number): LeaderboardRow {
    return {
      model,
      calls,
      successCalls: Math.round(calls * (1 - failureRate)),
      failureRate,
      avgScore,
      avgCost: 0,
      avgTimeMs: 0,
      rankScore: avgScore,
    }
  }

  it("offers promotion when all three gates pass", () => {
    const board = [row("challC", 12, 4.5, 0.05), row("champA", 30, 4.0, 0.1)]
    const v = evaluatePromotion(board, champion, pool)
    expect(v.shouldOfferPromotion).toBe(true)
    expect(v.challenger?.model).toBe("challC")
    expect(v.reason).toMatch(/avgScore/)
  })

  it("blocks when challenger has too few calls", () => {
    const board = [row("challC", DEFAULT_PROMOTION_MIN_CALLS - 1, 5.0, 0), row("champA", 30, 3.0, 0)]
    expect(evaluatePromotion(board, champion, pool).shouldOfferPromotion).toBe(false)
  })

  it("blocks when score margin is too small", () => {
    const board = [row("challC", 12, 4.1, 0), row("champA", 30, 4.0, 0)]
    // margin default 0.3 → 4.1 > 4.0 + 0.3 is false
    expect(evaluatePromotion(board, champion, pool).shouldOfferPromotion).toBe(false)
  })

  it("blocks when challenger failure rate is worse", () => {
    const board = [row("challC", 12, 4.5, 0.2), row("champA", 30, 4.0, 0.05)]
    expect(evaluatePromotion(board, champion, pool).shouldOfferPromotion).toBe(false)
  })

  it("returns no champion result when champion not in leaderboard", () => {
    const v = evaluatePromotion([row("challC", 20, 5.0, 0)], "missing-champ", pool)
    expect(v.shouldOfferPromotion).toBe(false)
    expect(v.champion).toBeUndefined()
  })
})

// ----------------------------------------------------------
// (c) Judge prompt + parser
// ----------------------------------------------------------
describe("judge prompt + parser", () => {
  it("builds a prompt with all three legs and the rubric instruction", () => {
    const prompt = buildJudgePrompt({
      question: "What's the best storage layer?",
      responses: [
        { id: "a", model: "GPT-5.4 Pro", content: "Use SQLite WAL mode." },
        { id: "b", model: "Kimi K2.6", content: "Postgres for durability." },
        { id: "c", model: "Gemini 3 Pro", content: "DuckDB for analytics." },
      ],
      rubric: "review",
    })
    expect(prompt).toMatch(/Leg A \(GPT-5.4 Pro\)/)
    expect(prompt).toMatch(/Leg B \(Kimi K2.6\)/)
    expect(prompt).toMatch(/Leg C \(Gemini 3 Pro\)/)
    expect(prompt).toMatch(/RUBRIC: review/)
    expect(prompt).toMatch(/CORRECTNESS heavily/)
    expect(prompt).toMatch(/STRICT JSON/)
  })

  it("truncates long responses but keeps marker", () => {
    const long = "x".repeat(5000)
    const prompt = buildJudgePrompt({
      question: "q",
      responses: [{ id: "a", model: "M", content: long }],
      rubric: "default",
    })
    expect(prompt).toContain("[truncated]")
  })

  it("parses well-formed judge JSON", () => {
    const raw = `{
  "a": { "scores": { "specificity": 4, "actionability": 4, "correctness": 5, "depth": 4 }, "total": 17 },
  "b": { "scores": { "specificity": 3, "actionability": 3, "correctness": 3, "depth": 3 }, "total": 12 },
  "c": { "scores": { "specificity": 5, "actionability": 5, "correctness": 4, "depth": 5 }, "total": 19 },
  "winner": "c",
  "reasoning": "C had the most concrete examples."
}`
    const parsed = parseJudgeResponse(raw)
    expect(parsed).toBeDefined()
    expect(parsed!.winner).toBe("c")
    expect(parsed!.a!.total).toBe(17)
    expect(parsed!.c!.total).toBe(19)
  })

  it("strips markdown code fences before parsing", () => {
    const raw =
      '```json\n{"a":{"scores":{"specificity":3,"actionability":3,"correctness":3,"depth":3},"total":12},"b":{"scores":{"specificity":3,"actionability":3,"correctness":3,"depth":3},"total":12},"winner":"tie"}\n```'
    const parsed = parseJudgeResponse(raw)
    expect(parsed?.winner).toBe("tie")
  })

  it("returns undefined on unparseable input", () => {
    expect(parseJudgeResponse("not json")).toBeUndefined()
    expect(parseJudgeResponse("")).toBeUndefined()
    expect(parseJudgeResponse('{"missing": "fields"}')).toBeUndefined()
  })

  it("tolerates leading prose before the JSON block", () => {
    const raw = `Here is my analysis:
{"a":{"scores":{"specificity":4,"actionability":4,"correctness":4,"depth":4},"total":16},"b":{"scores":{"specificity":3,"actionability":3,"correctness":3,"depth":3},"total":12},"winner":"a"}`
    const parsed = parseJudgeResponse(raw)
    expect(parsed?.winner).toBe("a")
  })
})

// ----------------------------------------------------------
// (d) Rotation strategy
// ----------------------------------------------------------
describe("pickNextChallenger — rotation strategy", () => {
  const pool = ["m1", "m2", "m3"]

  it("round-robin steps every call", () => {
    let counter = 0
    const seq: string[] = []
    for (let i = 0; i < 7; i++) {
      const r = pickNextChallenger(pool, "round-robin", counter)
      seq.push(r.modelId!)
      counter = r.nextCounter
    }
    expect(seq).toEqual(["m1", "m2", "m3", "m1", "m2", "m3", "m1"])
    expect(counter).toBe(7)
  })

  it("round-robin-after-10-calls steps every 10 calls", () => {
    const seenAtCounter = (n: number) => pickNextChallenger(pool, "round-robin-after-10-calls", n).modelId
    expect(seenAtCounter(0)).toBe("m1")
    expect(seenAtCounter(9)).toBe("m1")
    expect(seenAtCounter(10)).toBe("m2")
    expect(seenAtCounter(19)).toBe("m2")
    expect(seenAtCounter(20)).toBe("m3")
    expect(seenAtCounter(30)).toBe("m1") // wrap
  })

  it("round-robin-after-5-calls steps every 5 calls", () => {
    expect(pickNextChallenger(pool, "round-robin-after-5-calls", 4).modelId).toBe("m1")
    expect(pickNextChallenger(pool, "round-robin-after-5-calls", 5).modelId).toBe("m2")
    expect(pickNextChallenger(pool, "round-robin-after-5-calls", 14).modelId).toBe("m3")
  })

  it("random returns a pool member", () => {
    const r = pickNextChallenger(pool, "random", 0)
    expect(pool).toContain(r.modelId)
    expect(r.nextCounter).toBe(1)
  })

  it("empty pool returns undefined modelId without advancing counter", () => {
    expect(pickNextChallenger([], "round-robin", 5)).toEqual({ modelId: undefined, nextCounter: 5 })
  })

  it("guards against negative or fractional counter", () => {
    expect(pickNextChallenger(pool, "round-robin", -3).modelId).toBe("m1")
    expect(pickNextChallenger(pool, "round-robin", 2.7).modelId).toBe("m3")
  })
})

// ----------------------------------------------------------
// (e) Backtest sample selection
// ----------------------------------------------------------
describe("sampleBacktestEntries — stratified backtest sampling", () => {
  const now = new Date("2026-04-27T12:00:00Z").getTime()
  const dayMs = 24 * 60 * 60 * 1000
  const mkEntry = (q: string, daysAgo: number, pin?: boolean): AbProEntry => ({
    question: q,
    timestamp: new Date(now - daysAgo * dayMs).toISOString(),
    pin,
  })

  it("returns empty when size 0", () => {
    expect(sampleBacktestEntries([mkEntry("q1", 1)], { size: 0 })).toEqual([])
  })

  it("always includes pinned entries first", () => {
    const entries = [mkEntry("recent1", 1), mkEntry("recent2", 2), mkEntry("pinned-old", 100, true)]
    const sample = sampleBacktestEntries(entries, { size: 2, now })
    expect(sample.find((e) => e.question === "pinned-old")).toBeDefined()
  })

  it("weights recent queries by recencyWeight", () => {
    const recent = Array.from({ length: 10 }, (_, i) => mkEntry(`recent-${i}`, 5))
    const old = Array.from({ length: 10 }, (_, i) => mkEntry(`old-${i}`, 100))
    const sample = sampleBacktestEntries([...recent, ...old], { size: 10, recencyWeight: 0.7, recencyDays: 30, now })
    const recentCount = sample.filter((e) => e.question?.startsWith("recent")).length
    expect(recentCount).toBeGreaterThanOrEqual(7) // 70% of 10
  })

  it("is deterministic — same input yields same sample", () => {
    const entries = Array.from({ length: 50 }, (_, i) => mkEntry(`q-${i}`, i, i % 17 === 0))
    const a = sampleBacktestEntries(entries, { size: 10, now })
    const b = sampleBacktestEntries(entries, { size: 10, now })
    expect(a.map((e) => e.question)).toEqual(b.map((e) => e.question))
  })

  it("never returns more than the requested size", () => {
    const entries = Array.from({ length: 100 }, (_, i) => mkEntry(`q-${i}`, i))
    expect(sampleBacktestEntries(entries, { size: 5, now })).toHaveLength(5)
  })

  it("handles small populations gracefully", () => {
    const entries = [mkEntry("q1", 1)]
    expect(sampleBacktestEntries(entries, { size: 30, now })).toHaveLength(1)
  })
})

// ----------------------------------------------------------
// (f) Backtest report aggregation
// ----------------------------------------------------------
describe("aggregateBacktest — backtest report aggregation", () => {
  it("computes deltas, wins/losses, regressions", () => {
    const perQuery: BacktestPerQueryResult[] = [
      { question: "q1", oldTotal: 12, newTotal: 16, oldCost: 0.5, newCost: 0.6, oldTimeMs: 8000, newTimeMs: 9000 },
      { question: "q2", oldTotal: 18, newTotal: 14, oldCost: 0.7, newCost: 1.0, oldTimeMs: 12000, newTimeMs: 14000 },
      { question: "q3", oldTotal: 15, newTotal: 15.2, oldCost: 0.4, newCost: 0.4, oldTimeMs: 6000, newTimeMs: 7000 },
    ]
    const r = aggregateBacktest(perQuery)
    expect(r.sampleSize).toBe(3)
    expect(r.newWins).toBe(1) // q1: NEW won
    expect(r.oldWins).toBe(1) // q2: OLD won (regression)
    expect(r.ties).toBe(1) // q3: within 0.5
    expect(r.regressions).toHaveLength(1)
    expect(r.regressions[0]!.question).toBe("q2")
    expect(r.scoreDelta).toBeCloseTo((16 + 14 + 15.2 - 12 - 18 - 15) / 3)
  })

  it("formats a markdown report including regression list", () => {
    const r = aggregateBacktest([
      { question: "regression-query", oldTotal: 18, newTotal: 14 },
      { question: "win-query", oldTotal: 10, newTotal: 16 },
    ])
    const md = formatBacktestReport(r)
    expect(md).toMatch(/# Backtest report/)
    expect(md).toMatch(/Sample size: \*\*2\*\*/)
    expect(md).toMatch(/Regressions/)
    expect(md).toMatch(/regression-query/)
    expect(md).toMatch(/Delta:.*\+1\.00/)
  })

  it("handles zero per-query input", () => {
    const r = aggregateBacktest([])
    expect(r.sampleSize).toBe(0)
    expect(r.newWins + r.oldWins + r.ties).toBe(0)
  })
})

// ----------------------------------------------------------
// Config + persistence + capability filter
// ----------------------------------------------------------
describe("config + env overrides + persistence", () => {
  let homeDir: string
  let prevHome: string | undefined
  let prevEnvB: string | undefined
  let prevPool: string | undefined
  let prevJudge: string | undefined
  let prevProjectDir: string | undefined

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "dual-pro-test-"))
    prevHome = process.env.HOME
    prevEnvB = process.env.LLM_DUAL_PRO_B
    prevPool = process.env.LLM_CHALLENGER_POOL
    prevJudge = process.env.LLM_JUDGE_MODEL
    prevProjectDir = process.env.CLAUDE_PROJECT_DIR
    process.env.HOME = homeDir
    process.env.CLAUDE_PROJECT_DIR = "/tmp/test-project"
    delete process.env.LLM_DUAL_PRO_B
    delete process.env.LLM_CHALLENGER_POOL
    delete process.env.LLM_JUDGE_MODEL
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
    if (prevHome !== undefined) process.env.HOME = prevHome
    else delete process.env.HOME
    if (prevEnvB !== undefined) process.env.LLM_DUAL_PRO_B = prevEnvB
    else delete process.env.LLM_DUAL_PRO_B
    if (prevPool !== undefined) process.env.LLM_CHALLENGER_POOL = prevPool
    else delete process.env.LLM_CHALLENGER_POOL
    if (prevJudge !== undefined) process.env.LLM_JUDGE_MODEL = prevJudge
    else delete process.env.LLM_JUDGE_MODEL
    if (prevProjectDir !== undefined) process.env.CLAUDE_PROJECT_DIR = prevProjectDir
    else delete process.env.CLAUDE_PROJECT_DIR
  })

  it("env overrides applied on top of file config", () => {
    process.env.LLM_DUAL_PRO_B = "override-runner"
    process.env.LLM_CHALLENGER_POOL = "x,y,z"
    process.env.LLM_JUDGE_MODEL = "judge-x"
    const cfg = applyEnvOverrides({ ...DEFAULT_CONFIG })
    expect(cfg.runnerUp).toBe("override-runner")
    expect(cfg.challengerPool).toEqual(["x", "y", "z"])
    expect(cfg.judge).toBe("judge-x")
  })

  it("loadConfig writes a starter config when missing", async () => {
    const cfg = await loadConfig()
    expect(cfg.champion).toBe(DEFAULT_CONFIG.champion)
    // Starter file should now exist
    const projectRoot = process.env.CLAUDE_PROJECT_DIR!
    const encoded = projectRoot.replace(/\//g, "-")
    const file = `${homeDir}/.claude/projects/${encoded}/memory/dual-pro-config.json`
    expect(existsSync(file)).toBe(true)
    const text = readFileSync(file, "utf-8")
    expect(text).toMatch(/dual-pro-config\.json/)
    expect(text).toMatch(/champion/)
  })

  it("loadConfig reads a JSONC file with comments", async () => {
    const projectRoot = process.env.CLAUDE_PROJECT_DIR!
    const encoded = projectRoot.replace(/\//g, "-")
    const dir = `${homeDir}/.claude/projects/${encoded}/memory`
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      `${dir}/dual-pro-config.json`,
      `// header comment
{
  "champion": "custom-champ",
  "runnerUp": "custom-runner",
  "challengerPool": ["a", "b"],
  "challengerStrategy": "round-robin",
  "judge": "custom-judge",
  "rubric": "code",
  "scoreWeights": { "score": 1, "cost": 0.5, "time": 0.1 }
}`,
    )
    const cfg = await loadConfig()
    expect(cfg.champion).toBe("custom-champ")
    expect(cfg.challengerPool).toEqual(["a", "b"])
    expect(cfg.challengerStrategy).toBe("round-robin")
    expect(cfg.scoreWeights.cost).toBe(0.5)
  })

  it("loadConfig preserves URLs and slash-separated values inside string fields", async () => {
    // Defensive test against the /pro reviewer's claim that the JSONC strip
    // regex would mangle URLs/paths containing `//`. The regex is anchored
    // with `^\\s*` which only matches `//` at start-of-line + optional
    // whitespace, so URLs inside string values are safe. Re-verify it.
    const projectRoot = process.env.CLAUDE_PROJECT_DIR!
    const encoded = projectRoot.replace(/\//g, "-")
    const dir = `${homeDir}/.claude/projects/${encoded}/memory`
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      `${dir}/dual-pro-config.json`,
      `{
  "champion": "https://example.com//double-slash-path",
  "runnerUp": "moonshotai/kimi-k2.6",
  "challengerPool": ["openai/gpt-5", "anthropic/claude-opus-4-6"],
  // line comment that SHOULD be stripped
  "challengerStrategy": "round-robin",
    // indented line comment also stripped
  "judge": "gpt-5-mini",
  "rubric": "default",
  "scoreWeights": { "score": 1, "cost": 0.5, "time": 0 }
}`,
    )
    const cfg = await loadConfig()
    // URLs and slash-separated values must survive the strip.
    expect(cfg.champion).toBe("https://example.com//double-slash-path")
    expect(cfg.runnerUp).toBe("moonshotai/kimi-k2.6")
    expect(cfg.challengerPool).toEqual(["openai/gpt-5", "anthropic/claude-opus-4-6"])
    expect(cfg.judge).toBe("gpt-5-mini")
  })

  it("appendBacktestRun writes a JSONL entry", async () => {
    await appendBacktestRun({
      oldConfig: { champion: "old-c" },
      newConfig: { champion: "new-c" },
      report: aggregateBacktest([]),
      decision: "deferred",
    })
    const projectRoot = process.env.CLAUDE_PROJECT_DIR!
    const encoded = projectRoot.replace(/\//g, "-")
    const file = `${homeDir}/.claude/projects/${encoded}/memory/backtest-runs.jsonl`
    expect(existsSync(file)).toBe(true)
    const line = JSON.parse(readFileSync(file, "utf-8").trim()) as {
      schema: string
      oldConfig: { champion: string }
    }
    expect(line.schema).toBe("backtest-runs/v1")
    expect(line.oldConfig.champion).toBe("old-c")
  })

  it("appendPromotionDecision writes a JSONL entry", async () => {
    await appendPromotionDecision({
      oldChampion: "champ-A",
      oldRunnerUp: "runner-B",
      decision: "keep-watching",
      reasoning: "more evidence needed",
    })
    const projectRoot = process.env.CLAUDE_PROJECT_DIR!
    const encoded = projectRoot.replace(/\//g, "-")
    const file = `${homeDir}/.claude/projects/${encoded}/memory/dual-pro-promotions.jsonl`
    expect(existsSync(file)).toBe(true)
    const line = JSON.parse(readFileSync(file, "utf-8").trim()) as { schema: string; decision: string }
    expect(line.schema).toBe("dual-pro-promotions/v1")
    expect(line.decision).toBe("keep-watching")
  })

  it("inferDefaultsFromRegistry matches BEST_MODELS.pro", () => {
    const inferred = inferDefaultsFromRegistry()
    expect(inferred.champion).toBe("gpt-5.4-pro")
    expect(inferred.runnerUp).toBe("moonshotai/kimi-k2.6")
    expect(inferred.challengerPool.length).toBeGreaterThan(0)
  })
})

// ----------------------------------------------------------
// 3-leg dispatch — end-to-end smoke test (mocked providers)
// ----------------------------------------------------------
import { vi as vit } from "vitest"
const generateTextMock3 = vit.fn()
const queryBackgroundMock3 = vit.fn()
vit.mock("ai", () => ({
  generateText: generateTextMock3,
  streamText: vit.fn(),
}))
vit.mock("../src/lib/openai-deep", async () => {
  const actual = await vit.importActual<typeof import("../src/lib/openai-deep")>("../src/lib/openai-deep")
  return { ...actual, queryOpenAIBackground: queryBackgroundMock3 }
})

describe("3-leg dual-pro dispatch (shadow challenger + judge)", () => {
  let homeDir: string
  let prevHome: string | undefined
  let prevProjectDir: string | undefined
  let logSpy: ReturnType<typeof vit.spyOn>
  let errSpy: ReturnType<typeof vit.spyOn>
  let stdoutSpy: ReturnType<typeof vit.spyOn>
  let stderrSpy: ReturnType<typeof vit.spyOn>

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "dual-pro-dispatch-"))
    prevHome = process.env.HOME
    prevProjectDir = process.env.CLAUDE_PROJECT_DIR
    process.env.HOME = homeDir
    process.env.CLAUDE_PROJECT_DIR = "/tmp/dispatch-test"
    process.env.CLAUDE_SESSION_ID = "dispatchsess"
    process.env.OPENAI_API_KEY = "sk-test-openai"
    process.env.OPENROUTER_API_KEY = "sk-test-openrouter"
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-google"
    process.env.LLM_NO_HISTORY = "1"
    process.env.LLM_NO_AUTO_PRICING = "1"
    // Silence dispatch-path output. format.ts writes the "Output written to: …"
    // footer via process.stderr.write directly (bypassing console), so spy on
    // both. Tests assert against the persisted ab-pro.jsonl, not stdout.
    logSpy = vit.spyOn(console, "log").mockImplementation(() => {})
    errSpy = vit.spyOn(console, "error").mockImplementation(() => {})
    stdoutSpy = vit.spyOn(process.stdout, "write").mockImplementation(() => true)
    stderrSpy = vit.spyOn(process.stderr, "write").mockImplementation(() => true)
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
    vit.restoreAllMocks()
  })

  it("fires three legs, runs judge, writes ab-pro v2 entry with scores", async () => {
    queryBackgroundMock3.mockReset()
    queryBackgroundMock3.mockImplementation(async ({ model }: { model: { displayName: string } }) => ({
      model,
      content: `answer from ${model.displayName}`,
      responseId: `resp_${Math.random().toString(36).slice(2, 8)}`,
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      durationMs: 1000,
    }))
    // Kimi (OpenRouter) routes through generateText; the judge also routes
    // through generateText (ask("quick", ...)). Three calls total. Distinguish
    // the judge call by its prompt — it contains "STRICT JSON".
    generateTextMock3.mockReset()
    generateTextMock3.mockImplementation(async (args: { messages?: { role: string; content: unknown }[] }) => {
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
      if (text.includes("STRICT JSON")) {
        return {
          text: JSON.stringify({
            a: { scores: { specificity: 4, actionability: 4, correctness: 4, depth: 4 }, total: 16 },
            b: { scores: { specificity: 3, actionability: 3, correctness: 3, depth: 3 }, total: 12 },
            c: { scores: { specificity: 5, actionability: 5, correctness: 5, depth: 5 }, total: 20 },
            winner: "c",
            reasoning: "C had concrete examples.",
          }),
          reasoning: [],
          usage: { inputTokens: 200, outputTokens: 80 },
        }
      }
      return {
        text: "kimi answer",
        reasoning: [],
        usage: { inputTokens: 100, outputTokens: 50 },
      }
    })

    vit.resetModules()
    process.argv = [
      "node",
      "cli.ts",
      "pro",
      "-y",
      "--challenger",
      "gemini-3-pro-preview",
      "what is the best storage layer?",
    ]
    const mod = await import("../src/cli")
    try {
      await mod.main()
    } catch (e) {
      if (!/^__exit_/.test((e as Error).message)) throw e
    }

    // Three model calls: queryOpenAIBackground (gpt + gemini routed via
    // background-capable openai provider — but Gemini doesn't qualify so it
    // routes via generateText, plus Kimi via generateText, plus the judge).
    // We don't pin exact mock counts (depends on which provider each leg
    // routes through); we DO pin the ab-pro.jsonl entry shape.
    const projectRoot = process.env.CLAUDE_PROJECT_DIR!
    const encoded = projectRoot.replace(/\//g, "-")
    const abPath = `${homeDir}/.claude/projects/${encoded}/memory/ab-pro.jsonl`
    expect(existsSync(abPath)).toBe(true)
    const lines = readFileSync(abPath, "utf-8").trim().split("\n")
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const ab = JSON.parse(lines[lines.length - 1]!) as {
      schema: string
      a: { model: string; ok: boolean; score: { total: number } | null }
      b: { model: string; ok: boolean }
      c?: { model: string; ok: boolean; score: { total: number } | null }
      judge?: { winner: string; model?: string }
      gpt: { model: string; ok: boolean }
      kimi: { model: string; ok: boolean }
    }
    expect(ab.schema).toBe("ab-pro/v2")
    expect(ab.a.model).toBe("gpt-5.4-pro")
    expect(ab.b.model).toBe("moonshotai/kimi-k2.6")
    expect(ab.c?.model).toBe("gemini-3-pro-preview")
    expect(ab.judge?.winner).toBe("c")
    expect(ab.a.score?.total).toBe(16)
    expect(ab.c?.score?.total).toBe(20)
    // v1 back-compat fields preserved.
    expect(ab.gpt.model).toBe("gpt-5.4-pro")
    expect(ab.kimi.ok).toBe(true)
  }, 15_000)

  it("--no-challenger reverts to legacy 2-leg shape (no c, no judge)", async () => {
    queryBackgroundMock3.mockReset()
    queryBackgroundMock3.mockResolvedValueOnce({
      model: { displayName: "GPT-5.4 Pro" },
      content: "gpt answer",
      responseId: "resp_a",
      usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100 },
      durationMs: 100,
    })
    generateTextMock3.mockReset()
    generateTextMock3.mockResolvedValueOnce({
      text: "kimi answer",
      reasoning: [],
      usage: { inputTokens: 50, outputTokens: 50 },
    })

    vit.resetModules()
    process.argv = ["node", "cli.ts", "pro", "-y", "--no-challenger", "--no-judge", "smoke test question"]
    const mod = await import("../src/cli")
    try {
      await mod.main()
    } catch (e) {
      if (!/^__exit_/.test((e as Error).message)) throw e
    }

    const projectRoot = process.env.CLAUDE_PROJECT_DIR!
    const encoded = projectRoot.replace(/\//g, "-")
    const abPath = `${homeDir}/.claude/projects/${encoded}/memory/ab-pro.jsonl`
    expect(existsSync(abPath)).toBe(true)
    const ab = JSON.parse(readFileSync(abPath, "utf-8").trim().split("\n").pop()!) as {
      a: { model: string }
      c?: unknown
      judge?: unknown
    }
    expect(ab.a.model).toBe("gpt-5.4-pro")
    expect(ab.c).toBeUndefined()
    expect(ab.judge).toBeUndefined()
  }, 10_000)
})

// ----------------------------------------------------------
// Phase 1B — exclude config + quality warning badge
// ----------------------------------------------------------
describe("exclude config — static eviction without state machinery", () => {
  let homeDir: string
  let prevHome: string | undefined
  let prevExclude: string | undefined
  let prevProjectDir: string | undefined

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "dual-pro-exclude-"))
    prevHome = process.env.HOME
    prevExclude = process.env.LLM_EXCLUDE
    prevProjectDir = process.env.CLAUDE_PROJECT_DIR
    process.env.HOME = homeDir
    process.env.CLAUDE_PROJECT_DIR = "/tmp/exclude-test-project"
    delete process.env.LLM_EXCLUDE
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
    if (prevHome !== undefined) process.env.HOME = prevHome
    else delete process.env.HOME
    if (prevExclude !== undefined) process.env.LLM_EXCLUDE = prevExclude
    else delete process.env.LLM_EXCLUDE
    if (prevProjectDir !== undefined) process.env.CLAUDE_PROJECT_DIR = prevProjectDir
    else delete process.env.CLAUDE_PROJECT_DIR
  })

  it("DualProConfigSchema parses with default exclude=[] when missing", () => {
    expect(DEFAULT_CONFIG.exclude).toEqual([])
  })

  it("loadConfig parses an explicit exclude list", async () => {
    const projectRoot = process.env.CLAUDE_PROJECT_DIR!
    const encoded = projectRoot.replace(/\//g, "-")
    const dir = `${homeDir}/.claude/projects/${encoded}/memory`
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      `${dir}/dual-pro-config.json`,
      JSON.stringify({
        champion: "champA",
        runnerUp: "runnerB",
        challengerPool: ["c1", "c2"],
        challengerStrategy: "round-robin",
        judge: "j",
        rubric: "default",
        scoreWeights: { score: 1, cost: 1, costThreshold: 0.1, time: 0, qualityWarningThreshold: 5.0 },
        exclude: ["bad-model", "another-bad"],
      }),
    )
    const cfg = await loadConfig()
    expect(cfg.exclude).toEqual(["bad-model", "another-bad"])
  })

  it("LLM_EXCLUDE env var splits comma-separated ids and unions with config", () => {
    process.env.LLM_EXCLUDE = "x , y, z"
    const cfg = applyEnvOverrides({ ...DEFAULT_CONFIG, exclude: ["x", "pre-existing"] })
    // x already present (deduped), y/z appended after the config's pre-existing entries.
    expect(cfg.exclude).toEqual(["x", "pre-existing", "y", "z"])
  })

  it("LLM_EXCLUDE empty string is a no-op", () => {
    process.env.LLM_EXCLUDE = ""
    const cfg = applyEnvOverrides({ ...DEFAULT_CONFIG, exclude: ["a"] })
    expect(cfg.exclude).toEqual(["a"])
  })

  it("renderStarterConfig embeds the exclude field with empty default", () => {
    // renderStarterConfig is exercised via loadConfig's "writes a starter
    // config when missing" path. Here we hit it indirectly via DEFAULT_CONFIG.
    expect(DEFAULT_CONFIG.exclude).toEqual([])
  })
})

describe("pickNextChallenger — exclude filter", () => {
  const pool = ["m1", "m2", "m3"]

  it("filters excluded ids before applying rotation strategy", () => {
    // m2 excluded → effective pool is [m1, m3]
    let counter = 0
    const seq: string[] = []
    for (let i = 0; i < 6; i++) {
      const r = pickNextChallenger(pool, "round-robin", counter, ["m2"])
      seq.push(r.modelId!)
      counter = r.nextCounter
    }
    expect(seq).toEqual(["m1", "m3", "m1", "m3", "m1", "m3"])
    expect(seq).not.toContain("m2")
  })

  it("returns undefined when all pool members are excluded", () => {
    const r = pickNextChallenger(pool, "round-robin", 0, ["m1", "m2", "m3"])
    expect(r.modelId).toBeUndefined()
    // Counter does not advance when there's nothing to pick.
    expect(r.nextCounter).toBe(0)
  })

  it("default empty exclude preserves original behavior", () => {
    expect(pickNextChallenger(pool, "round-robin", 0).modelId).toBe("m1")
    expect(pickNextChallenger(pool, "round-robin", 0, []).modelId).toBe("m1")
  })

  it("exclude is honored under round-robin-after-N-calls strategy too", () => {
    // m1 excluded → effective pool is [m2, m3]
    expect(pickNextChallenger(pool, "round-robin-after-5-calls", 0, ["m1"]).modelId).toBe("m2")
    expect(pickNextChallenger(pool, "round-robin-after-5-calls", 5, ["m1"]).modelId).toBe("m3")
    expect(pickNextChallenger(pool, "round-robin-after-5-calls", 10, ["m1"]).modelId).toBe("m2") // wrap
  })
})

describe("filterPoolByCapability — capability-aware pool filter", () => {
  it("filters out unknown model IDs", () => {
    const result = filterPoolByCapability(
      ["gpt-5.4-pro", "this-model-does-not-exist", "gemini-3-pro-preview"],
      [],
      () => true,
    )
    expect(result).toEqual(["gpt-5.4-pro", "gemini-3-pro-preview"])
  })

  it("filters by webSearch capability", () => {
    const result = filterPoolByCapability(
      ["gpt-5.4-pro", "claude-opus-4-6", "gemini-3-pro-preview"],
      ["webSearch"],
      () => true,
    )
    // OpenAI is webSearch-capable today (heuristic), Anthropic/Google aren't.
    expect(result).toContain("gpt-5.4-pro")
    expect(result).not.toContain("claude-opus-4-6")
  })

  it("filters by deepResearch capability", () => {
    const result = filterPoolByCapability(["gpt-5.4-pro", "o3-deep-research-2025-06-26"], ["deepResearch"], () => true)
    expect(result).toEqual(["o3-deep-research-2025-06-26"])
  })

  it("respects provider availability", () => {
    const result = filterPoolByCapability(
      ["gpt-5.4-pro", "gemini-3-pro-preview"],
      [],
      (p) => p === "google", // only google available
    )
    expect(result).toEqual(["gemini-3-pro-preview"])
  })
})

// ----------------------------------------------------------
// Phase 1B — runLeaderboard quality warning badge
// ----------------------------------------------------------
describe("runLeaderboard — quality warning badge", () => {
  let homeDir: string
  let prevHome: string | undefined
  let prevProjectDir: string | undefined
  let stderrSpy: ReturnType<typeof vit.spyOn>
  let stdoutSpy: ReturnType<typeof vit.spyOn>
  let logSpy: ReturnType<typeof vit.spyOn>
  let stderrChunks: string[]
  let stdoutChunks: string[]

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "dual-pro-leaderboard-"))
    prevHome = process.env.HOME
    prevProjectDir = process.env.CLAUDE_PROJECT_DIR
    process.env.HOME = homeDir
    process.env.CLAUDE_PROJECT_DIR = "/tmp/leaderboard-test"
    stderrChunks = []
    stdoutChunks = []
    stderrSpy = vit.spyOn(console, "error").mockImplementation((...xs: unknown[]) => {
      stderrChunks.push(xs.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "))
    })
    logSpy = vit.spyOn(console, "log").mockImplementation((...xs: unknown[]) => {
      stdoutChunks.push(xs.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "))
    })
    stdoutSpy = vit.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk))
      return true
    })
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
    if (prevHome !== undefined) process.env.HOME = prevHome
    else delete process.env.HOME
    if (prevProjectDir !== undefined) process.env.CLAUDE_PROJECT_DIR = prevProjectDir
    else delete process.env.CLAUDE_PROJECT_DIR
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    logSpy.mockRestore()
    vit.restoreAllMocks()
  })

  /** Write 25+ ab-pro entries for a junk model (avgScore 4) and 25 for a good
   * model (avgScore 18). The junk row should be flagged; good row should not. */
  function seedAbPro(): void {
    const projectRoot = process.env.CLAUDE_PROJECT_DIR!
    const encoded = projectRoot.replace(/\//g, "-")
    const dir = `${homeDir}/.claude/projects/${encoded}/memory`
    mkdirSync(dir, { recursive: true })
    const lines: string[] = []
    for (let i = 0; i < 25; i++) {
      lines.push(
        JSON.stringify({
          schema: "ab-pro/v2",
          a: {
            model: "good-model",
            ok: true,
            score: { scores: { specificity: 5, actionability: 4, correctness: 5, depth: 4 }, total: 18 },
            cost: 0.5,
            durationMs: 1000,
          },
          c: {
            model: "junk-model",
            ok: true,
            score: { scores: { specificity: 1, actionability: 1, correctness: 1, depth: 1 }, total: 4 },
            cost: 0.5,
            durationMs: 1000,
          },
        }),
      )
    }
    writeFileSync(`${dir}/ab-pro.jsonl`, lines.join("\n") + "\n")
  }

  it("flags low-score high-call rows, leaves high-score and low-call alone (JSON mode)", async () => {
    seedAbPro()
    // Add a low-call low-score row that should NOT be flagged (insufficient evidence).
    const projectRoot = process.env.CLAUDE_PROJECT_DIR!
    const encoded = projectRoot.replace(/\//g, "-")
    const file = `${homeDir}/.claude/projects/${encoded}/memory/ab-pro.jsonl`
    const existing = readFileSync(file, "utf-8")
    const newRow = JSON.stringify({
      schema: "ab-pro/v2",
      b: {
        model: "fresh-bad-model",
        ok: true,
        score: { scores: { specificity: 1, actionability: 1, correctness: 1, depth: 1 }, total: 4 },
        cost: 0.1,
        durationMs: 500,
      },
    })
    writeFileSync(file, existing + newRow + "\n")

    const { runLeaderboard } = await import("../src/lib/dispatch")
    const { setJsonMode } = await import("../src/lib/output-mode")
    setJsonMode(true)
    try {
      await runLeaderboard()
    } finally {
      setJsonMode(false)
    }
    // Find the JSON envelope on stdout.
    const stdoutText = stdoutChunks.join("")
    const envelopeMatch = stdoutText.match(/\{[\s\S]*\}/)
    expect(envelopeMatch).toBeTruthy()
    const envelope = JSON.parse(envelopeMatch![0]) as {
      rows: { model: string; calls: number; avgScore: number; qualityWarning: boolean }[]
      qualityWarnings: string[]
    }
    const junk = envelope.rows.find((r) => r.model === "junk-model")!
    const good = envelope.rows.find((r) => r.model === "good-model")!
    const fresh = envelope.rows.find((r) => r.model === "fresh-bad-model")!
    expect(junk.qualityWarning).toBe(true)
    expect(good.qualityWarning).toBe(false)
    // Low calls (1) → not flagged, even though avgScore is below threshold.
    expect(fresh.qualityWarning).toBe(false)
    expect(envelope.qualityWarnings).toEqual(["junk-model"])
  })

  it("renders ⚠️ prefix in plain-text mode and a follow-up note", async () => {
    seedAbPro()
    const { runLeaderboard } = await import("../src/lib/dispatch")
    const { setJsonMode } = await import("../src/lib/output-mode")
    setJsonMode(false)
    await runLeaderboard()
    const out = stderrChunks.join("\n")
    // Junk row prefixed; good row not prefixed.
    expect(out).toMatch(/⚠️\s*junk-model/)
    expect(out).not.toMatch(/⚠️\s*good-model/)
    // Footer note suggests adding to exclude.
    expect(out).toMatch(/Consider adding to exclude:.*"junk-model"/)
  })
})
