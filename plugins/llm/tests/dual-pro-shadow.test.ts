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

const FLAT_WEIGHTS: ScoreWeights = { score: 1, cost: 0, time: 0 }

// ----------------------------------------------------------
// (a) Leaderboard math
// ----------------------------------------------------------
describe("buildLeaderboard — leaderboard math", () => {
  it("aggregates multi-leg entries into per-model averages", () => {
    const entries: AbProEntry[] = [
      {
        a: { model: "champA", ok: true, score: { scores: { specificity: 4, actionability: 4, correctness: 4, depth: 4 }, total: 16 }, cost: 0.5, durationMs: 10000 },
        b: { model: "runnerB", ok: true, score: { scores: { specificity: 3, actionability: 3, correctness: 3, depth: 3 }, total: 12 }, cost: 0.05, durationMs: 8000 },
        c: { model: "challC", ok: true, score: { scores: { specificity: 5, actionability: 5, correctness: 5, depth: 5 }, total: 20 }, cost: 1.0, durationMs: 15000 },
      },
      {
        a: { model: "champA", ok: true, score: { scores: { specificity: 4, actionability: 4, correctness: 4, depth: 4 }, total: 16 }, cost: 0.6, durationMs: 11000 },
        b: { model: "runnerB", ok: false, durationMs: 0 },
        c: { model: "challC", ok: true, score: { scores: { specificity: 5, actionability: 5, correctness: 5, depth: 5 }, total: 20 }, cost: 1.1, durationMs: 16000 },
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
      { gpt: { model: "gpt-5.4-pro", ok: true, cost: 0.5, durationMs: 12000 }, kimi: { model: "kimi", ok: false, cost: 0, durationMs: 0 } },
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
        a: { model: "cheap", ok: true, score: { scores: { specificity: 3, actionability: 3, correctness: 3, depth: 3 }, total: 12 }, cost: 0.01, durationMs: 1000 },
      },
      // Expensive-and-slow leg with same score
      {
        a: { model: "expensive", ok: true, score: { scores: { specificity: 3, actionability: 3, correctness: 3, depth: 3 }, total: 12 }, cost: 5.0, durationMs: 60_000 },
      },
    ]
    const flat = buildLeaderboard(entries, { score: 1, cost: 0, time: 0 })
    // Equal rankScore when cost+time weights are 0; tiebreaker = calls (both 1) → stable order, both 12.
    expect(flat.find((r) => r.model === "cheap")!.rankScore).toBe(flat.find((r) => r.model === "expensive")!.rankScore)
    const costWeighted = buildLeaderboard(entries, { score: 1, cost: 1, time: 0 })
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
    return { model, calls, successCalls: Math.round(calls * (1 - failureRate)), failureRate, avgScore, avgCost: 0, avgTimeMs: 0, rankScore: avgScore }
  }

  it("offers promotion when all three gates pass", () => {
    const board = [row("challC", 12, 4.5, 0.05), row("champA", 30, 4.0, 0.10)]
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
    const board = [row("challC", 12, 4.5, 0.20), row("champA", 30, 4.0, 0.05)]
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
    const raw = '```json\n{"a":{"scores":{"specificity":3,"actionability":3,"correctness":3,"depth":3},"total":12},"b":{"scores":{"specificity":3,"actionability":3,"correctness":3,"depth":3},"total":12},"winner":"tie"}\n```'
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
    const entries = [
      mkEntry("recent1", 1),
      mkEntry("recent2", 2),
      mkEntry("pinned-old", 100, true),
    ]
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
    const line = JSON.parse(readFileSync(file, "utf-8").trim())
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
    const line = JSON.parse(readFileSync(file, "utf-8").trim())
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
    const result = filterPoolByCapability(
      ["gpt-5.4-pro", "o3-deep-research-2025-06-26"],
      ["deepResearch"],
      () => true,
    )
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
