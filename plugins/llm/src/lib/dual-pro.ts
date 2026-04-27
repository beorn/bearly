/**
 * Dual-pro champion-challenger framework.
 *
 * Three-leg shadow-testing pattern (km-bearly.llm-dual-pro-shadow-test):
 *
 *   - Leg A (champion):  config'd top-1   — stable across calls
 *   - Leg B (runner-up): config'd top-2   — stable across calls
 *   - Leg C (challenger): rotates from a candidate pool, shadow-tested
 *
 * After all three respond, a cheap judge model rates each on a rubric
 * (specificity / actionability / correctness / depth, 1-5 each). Scores +
 * time + cost go to ab-pro.jsonl. When a challenger consistently outscores
 * the champion (avg-score margin ≥ M over ≥ N calls AND failure-rate ≤
 * champion's), `bun llm pro --promote-review` invites a human-gated
 * promotion conversation. Auto-switching is never allowed — the framework
 * surfaces evidence; the human decides.
 *
 * This module owns:
 *   - Config loading (dual-pro-config.json + env overrides)
 *   - Rotation strategy (round-robin-after-N-calls, etc.)
 *   - Capability filtering (e.g., webSearch-only for /deep)
 *   - Judge prompt build + JSON-output parser
 *   - Leaderboard aggregation from ab-pro.jsonl
 *   - Promotion threshold logic
 *   - Backtest sampling + report aggregation
 *
 * The actual three-way dispatch lives in dispatch.ts:runProDual — this
 * module is the brain, dispatch.ts is the wiring.
 */

import { z } from "zod"
import { getModel, getEndpoint, type Model, MODELS, BEST_MODELS } from "./types"
import { isProviderAvailable } from "./providers"
import { createLogger } from "loggily"

const log = createLogger("bearly:llm:dual-pro")

// --------------------------------------------------------------------
// Config schema + defaults
// --------------------------------------------------------------------

/**
 * Score weights tune the leaderboard ranking. `score` is the judge's
 * weighted total (0–5). `cost` and `time` are penalties — set to 0 to
 * ignore them, raise to let leaderboard punish expensive/slow models.
 */
export const ScoreWeightsSchema = z.object({
  score: z.number().default(1.0),
  cost: z.number().default(0.0),
  time: z.number().default(0.0),
})
export type ScoreWeights = z.infer<typeof ScoreWeightsSchema>

/** Rotation strategies. round-robin-after-N-calls = step the index every
 * N successful 3-leg dispatches; random = pick one each call (more variance,
 * less coverage). */
export const ChallengerStrategySchema = z.union([
  z.literal("round-robin"),
  z.literal("round-robin-after-10-calls"),
  z.literal("round-robin-after-5-calls"),
  z.literal("random"),
])
export type ChallengerStrategy = z.infer<typeof ChallengerStrategySchema>

export const RubricSchema = z.union([
  z.literal("default"),
  z.literal("review"),
  z.literal("research"),
  z.literal("code"),
])
export type Rubric = z.infer<typeof RubricSchema>

export const DualProConfigSchema = z.object({
  champion: z.string().default("gpt-5.4-pro"),
  runnerUp: z.string().default("moonshotai/kimi-k2.6"),
  challengerPool: z.array(z.string()).default(["gemini-3-pro-preview", "grok-4", "claude-opus-4-6"]),
  challengerStrategy: ChallengerStrategySchema.default("round-robin-after-10-calls"),
  judge: z.string().default("gpt-5-mini"),
  rubric: RubricSchema.default("default"),
  scoreWeights: ScoreWeightsSchema.default({ score: 1.0, cost: 0.0, time: 0.0 }),
})
export type DualProConfig = z.infer<typeof DualProConfigSchema>

export const DEFAULT_CONFIG: DualProConfig = DualProConfigSchema.parse({})

/** Apply env overrides to a config object. Pure — returns a new object. */
export function applyEnvOverrides(cfg: DualProConfig, env: NodeJS.ProcessEnv = process.env): DualProConfig {
  const next = { ...cfg }
  if (env.LLM_DUAL_PRO_B) next.runnerUp = env.LLM_DUAL_PRO_B
  if (env.LLM_CHALLENGER_POOL) {
    const pool = env.LLM_CHALLENGER_POOL.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    if (pool.length > 0) next.challengerPool = pool
  }
  if (env.LLM_JUDGE_MODEL) next.judge = env.LLM_JUDGE_MODEL
  return next
}

// --------------------------------------------------------------------
// Config persistence
// --------------------------------------------------------------------

/** Project-scoped memory dir. Mirrors appendAbProLog so the config
 * travels with the Claude Code project context. */
export function getMemoryDir(env: NodeJS.ProcessEnv = process.env): string {
  // Lazy-load to avoid hard-binding os.homedir for tests that override HOME.
  const projectRoot = env.CLAUDE_PROJECT_DIR || process.cwd()
  const encoded = projectRoot.replace(/\//g, "-")
  const home = env.HOME || ""
  return `${home}/.claude/projects/${encoded}/memory`
}

/**
 * Load dual-pro config from disk. Falls back to DEFAULT_CONFIG (and writes
 * a starter config file with comment header) if missing. Always applies env
 * overrides on top.
 */
export async function loadConfig(opts: { writeOnMissing?: boolean } = {}): Promise<DualProConfig> {
  const fs = await import("fs")
  const path = await import("path")
  const dir = getMemoryDir()
  const file = path.join(dir, "dual-pro-config.json")
  let cfg: DualProConfig
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, "utf-8")
      // Strip JSONC-style line comments before parsing so users can keep
      // the comment header that explains each field.
      const stripped = raw.replace(/^\s*\/\/.*$/gm, "")
      const parsed = JSON.parse(stripped)
      cfg = DualProConfigSchema.parse(parsed)
    } catch (e) {
      log.warn?.("dual-pro-config.json malformed; using defaults", { error: String(e) })
      cfg = { ...DEFAULT_CONFIG }
    }
  } else {
    cfg = { ...DEFAULT_CONFIG }
    if (opts.writeOnMissing !== false) {
      try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(file, renderStarterConfig(cfg))
      } catch (e) {
        log.warn?.("could not write starter dual-pro-config.json", { error: String(e) })
      }
    }
  }
  return applyEnvOverrides(cfg)
}

/** Render a JSONC starter config with comments explaining each field. */
export function renderStarterConfig(cfg: DualProConfig): string {
  return `// dual-pro-config.json — controls bun llm pro champion-challenger dispatch.
// Each field documented inline. Edit and save; takes effect on next /pro call.
{
  // Leg A — champion. Stable across calls. Top-1 model by judge score.
  "champion": ${JSON.stringify(cfg.champion)},

  // Leg B — runner-up. Stable across calls. Top-2 model by judge score.
  // Env override: LLM_DUAL_PRO_B=<modelId>
  "runnerUp": ${JSON.stringify(cfg.runnerUp)},

  // Leg C — challenger pool. Rotates per call. New candidates added here.
  // Env override: LLM_CHALLENGER_POOL=id1,id2,id3
  "challengerPool": ${JSON.stringify(cfg.challengerPool)},

  // Strategy for picking next challenger. round-robin-after-N-calls steps
  // the index every N successful 3-leg dispatches; random picks each call.
  "challengerStrategy": ${JSON.stringify(cfg.challengerStrategy)},

  // Cheap model that scores the three responses (1-5 each on rubric).
  // Env override: LLM_JUDGE_MODEL=<modelId>
  "judge": ${JSON.stringify(cfg.judge)},

  // Scoring rubric. "default" is balanced; "review" emphasizes correctness;
  // "research" emphasizes depth; "code" emphasizes specificity.
  "rubric": ${JSON.stringify(cfg.rubric)},

  // Leaderboard ranking weights. score is judge total (0-5); cost/time are
  // penalties — set to 0 to ignore, raise to penalize expensive/slow models.
  "scoreWeights": ${JSON.stringify(cfg.scoreWeights, null, 2).replace(/\n/g, "\n  ")}
}
`
}

// --------------------------------------------------------------------
// Capability filter (registry-split-ready hook)
// --------------------------------------------------------------------

/**
 * Filter a model pool by capability. Today's MODELS registry is flat —
 * capability flags will land with km-bearly.llm-registry-split. Until then,
 * capabilities are inferred from existing model fields (isDeepResearch,
 * costTier). When the registry split lands, swap this body for direct
 * SkuConfig.capabilities reads.
 */
export type Capability = "webSearch" | "vision" | "deepResearch" | "backgroundApi"

export function modelHasCapability(model: Model, cap: Capability): boolean {
  // Registry-split landed: ProviderEndpoint declares capabilities per SKU.
  // Read directly from the endpoint when available; fall back to the model's
  // legacy facade fields for synthetic OpenRouter SKUs without an endpoint.
  const ep = getEndpoint(model.modelId)
  if (ep) return Boolean(ep.capabilities[cap])
  // Synthetic-SKU fallback: only `deepResearch` is reliably derivable from
  // the legacy Model shape. Everything else conservatively false.
  return cap === "deepResearch" ? model.isDeepResearch : false
}

/** Filter pool to models that satisfy ALL required capabilities AND have
 * an available provider. Returns the surviving model IDs (preserves order). */
export function filterPoolByCapability(
  poolIds: readonly string[],
  required: readonly Capability[],
  isAvailable: (provider: Model["provider"]) => boolean = (p) => isProviderAvailable(p),
): string[] {
  return poolIds.filter((id) => {
    const m = getModel(id)
    if (!m) return false
    if (!isAvailable(m.provider)) return false
    return required.every((cap) => modelHasCapability(m, cap))
  })
}

// --------------------------------------------------------------------
// Rotation strategy
// --------------------------------------------------------------------

/**
 * Pick the next challenger from the pool given a rotation strategy and
 * an opaque counter (caller persists across calls). Returns:
 *   { modelId, nextCounter }
 *
 * Pure — no I/O. Caller threads `counter` through ab-pro.jsonl or a
 * dedicated counter file.
 */
export function pickNextChallenger(
  pool: readonly string[],
  strategy: ChallengerStrategy,
  counter: number,
): { modelId: string | undefined; nextCounter: number } {
  if (pool.length === 0) return { modelId: undefined, nextCounter: counter }
  const safeCounter = Math.max(0, Math.floor(counter))
  switch (strategy) {
    case "random": {
      const i = Math.floor(Math.random() * pool.length)
      return { modelId: pool[i], nextCounter: safeCounter + 1 }
    }
    case "round-robin": {
      const i = safeCounter % pool.length
      return { modelId: pool[i], nextCounter: safeCounter + 1 }
    }
    case "round-robin-after-5-calls": {
      const i = Math.floor(safeCounter / 5) % pool.length
      return { modelId: pool[i], nextCounter: safeCounter + 1 }
    }
    case "round-robin-after-10-calls": {
      const i = Math.floor(safeCounter / 10) % pool.length
      return { modelId: pool[i], nextCounter: safeCounter + 1 }
    }
  }
}

/** Persist + read the rotation counter. Lives next to ab-pro.jsonl. */
export async function readChallengerCounter(): Promise<number> {
  const fs = await import("fs")
  const path = await import("path")
  const file = path.join(getMemoryDir(), "challenger-counter")
  if (!fs.existsSync(file)) return 0
  try {
    return parseInt(fs.readFileSync(file, "utf-8").trim(), 10) || 0
  } catch {
    return 0
  }
}

export async function writeChallengerCounter(n: number): Promise<void> {
  const fs = await import("fs")
  const path = await import("path")
  const dir = getMemoryDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "challenger-counter"), String(n))
}

// --------------------------------------------------------------------
// Judge prompt + parser
// --------------------------------------------------------------------

export const RUBRIC_DEFINITIONS: Record<Rubric, { dimensions: readonly string[]; emphasis: string }> = {
  default: {
    dimensions: ["specificity", "actionability", "correctness", "depth"],
    emphasis: "balanced — give equal weight to each dimension.",
  },
  review: {
    dimensions: ["specificity", "actionability", "correctness", "depth"],
    emphasis: "weight CORRECTNESS heavily — false claims tank the score.",
  },
  research: {
    dimensions: ["specificity", "actionability", "correctness", "depth"],
    emphasis: "weight DEPTH heavily — surface novel insights and citations.",
  },
  code: {
    dimensions: ["specificity", "actionability", "correctness", "depth"],
    emphasis: "weight SPECIFICITY heavily — concrete code examples beat hand-waves.",
  },
}

/**
 * Build the judge prompt. The judge is told to score each leg on the
 * rubric (1–5 per dimension, sum = total) and pick a winner. Output is
 * strict JSON — see parseJudgeResponse.
 */
export function buildJudgePrompt(args: {
  question: string
  responses: { id: "a" | "b" | "c"; model: string; content: string }[]
  rubric: Rubric
}): string {
  const { question, responses, rubric } = args
  const def = RUBRIC_DEFINITIONS[rubric]
  const sections = responses
    .map(
      (r) =>
        `### Leg ${r.id.toUpperCase()} (${r.model})\n\n${r.content.length > 4000 ? r.content.slice(0, 4000) + "\n…[truncated]" : r.content}`,
    )
    .join("\n\n")
  return `You are scoring three LLM responses to the same question on a rubric.

QUESTION:
${question}

${sections}

RUBRIC: ${rubric}
${def.emphasis}

Score each leg on these dimensions (1=poor, 5=excellent):
${def.dimensions.map((d) => `- ${d}`).join("\n")}

Then pick the winner — leg with the highest TOTAL (sum of dimension scores).
If two legs tie within 1 point, return "tie".

Output STRICT JSON, nothing else (no markdown fence, no prose):
{
  "a": { "scores": { "specificity": N, "actionability": N, "correctness": N, "depth": N }, "total": N },
  "b": { "scores": { "specificity": N, "actionability": N, "correctness": N, "depth": N }, "total": N },
  "c": { "scores": { "specificity": N, "actionability": N, "correctness": N, "depth": N }, "total": N },
  "winner": "a" | "b" | "c" | "tie",
  "reasoning": "one-sentence justification"
}`
}

export const JudgeBreakdownSchema = z.object({
  scores: z.object({
    specificity: z.number().min(0).max(5),
    actionability: z.number().min(0).max(5),
    correctness: z.number().min(0).max(5),
    depth: z.number().min(0).max(5),
  }),
  total: z.number().min(0).max(20),
})
export type JudgeBreakdown = z.infer<typeof JudgeBreakdownSchema>

export const JudgeResultSchema = z.object({
  a: JudgeBreakdownSchema.nullable(),
  b: JudgeBreakdownSchema.nullable(),
  c: JudgeBreakdownSchema.nullable().optional(),
  winner: z.union([z.literal("a"), z.literal("b"), z.literal("c"), z.literal("tie")]),
  reasoning: z.string().optional(),
})
export type JudgeResult = z.infer<typeof JudgeResultSchema>

/**
 * Parse a judge model's JSON response. Tolerant — if the model emits a
 * markdown fence around the JSON, strip it. Returns undefined on
 * unparseable / schema-mismatched output.
 */
export function parseJudgeResponse(raw: string): JudgeResult | undefined {
  if (!raw) return undefined
  let text = raw.trim()
  // Strip common ```json fences
  if (text.startsWith("```")) {
    text = text
      .replace(/^```[a-zA-Z]*\n?/, "")
      .replace(/```$/, "")
      .trim()
  }
  // Take the first { ... } block — judges sometimes prepend prose despite
  // the "STRICT JSON, nothing else" instruction.
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  try {
    const obj = JSON.parse(text.slice(start, end + 1))
    return JudgeResultSchema.parse(obj)
  } catch {
    return undefined
  }
}

// --------------------------------------------------------------------
// Leaderboard math
// --------------------------------------------------------------------

/** One leg slot in an ab-pro.jsonl entry. */
export interface AbProLegEntry {
  model: string
  ok: boolean
  score?: JudgeBreakdown | null
  cost?: number
  durationMs?: number
}

/** Schema-aware reader for ab-pro.jsonl entries — tolerates v1 (gpt/kimi)
 * and v2 (a/b/c) shapes. */
export interface AbProEntry {
  schema?: string
  timestamp?: string
  question?: string
  a?: AbProLegEntry
  b?: AbProLegEntry
  c?: AbProLegEntry
  // v1 legacy fields (gpt/kimi). Reader normalizes to a/b.
  gpt?: { model: string; ok: boolean; cost?: number; durationMs?: number }
  kimi?: { model: string; ok: boolean; cost?: number; durationMs?: number }
  judge?: { model?: string; result?: JudgeResult }
  pin?: boolean
  queryHash?: string
}

export interface LeaderboardRow {
  model: string
  calls: number
  successCalls: number
  failureRate: number
  avgScore: number
  avgCost: number
  avgTimeMs: number
  rankScore: number // weighted final ranking score
}

/**
 * Aggregate ab-pro.jsonl entries into a leaderboard. Failed calls
 * contribute to failureRate but not to avgScore (avg is over successful
 * calls only — otherwise a flaky model with one good answer would look
 * fine). rankScore is the config-weighted total.
 */
export function buildLeaderboard(entries: readonly AbProEntry[], weights: ScoreWeights): LeaderboardRow[] {
  const stats = new Map<
    string,
    {
      calls: number
      success: number
      scoreSum: number
      costSum: number
      timeSum: number
    }
  >()
  const bumpLeg = (leg?: AbProLegEntry) => {
    if (!leg?.model) return
    const s = stats.get(leg.model) ?? { calls: 0, success: 0, scoreSum: 0, costSum: 0, timeSum: 0 }
    s.calls += 1
    if (leg.ok) {
      s.success += 1
      if (leg.score?.total != null) s.scoreSum += leg.score.total
      if (leg.cost != null) s.costSum += leg.cost
      if (leg.durationMs != null) s.timeSum += leg.durationMs
    }
    stats.set(leg.model, s)
  }
  for (const e of entries) {
    // Normalize v1 (gpt/kimi) entries to a/b. They never have scores —
    // ok/cost/duration only — so they still count toward failureRate but
    // not avgScore.
    if (e.gpt) bumpLeg({ model: e.gpt.model, ok: e.gpt.ok, cost: e.gpt.cost, durationMs: e.gpt.durationMs })
    if (e.kimi) bumpLeg({ model: e.kimi.model, ok: e.kimi.ok, cost: e.kimi.cost, durationMs: e.kimi.durationMs })
    bumpLeg(e.a)
    bumpLeg(e.b)
    bumpLeg(e.c)
  }
  const rows: LeaderboardRow[] = []
  for (const [model, s] of stats) {
    const avgScore = s.success > 0 ? s.scoreSum / s.success : 0
    const avgCost = s.success > 0 ? s.costSum / s.success : 0
    const avgTimeMs = s.success > 0 ? s.timeSum / s.success : 0
    const failureRate = s.calls > 0 ? (s.calls - s.success) / s.calls : 0
    // Higher is better. Score is positive; cost/time are penalties scaled.
    const rankScore = avgScore * weights.score - avgCost * weights.cost - (avgTimeMs / 1000) * weights.time
    rows.push({
      model,
      calls: s.calls,
      successCalls: s.success,
      failureRate,
      avgScore,
      avgCost,
      avgTimeMs,
      rankScore,
    })
  }
  // Sort: rankScore desc, then calls desc as a tiebreaker so models with
  // more evidence rank higher when scores tie at zero (no judging yet).
  rows.sort((x, y) => y.rankScore - x.rankScore || y.calls - x.calls)
  return rows
}

/** Read all entries from ab-pro.jsonl. */
export async function readAbProLog(): Promise<AbProEntry[]> {
  const fs = await import("fs")
  const path = await import("path")
  const file = path.join(getMemoryDir(), "ab-pro.jsonl")
  if (!fs.existsSync(file)) return []
  const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean)
  const out: AbProEntry[] = []
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as AbProEntry)
    } catch {
      // Skip malformed lines; readers must tolerate format drift.
    }
  }
  return out
}

// --------------------------------------------------------------------
// Promotion threshold
// --------------------------------------------------------------------

export interface PromotionVerdict {
  shouldOfferPromotion: boolean
  challenger: LeaderboardRow | undefined
  champion: LeaderboardRow | undefined
  reason: string
}

export const DEFAULT_PROMOTION_MIN_CALLS = 10
export const DEFAULT_PROMOTION_SCORE_MARGIN = 0.3

/**
 * Decide whether the challenger has earned a promotion conversation.
 * Surfaces a verdict — never auto-switches. Caller emits a banner / launches
 * the interactive flow.
 *
 * Three gates (all must pass):
 *   1. Challenger has ≥ N calls (statistical floor)
 *   2. Challenger.avgScore > Champion.avgScore + M
 *   3. Challenger.failureRate ≤ Champion.failureRate
 */
export function evaluatePromotion(
  leaderboard: readonly LeaderboardRow[],
  championId: string,
  challengerPool: readonly string[],
  opts: { minCalls?: number; scoreMargin?: number } = {},
): PromotionVerdict {
  const minCalls = opts.minCalls ?? DEFAULT_PROMOTION_MIN_CALLS
  const margin = opts.scoreMargin ?? DEFAULT_PROMOTION_SCORE_MARGIN
  const champion = leaderboard.find((r) => r.model === championId)
  if (!champion) {
    return {
      shouldOfferPromotion: false,
      champion: undefined,
      challenger: undefined,
      reason: `champion ${championId} not in leaderboard yet`,
    }
  }
  // Best challenger = top-ranked pool member (excluding champion + runner).
  const candidates = leaderboard.filter((r) => challengerPool.includes(r.model))
  for (const c of candidates) {
    if (c.calls < minCalls) continue
    if (c.avgScore <= champion.avgScore + margin) continue
    if (c.failureRate > champion.failureRate) continue
    return {
      shouldOfferPromotion: true,
      challenger: c,
      champion,
      reason: `${c.model} avgScore ${c.avgScore.toFixed(2)} > ${champion.model} ${champion.avgScore.toFixed(2)} + ${margin} over ${c.calls} calls`,
    }
  }
  return {
    shouldOfferPromotion: false,
    champion,
    challenger: candidates[0],
    reason: "no challenger has cleared all three gates",
  }
}

// --------------------------------------------------------------------
// Backtest sample selection
// --------------------------------------------------------------------

export interface BacktestSampleOptions {
  size: number
  recencyWeight?: number // 0–1, fraction sampled from "recent" window
  recencyDays?: number // window size in days
  pinPriority?: boolean // pinned entries always included
  now?: number // for tests — defaults to Date.now()
}

/**
 * Sample N entries from ab-pro history with stratification.
 *
 * Strategy:
 *   1. Pinned entries (pin: true) always included.
 *   2. Remaining slots split: `recencyWeight` from last `recencyDays`,
 *      rest from older.
 *   3. Within each bucket, deterministic shuffle by hash of question — gives
 *      reproducible samples while still covering different queries.
 *
 * Returns the entries (not just IDs) so callers can re-fire them. Pure —
 * no I/O.
 */
export function sampleBacktestEntries(entries: readonly AbProEntry[], opts: BacktestSampleOptions): AbProEntry[] {
  const size = Math.max(0, Math.floor(opts.size))
  if (size === 0 || entries.length === 0) return []
  const recencyWeight = opts.recencyWeight ?? 0.7
  const recencyDays = opts.recencyDays ?? 30
  const now = opts.now ?? Date.now()
  const cutoff = now - recencyDays * 24 * 60 * 60 * 1000

  const pinned = opts.pinPriority !== false ? entries.filter((e) => e.pin) : []
  const pool = entries.filter((e) => !pinned.includes(e))

  const ts = (e: AbProEntry) => (e.timestamp ? new Date(e.timestamp).getTime() : 0)
  const recent = pool.filter((e) => ts(e) >= cutoff)
  const older = pool.filter((e) => ts(e) < cutoff)

  // Deterministic shuffle: sort by a hash of question + timestamp so the
  // same input deterministically yields the same sample. Test isolation
  // doesn't depend on Math.random.
  const hashKey = (e: AbProEntry) => {
    const s = `${e.question ?? ""}\n${e.timestamp ?? ""}`
    let h = 5381
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
    return h
  }
  const shuffled = (xs: AbProEntry[]) => [...xs].sort((a, b) => hashKey(a) - hashKey(b))

  const out: AbProEntry[] = []
  const seen = new Set<AbProEntry>()
  const take = (xs: AbProEntry[], n: number) => {
    for (const x of xs) {
      if (out.length >= size) return
      if (seen.has(x)) continue
      seen.add(x)
      out.push(x)
      if (--n <= 0) return
    }
  }

  take(pinned, pinned.length) // pinned all in (up to size)
  if (out.length < size) {
    const remaining = size - out.length
    const fromRecent = Math.min(Math.ceil(remaining * recencyWeight), recent.length)
    const fromOlder = remaining - fromRecent
    take(shuffled(recent), fromRecent)
    take(shuffled(older), fromOlder)
    // If we still under-fill (e.g. recent ran dry), top up from the other
    // bucket — better an under-stratified sample than an under-sized one.
    if (out.length < size) take(shuffled(recent), size - out.length)
    if (out.length < size) take(shuffled(older), size - out.length)
  }
  return out
}

// --------------------------------------------------------------------
// Backtest report aggregation
// --------------------------------------------------------------------

export interface BacktestPerQueryResult {
  question: string
  oldWinner?: "a" | "b" | "c" | "tie"
  newWinner?: "a" | "b" | "c" | "tie"
  oldTotal?: number // judge total for OLD config's best leg
  newTotal?: number // judge total for NEW config's best leg
  oldCost?: number
  newCost?: number
  oldTimeMs?: number
  newTimeMs?: number
}

export interface BacktestReport {
  sampleSize: number
  oldAvgScore: number
  newAvgScore: number
  scoreDelta: number
  newWins: number
  oldWins: number
  ties: number
  regressions: BacktestPerQueryResult[]
  oldAvgCost: number
  newAvgCost: number
  oldAvgTimeMs: number
  newAvgTimeMs: number
  perQuery: BacktestPerQueryResult[]
}

/**
 * Aggregate a backtest report from per-query OLD vs NEW outcomes.
 * Pure — no I/O. Caller hands in the results array; this turns it into the
 * markdown-ready report shape.
 */
export function aggregateBacktest(perQuery: readonly BacktestPerQueryResult[]): BacktestReport {
  const n = perQuery.length || 1
  let oldScoreSum = 0
  let newScoreSum = 0
  let oldCostSum = 0
  let newCostSum = 0
  let oldTimeSum = 0
  let newTimeSum = 0
  let newWins = 0
  let oldWins = 0
  let ties = 0
  const regressions: BacktestPerQueryResult[] = []
  for (const r of perQuery) {
    const o = r.oldTotal ?? 0
    const ne = r.newTotal ?? 0
    oldScoreSum += o
    newScoreSum += ne
    oldCostSum += r.oldCost ?? 0
    newCostSum += r.newCost ?? 0
    oldTimeSum += r.oldTimeMs ?? 0
    newTimeSum += r.newTimeMs ?? 0
    if (Math.abs(ne - o) < 0.5) ties++
    else if (ne > o) newWins++
    else {
      oldWins++
      regressions.push(r)
    }
  }
  const oldAvgScore = oldScoreSum / n
  const newAvgScore = newScoreSum / n
  return {
    sampleSize: perQuery.length,
    oldAvgScore,
    newAvgScore,
    scoreDelta: newAvgScore - oldAvgScore,
    newWins,
    oldWins,
    ties,
    regressions,
    oldAvgCost: oldCostSum / n,
    newAvgCost: newCostSum / n,
    oldAvgTimeMs: oldTimeSum / n,
    newAvgTimeMs: newTimeSum / n,
    perQuery: [...perQuery],
  }
}

/** Format the backtest report as markdown for human review. */
export function formatBacktestReport(report: BacktestReport): string {
  const fmt = (n: number) => n.toFixed(2)
  const fmtCost = (n: number) => `$${n.toFixed(3)}`
  const fmtTime = (n: number) => `${(n / 1000).toFixed(1)}s`
  const lines: string[] = []
  lines.push("# Backtest report")
  lines.push("")
  lines.push(`Sample size: **${report.sampleSize}** queries`)
  lines.push("")
  lines.push("## Score")
  lines.push("")
  lines.push(`- OLD avg: ${fmt(report.oldAvgScore)}`)
  lines.push(`- NEW avg: ${fmt(report.newAvgScore)}`)
  lines.push(`- Delta:   **${report.scoreDelta >= 0 ? "+" : ""}${fmt(report.scoreDelta)}**`)
  lines.push("")
  lines.push("## Wins / losses")
  lines.push("")
  lines.push(`- NEW wins: ${report.newWins}`)
  lines.push(`- OLD wins: ${report.oldWins} (regressions)`)
  lines.push(`- Ties:     ${report.ties}`)
  lines.push("")
  lines.push("## Cost / latency")
  lines.push("")
  lines.push(`- OLD avg cost: ${fmtCost(report.oldAvgCost)}`)
  lines.push(`- NEW avg cost: ${fmtCost(report.newAvgCost)}`)
  lines.push(`- OLD avg time: ${fmtTime(report.oldAvgTimeMs)}`)
  lines.push(`- NEW avg time: ${fmtTime(report.newAvgTimeMs)}`)
  if (report.regressions.length > 0) {
    lines.push("")
    lines.push("## Regressions (OLD scored higher)")
    lines.push("")
    for (const r of report.regressions) {
      lines.push(`- ${r.question.slice(0, 80)} — OLD ${fmt(r.oldTotal ?? 0)} vs NEW ${fmt(r.newTotal ?? 0)}`)
    }
  }
  return lines.join("\n")
}

// --------------------------------------------------------------------
// Persistence helpers
// --------------------------------------------------------------------

/** Append a backtest run to backtest-runs.jsonl. */
export async function appendBacktestRun(entry: {
  oldConfig: Partial<DualProConfig>
  newConfig: Partial<DualProConfig>
  report: BacktestReport
  decision?: "promote" | "abort" | "tune" | "deferred"
  noOldFire?: boolean
  quick?: boolean
}): Promise<void> {
  try {
    const fs = await import("fs")
    const path = await import("path")
    const dir = getMemoryDir()
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const line =
      JSON.stringify({
        schema: "backtest-runs/v1",
        timestamp: new Date().toISOString(),
        oldConfig: entry.oldConfig,
        newConfig: entry.newConfig,
        report: entry.report,
        decision: entry.decision ?? "deferred",
        noOldFire: !!entry.noOldFire,
        quick: !!entry.quick,
      }) + "\n"
    fs.appendFileSync(path.join(dir, "backtest-runs.jsonl"), line)
  } catch {
    // Best-effort — never break the calling path on log failure.
  }
}

/** Append a promotion decision to dual-pro-promotions.jsonl. */
export async function appendPromotionDecision(entry: {
  oldChampion: string
  oldRunnerUp: string
  newChampion?: string
  newRunnerUp?: string
  decision: "promote" | "promote-and-demote" | "keep-watching" | "cancel"
  reasoning: string
  challenger?: LeaderboardRow
}): Promise<void> {
  try {
    const fs = await import("fs")
    const path = await import("path")
    const dir = getMemoryDir()
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const line =
      JSON.stringify({
        schema: "dual-pro-promotions/v1",
        timestamp: new Date().toISOString(),
        ...entry,
      }) + "\n"
    fs.appendFileSync(path.join(dir, "dual-pro-promotions.jsonl"), line)
  } catch {
    // Best-effort.
  }
}

// --------------------------------------------------------------------
// BEST_MODELS-aware helpers
// --------------------------------------------------------------------

/** Inferred default config from the registry's BEST_MODELS.pro entries. */
export function inferDefaultsFromRegistry(): DualProConfig {
  const proIds = BEST_MODELS.pro
  const champion = proIds[0] ?? DEFAULT_CONFIG.champion
  const runnerUp = proIds[1] ?? DEFAULT_CONFIG.runnerUp
  // Challenger pool = remaining BEST_MODELS.pro entries plus a couple of
  // cross-provider candidates that aren't already champ/runner.
  const seen = new Set([champion, runnerUp])
  const pool: string[] = []
  for (const id of proIds.slice(2)) {
    if (!seen.has(id)) {
      pool.push(id)
      seen.add(id)
    }
  }
  // Pad with diverse picks so a fresh install has a real shadow set.
  for (const id of ["gemini-3-pro-preview", "grok-4", "claude-opus-4-6"]) {
    if (!seen.has(id) && getModel(id)) {
      pool.push(id)
      seen.add(id)
    }
  }
  return {
    ...DEFAULT_CONFIG,
    champion,
    runnerUp,
    challengerPool: pool.length > 0 ? pool : DEFAULT_CONFIG.challengerPool,
  }
}

/** Resolve a model ID against MODELS, with friendly null handling. */
export function resolveModel(id: string | undefined): Model | undefined {
  if (!id) return undefined
  return getModel(id)
}
