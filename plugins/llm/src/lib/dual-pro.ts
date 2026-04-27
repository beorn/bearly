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
 * Leaderboard ranking weights.
 *
 * Rank optimizes for raw intellect (judge score), with a soft log-scale
 * penalty so extreme priciness brings score down. Speed and failure rate
 * are display-only — they do NOT enter the rank. Failures are assumed to
 * be programming errors or transient API issues that we'd retry, not a
 * model property.
 *
 *   rank = score * avgScore - cost * max(0, log10(avgCost / costThreshold))
 *
 * Defaults — costThreshold $0.10, cost 1.0:
 *   $0.10 → 0pt   $1 → −1pt   $10 → −2pt   $100 → −3pt
 *
 * Set `cost: 0` to rank purely by quality (or pass `--by-quality`). `time`
 * is preserved for back-compat but ignored in rank.
 */
export const ScoreWeightsSchema = z.object({
  score: z.number().default(1.0),
  cost: z.number().default(1.0),
  costThreshold: z.number().default(0.1),
  time: z.number().default(0.0),
  /** A model is flagged with `⚠️` in the leaderboard when its avgScore drops
   * below this threshold AND it has enough calls (≥20) to be a real signal.
   * Visual-only — does not affect dispatch. Add the model ID to `exclude`
   * to actually remove it from rotation. */
  qualityWarningThreshold: z.number().default(5.0),
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

/**
 * Raw config shape — accepts BOTH the v0.7+ (mainstays/splitTestPool) shape
 * AND the v0.6 (champion/runnerUp/challengerPool) shape. Internal callers
 * always use the normalized `DualProConfig` produced by `normalizeConfig`,
 * which translates legacy → new on read. Saves on disk continue using the
 * new shape (renderStarterConfig).
 */
export const DualProConfigInputSchema = z.object({
  // --- v0.7+ shape ---
  /** Two stable mainstays — frontier reasoning anchor + cheap proven baseline.
   * Anchors judge calibration so split-test slots are scored against a low-
   * variance reference. */
  mainstays: z.tuple([z.string(), z.string()]).optional(),
  /** Pool the split-test slots rotate through. Models added here get covered
   * faster than the old single-challenger rotation. */
  splitTestPool: z.array(z.string()).optional(),
  /** How many split-test slots fire per call (0 = mainstays only, 1 = legacy
   * 3-leg, 2 = full 2+2 fleet). Slot D rotates as "re-face the prior winner"
   * (correlated re-test) — confirms wins reproduce, doesn't waste a slot on
   * pure pool exploration. */
  splitTestSlots: z.number().min(0).max(4).optional(),
  /** Rotation strategy for split-test slot C. Slot D always uses correlated
   * re-test (most-recent winner not in mainstays/slot-C; cold-start falls back
   * to slot C strategy with a +1 round-robin offset). */
  splitTestStrategy: ChallengerStrategySchema.optional(),

  // --- v0.6 legacy shape (back-compat read; never written) ---
  champion: z.string().optional(),
  runnerUp: z.string().optional(),
  challengerPool: z.array(z.string()).optional(),
  challengerStrategy: ChallengerStrategySchema.optional(),

  // --- shared (both shapes) ---
  judge: z.string().default("gpt-5-mini"),
  rubric: RubricSchema.default("default"),
  scoreWeights: ScoreWeightsSchema.default({
    score: 1.0,
    cost: 1.0,
    costThreshold: 0.1,
    time: 0.0,
    qualityWarningThreshold: 5.0,
  }),
  /**
   * List of model IDs to exclude from all dispatch paths (mainstays + split-test
   * rotation). The leaderboard still tracks them — quality history doesn't
   * disappear — but pickNextChallenger / pickSplitTestSlots filter them out so
   * a junk model surfaced via the `⚠️` warning badge stops burning tokens.
   *
   * If a configured mainstay is in this list, dispatch logs a warning and uses
   * it anyway — explicit config wins over implicit exclude (so you don't
   * silently drop your mainstay because of a stale leaderboard).
   *
   * Env override: LLM_EXCLUDE=id1,id2,id3 (joins with config exclude).
   */
  exclude: z.array(z.string()).default([]),
})
export type DualProConfigInput = z.infer<typeof DualProConfigInputSchema>

/**
 * Normalized internal config — always uses the v0.7 shape.
 * Internal code (dispatch, rotation, judging) reads only this.
 */
export interface DualProConfig {
  mainstays: [string, string]
  splitTestPool: string[]
  splitTestSlots: number
  splitTestStrategy: ChallengerStrategy
  judge: string
  rubric: Rubric
  scoreWeights: ScoreWeights
  exclude: string[]
}

/**
 * Translate the raw input shape into the internal canonical shape.
 *
 * Read precedence: prefer the new `mainstays` / `splitTestPool` if set; else
 * fall back to legacy `champion`+`runnerUp` / `challengerPool`. If the input
 * has neither, fall back to baked defaults so a fresh install still boots.
 *
 * Throws when the user supplied a partial new-shape (e.g. only `mainstays[0]`
 * via a hand-edited config that violates the tuple constraint) — the zod
 * tuple already catches that. This function only rejects the truly
 * unrecoverable case where neither shape is present in a partial-edit.
 */
export function normalizeConfig(raw: DualProConfigInput): DualProConfig {
  let mainstays: [string, string]
  if (raw.mainstays) {
    mainstays = raw.mainstays
  } else if (raw.champion && raw.runnerUp) {
    mainstays = [raw.champion, raw.runnerUp]
  } else {
    // Baked defaults: same as the previous v0.6 default (gpt-5.4-pro +
    // moonshotai/kimi-k2.6). Users with the new design pin their actual
    // mainstays in dual-pro-config.json — the baked defaults exist only so
    // a fresh install boots cleanly.
    mainstays = ["gpt-5.4-pro", "moonshotai/kimi-k2.6"]
  }
  const splitTestPool = raw.splitTestPool ?? raw.challengerPool ?? ["gemini-3-pro-preview", "grok-4", "claude-opus-4-6"]
  const splitTestSlots = raw.splitTestSlots ?? 2
  const splitTestStrategy = raw.splitTestStrategy ?? raw.challengerStrategy ?? "round-robin-after-10-calls"
  return {
    mainstays,
    splitTestPool,
    splitTestSlots,
    splitTestStrategy,
    judge: raw.judge,
    rubric: raw.rubric,
    scoreWeights: raw.scoreWeights,
    exclude: raw.exclude,
  }
}

/** Canonical schema kept for downstream consumers that want a one-shot
 * `parse → DualProConfig`. Equivalent to `normalizeConfig(parse(input))`. */
export const DualProConfigSchema = DualProConfigInputSchema.transform(normalizeConfig)

export const DEFAULT_CONFIG: DualProConfig = normalizeConfig(DualProConfigInputSchema.parse({}))

/** Apply env overrides to a config object. Pure — returns a new object.
 *
 * Legacy env names continue to work — `LLM_DUAL_PRO_B` overrides mainstay-2
 * (the cheap baseline slot), `LLM_CHALLENGER_POOL` overrides the split-test
 * pool. New name `LLM_SPLIT_TEST_POOL` is the preferred alias. */
export function applyEnvOverrides(cfg: DualProConfig, env: NodeJS.ProcessEnv = process.env): DualProConfig {
  const next: DualProConfig = { ...cfg, mainstays: [...cfg.mainstays] as [string, string] }
  if (env.LLM_DUAL_PRO_B) next.mainstays = [next.mainstays[0], env.LLM_DUAL_PRO_B]
  const poolEnv = env.LLM_SPLIT_TEST_POOL || env.LLM_CHALLENGER_POOL
  if (poolEnv) {
    const pool = poolEnv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    if (pool.length > 0) next.splitTestPool = pool
  }
  if (env.LLM_JUDGE_MODEL) next.judge = env.LLM_JUDGE_MODEL
  if (env.LLM_EXCLUDE) {
    const extra = env.LLM_EXCLUDE.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    if (extra.length > 0) {
      // Union with the config's exclude list; preserve declared order with config first.
      const seen = new Set(next.exclude)
      const merged = [...next.exclude]
      for (const id of extra) {
        if (!seen.has(id)) {
          merged.push(id)
          seen.add(id)
        }
      }
      next.exclude = merged
    }
  }
  return next
}

// --------------------------------------------------------------------
// Config persistence
// --------------------------------------------------------------------

/**
 * Resolve the memory directory where @bearly/llm reads/writes its state.
 *
 * Single dir per user — config (dual-pro-config.json) + data
 * (ab-pro.jsonl, dual-pro-promotions.jsonl, backtest-runs.jsonl,
 * challenger-counter) live together. Per user direction, we deliberately
 * don't split into XDG_CONFIG_HOME + XDG_DATA_HOME — too much magic for
 * tooling that already expects a single location. Set LLM_DIR (or
 * BEARLY_LLM_MEMORY_DIR) to override.
 *
 * Resolution chain (priority order):
 *   1. BEARLY_LLM_MEMORY_DIR env var (explicit override)
 *   2. LLM_DIR env var (shorter alias — same semantic)
 *   3. CLAUDE_PROJECT_DIR set? → ~/.claude/projects/<encoded-cwd>/memory
 *      (Claude-Code back-compat: per-project state)
 *   4. ~/.config/llm/  (default for standalone usage)
 */
export function getMemoryDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BEARLY_LLM_MEMORY_DIR) return env.BEARLY_LLM_MEMORY_DIR
  if (env.LLM_DIR) return env.LLM_DIR
  const home = env.HOME || ""
  if (env.CLAUDE_PROJECT_DIR) {
    const encoded = env.CLAUDE_PROJECT_DIR.replace(/\//g, "-")
    return `${home}/.claude/projects/${encoded}/memory`
  }
  return `${home}/.config/llm`
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
      // Parse the raw input shape (accepts both v0.6 legacy and v0.7 new
      // fields) then normalize. This is what makes the schema migration
      // back-compatible: a config file with only `champion`+`runnerUp`+
      // `challengerPool` still loads cleanly into the new internal shape.
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

/** Render a JSONC starter config with comments explaining each field.
 *
 * Writes the v0.7 shape (mainstays + splitTestPool + splitTestSlots). The
 * loader still reads the v0.6 shape (champion/runnerUp/challengerPool) for
 * back-compat, but new files always start in the new shape. */
export function renderStarterConfig(cfg: DualProConfig): string {
  return `// dual-pro-config.json — controls bun llm pro multi-leg dispatch.
// Each field documented inline. Edit and save; takes effect on next /pro call.
{
  // Mainstays — two stable models that fire every call. Anchor judge
  // calibration with a low-variance baseline. Convention: position 0 is
  // a frontier reasoning anchor (punch-through intellectual issues),
  // position 1 is a proven cheap baseline (sanity-check + low cost).
  // Env override: LLM_DUAL_PRO_B=<modelId> overrides position 1.
  "mainstays": ${JSON.stringify(cfg.mainstays)},

  // Split-test pool — slots C and D rotate through this list to cover
  // candidate models faster. Slot C uses splitTestStrategy; slot D
  // re-faces the most-recent winner against mainstays (correlated
  // re-test — confirms wins reproduce instead of pure pool exploration).
  // Env override: LLM_SPLIT_TEST_POOL=id1,id2,id3 (LLM_CHALLENGER_POOL
  // also accepted for back-compat).
  "splitTestPool": ${JSON.stringify(cfg.splitTestPool)},

  // How many split-test slots fire per call (0–4). Defaults to 2 →
  // full 2+2 fleet (4 legs in parallel). Set 0 to revert to mainstays-only;
  // set 1 for legacy 3-leg behavior. Per-call override: --legs N flag.
  "splitTestSlots": ${JSON.stringify(cfg.splitTestSlots)},

  // Strategy for picking slot C. round-robin-after-N-calls steps the
  // index every N successful dispatches; random picks each call. Slot D
  // always uses correlated re-test (most-recent winner not in mainstays
  // and not slot C; cold-start falls back to slot C strategy +1 offset).
  "splitTestStrategy": ${JSON.stringify(cfg.splitTestStrategy)},

  // Cheap model that scores responses pairwise (B-vs-A, C-vs-A, D-vs-A).
  // 3 cheap pairwise calls > 1 saturated 4-way prompt — pairwise judging
  // sidesteps position bias and context dilution. Gemini 2.5 Flash at
  // ~$0.001/call → ~$0.003 total, often cheaper than one bloated 4-way.
  // Env override: LLM_JUDGE_MODEL=<modelId>
  "judge": ${JSON.stringify(cfg.judge)},

  // Scoring rubric. "default" is balanced; "review" emphasizes correctness;
  // "research" emphasizes depth; "code" emphasizes specificity.
  "rubric": ${JSON.stringify(cfg.rubric)},

  // Leaderboard ranking. Rank optimizes for raw intellect (judge score),
  // with a log-scale cost penalty so extreme priciness brings score down.
  // Speed and failure rate are display-only (failures assumed to be
  // programming errors / retryable, not a model property).
  //
  //   rank = score * avgScore - cost * max(0, log10(avgCost / costThreshold))
  //
  // Defaults — costThreshold $0.10, cost 1.0:
  //   $0.10 → 0pt    $1 → −1pt    $10 → −2pt    $100 → −3pt
  //
  // Set cost: 0 to rank purely by quality. Raise cost to punish pricey models harder.
  // qualityWarningThreshold flags models whose avgScore drops below it AND
  // have ≥ 20 calls (visual ⚠️ in the leaderboard). Add the model to "exclude"
  // below to actually remove it from rotation.
  "scoreWeights": ${JSON.stringify(cfg.scoreWeights, null, 2).replace(/\n/g, "\n  ")},

  // List of model IDs to exclude from all dispatch paths (mainstays + split-
  // test slots). Use this to drop a junk model surfaced by the ⚠️ quality
  // warning badge in the leaderboard. Mainstays listed here log a stderr
  // warning but still dispatch (explicit config wins).
  // Env override: LLM_EXCLUDE=id1,id2,id3 (joins with this list).
  "exclude": ${JSON.stringify(cfg.exclude)}
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
  exclude: readonly string[] = [],
): { modelId: string | undefined; nextCounter: number } {
  // Filter excluded IDs FIRST — rotation should never land on a model the
  // user has explicitly muted. Junk-model surfacing happens via the leaderboard
  // warning badge; eviction happens via this filter.
  const filtered = exclude.length > 0 ? pool.filter((id) => !exclude.includes(id)) : pool
  if (filtered.length === 0) return { modelId: undefined, nextCounter: counter }
  const safeCounter = Math.max(0, Math.floor(counter))
  switch (strategy) {
    case "random": {
      const i = Math.floor(Math.random() * filtered.length)
      return { modelId: filtered[i], nextCounter: safeCounter + 1 }
    }
    case "round-robin": {
      const i = safeCounter % filtered.length
      return { modelId: filtered[i], nextCounter: safeCounter + 1 }
    }
    case "round-robin-after-5-calls": {
      const i = Math.floor(safeCounter / 5) % filtered.length
      return { modelId: filtered[i], nextCounter: safeCounter + 1 }
    }
    case "round-robin-after-10-calls": {
      const i = Math.floor(safeCounter / 10) % filtered.length
      return { modelId: filtered[i], nextCounter: safeCounter + 1 }
    }
  }
}

/**
 * Pick the next [slotC, slotD] pair for the split-test fleet.
 *
 * Slot C: standard rotation (same logic as `pickNextChallenger`).
 * Slot D: **correlated re-test** — most recent winner from `history` that
 *   is neither a mainstay nor slot C, providing reproducibility evidence
 *   for emerging contenders. Cold start (no winner history) falls back to
 *   slot C's strategy with a +1 round-robin offset, so slots C and D never
 *   collide and the second slot still explores the pool.
 *
 * The "winner" is read from `history` entries, looking at the most recent
 * `lookback` entries (default 10). The `judgeWinner` field on each entry
 * names which leg won; `legs[winnerKey]` resolves to the model id.
 *
 * Pure — no I/O. Caller threads `counter` and `history` in.
 */
export function pickSplitTestSlots(
  pool: readonly string[],
  strategy: ChallengerStrategy,
  counter: number,
  history: readonly { winnerModelId?: string }[],
  mainstays: readonly string[],
  exclude: readonly string[] = [],
  opts: { lookback?: number } = {},
): { slotC: string | undefined; slotD: string | undefined; nextCounter: number } {
  const c = pickNextChallenger(pool, strategy, counter, exclude)
  const slotC = c.modelId
  // Find the most-recent winner that is NOT a mainstay and NOT slot C.
  const lookback = Math.max(1, opts.lookback ?? 10)
  const recent = history.slice(-lookback)
  let slotD: string | undefined
  for (let i = recent.length - 1; i >= 0; i--) {
    const w = recent[i]?.winnerModelId
    if (!w) continue
    if (mainstays.includes(w)) continue
    if (slotC && w === slotC) continue
    if (exclude.includes(w)) continue
    if (!pool.includes(w)) continue
    slotD = w
    break
  }
  if (!slotD) {
    // Cold start: pick the next pool member AFTER slot C in pool-list
    // order, so the two slots cover different pool members on first run.
    // (Re-running pickNextChallenger with counter+1 doesn't give "next pool
    // entry" semantics because it mods by the filtered-pool length — we
    // want the literal next-available pool member.)
    const remaining = pool.filter((id) => !exclude.includes(id) && !mainstays.includes(id) && id !== slotC)
    if (remaining.length > 0) slotD = remaining[0]
  }
  return { slotC, slotD, nextCounter: c.nextCounter }
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
 * Build the legacy N-way judge prompt (3 or 4 responses in one prompt).
 *
 * **Prefer `buildPairwiseJudgePrompt`** for new code — feeding 4 distinct
 * LLM responses into a single judge prompt suffers from position bias and
 * context-saturation, and has been measured to degrade judge accuracy.
 * Three cheap pairwise calls (B-vs-A, C-vs-A, D-vs-A) is more reliable
 * AND usually cheaper. This function is kept for the backtest replay path
 * (which compares OLD vs NEW outcomes legacy-style) and any v2 entry that
 * is being re-judged after the fact.
 *
 * The judge is told to score each leg on the rubric (1–5 per dimension,
 * sum = total) and pick a winner. Output is strict JSON — see
 * parseJudgeResponse.
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
  d: JudgeBreakdownSchema.nullable().optional(),
  winner: z.union([z.literal("a"), z.literal("b"), z.literal("c"), z.literal("d"), z.literal("tie")]),
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
// Pairwise judge — 2 responses at a time, run 3 times in parallel
// (B-vs-A, C-vs-A, D-vs-A). Sidesteps N-way position bias + context
// saturation that degrades single-prompt 4-way judging accuracy.
// --------------------------------------------------------------------

export type PairwiseSide = "A" | "B"
export type PairwiseWinner = "A" | "B" | "tie"
export type PairwisePairId = "ab" | "ac" | "ad"

export const PairwiseJudgeResultSchema = z.object({
  winner: z.union([z.literal("A"), z.literal("B"), z.literal("tie")]),
  scoreA: JudgeBreakdownSchema.nullable(),
  scoreB: JudgeBreakdownSchema.nullable(),
  reasoning: z.string().optional(),
})
export type PairwiseJudgeResult = z.infer<typeof PairwiseJudgeResultSchema>

/** Build a pairwise judge prompt — A is the anchor (a mainstay), B is the
 * contender. Judge picks A / B / tie and scores both on the rubric. */
export function buildPairwiseJudgePrompt(args: {
  question: string
  pair: { a: { model: string; content: string }; b: { model: string; content: string } }
  rubric: Rubric
}): string {
  const { question, pair, rubric } = args
  const def = RUBRIC_DEFINITIONS[rubric]
  const trunc = (s: string) => (s.length > 4000 ? s.slice(0, 4000) + "\n…[truncated]" : s)
  return `You are scoring two LLM responses to the same question on a rubric.

QUESTION:
${question}

### Response A (${pair.a.model})

${trunc(pair.a.content)}

### Response B (${pair.b.model})

${trunc(pair.b.content)}

RUBRIC: ${rubric}
${def.emphasis}

Score each response on these dimensions (1=poor, 5=excellent):
${def.dimensions.map((d) => `- ${d}`).join("\n")}

Pick the winner — response with the higher TOTAL (sum of dimension scores).
If the totals are within 1 point, return "tie".

Output STRICT JSON, nothing else (no markdown fence, no prose):
{
  "scoreA": { "scores": { "specificity": N, "actionability": N, "correctness": N, "depth": N }, "total": N },
  "scoreB": { "scores": { "specificity": N, "actionability": N, "correctness": N, "depth": N }, "total": N },
  "winner": "A" | "B" | "tie",
  "reasoning": "one-sentence justification"
}`
}

/** Parse a pairwise judge response. Same fence/prose tolerance as
 * `parseJudgeResponse`. Returns undefined on unparseable / schema-mismatched
 * output. */
export function parsePairwiseJudgeResponse(raw: string): PairwiseJudgeResult | undefined {
  if (!raw) return undefined
  let text = raw.trim()
  if (text.startsWith("```")) {
    text = text
      .replace(/^```[a-zA-Z]*\n?/, "")
      .replace(/```$/, "")
      .trim()
  }
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  try {
    const obj = JSON.parse(text.slice(start, end + 1))
    return PairwiseJudgeResultSchema.parse(obj)
  } catch {
    return undefined
  }
}

/**
 * Synthesize a pairwise result from a v2 N-way judge result + the leg
 * scores. Used by the v2→v3 reader so historical entries surface a uniform
 * `judge.ab` / `judge.ac` shape to consumers (leaderboard, backtest,
 * judge-history). If both leg scores are missing we return undefined so
 * the consumer can short-circuit instead of inventing a verdict.
 */
export function synthesizePairwiseFromV2(
  scoreA: JudgeBreakdown | null | undefined,
  scoreB: JudgeBreakdown | null | undefined,
  v2Winner: "a" | "b" | "c" | "tie" | undefined,
  v2WinnerKey: "a" | "b" | "c",
): PairwiseJudgeResult | undefined {
  if (!scoreA && !scoreB) return undefined
  const a = scoreA?.total ?? 0
  const b = scoreB?.total ?? 0
  // Map v2's global winner to this pair's verdict only when this pair
  // contains the global winner. Otherwise infer from the totals (within
  // 1 point = tie, mirroring the live judge rule).
  let winner: PairwiseWinner
  if (v2Winner === "tie") winner = "tie"
  else if (v2Winner === "a") winner = "A"
  else if (v2Winner === v2WinnerKey) winner = "B"
  else if (Math.abs(a - b) <= 1) winner = "tie"
  else winner = a >= b ? "A" : "B"
  return { winner, scoreA: scoreA ?? null, scoreB: scoreB ?? null }
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
  /** Inline response content (added 2026-04-27 for retroactive judging).
   * Pre-existing entries lack this and must fall back to entry.outputFile. */
  content?: string
}

/** Schema-aware reader for ab-pro.jsonl entries — tolerates v1 (gpt/kimi),
 * v2 (a/b/c + N-way judge), and v3 (a/b/c/d + pairwise judge) shapes. */
export interface AbProEntry {
  schema?: string
  timestamp?: string
  question?: string
  a?: AbProLegEntry
  b?: AbProLegEntry
  c?: AbProLegEntry
  /** v3 — split-test slot D (correlated re-test of recent winner). */
  d?: AbProLegEntry
  // v1 legacy fields (gpt/kimi). Reader normalizes to a/b.
  gpt?: { model: string; ok: boolean; cost?: number; durationMs?: number }
  kimi?: { model: string; ok: boolean; cost?: number; durationMs?: number }
  /** v2 shape: judge: { model, winner, reasoning, error, cost, rubric, a, b, c }
   *  v3 shape: judge: { model, rubric, error, cost, ab, ac?, ad? }
   *  Both still ship `winner`/`reasoning` at the top level for back-compat
   *  with v2 readers (synthesized from the AB pair on v3 writes). */
  judge?: {
    model?: string
    rubric?: string
    error?: string
    cost?: number
    winner?: "a" | "b" | "c" | "d" | "tie"
    reasoning?: string
    a?: JudgeBreakdown | null
    b?: JudgeBreakdown | null
    c?: JudgeBreakdown | null
    d?: JudgeBreakdown | null
    ab?: PairwiseJudgeResult
    ac?: PairwiseJudgeResult
    ad?: PairwiseJudgeResult
    result?: JudgeResult
  }
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
    // not avgScore. v2 emits BOTH gpt/kimi AND a/b — to avoid double-
    // counting we only consume the v1 keys when no v2/v3 leg keys are
    // present on the entry.
    if (!e.a && !e.b) {
      if (e.gpt) bumpLeg({ model: e.gpt.model, ok: e.gpt.ok, cost: e.gpt.cost, durationMs: e.gpt.durationMs })
      if (e.kimi) bumpLeg({ model: e.kimi.model, ok: e.kimi.ok, cost: e.kimi.cost, durationMs: e.kimi.durationMs })
    }
    bumpLeg(e.a)
    bumpLeg(e.b)
    bumpLeg(e.c)
    bumpLeg(e.d)
  }
  const rows: LeaderboardRow[] = []
  for (const [model, s] of stats) {
    const avgScore = s.success > 0 ? s.scoreSum / s.success : 0
    const avgCost = s.success > 0 ? s.costSum / s.success : 0
    const avgTimeMs = s.success > 0 ? s.timeSum / s.success : 0
    const failureRate = s.calls > 0 ? (s.calls - s.success) / s.calls : 0
    // Higher is better. Quality-first; log-scale cost penalty above threshold.
    // Speed and failure rate are display-only — not in rank.
    const threshold = weights.costThreshold > 0 ? weights.costThreshold : 0.1
    const costPenalty = avgCost > threshold ? Math.log10(avgCost / threshold) : 0
    const rankScore = avgScore * weights.score - costPenalty * weights.cost
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
  oldWinner?: "a" | "b" | "c" | "d" | "tie"
  newWinner?: "a" | "b" | "c" | "d" | "tie"
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
  const m0 = proIds[0] ?? DEFAULT_CONFIG.mainstays[0]
  const m1 = proIds[1] ?? DEFAULT_CONFIG.mainstays[1]
  // Split-test pool = remaining BEST_MODELS.pro entries plus a couple of
  // cross-provider candidates that aren't already a mainstay.
  const seen = new Set([m0, m1])
  const pool: string[] = []
  for (const id of proIds.slice(2)) {
    if (!seen.has(id)) {
      pool.push(id)
      seen.add(id)
    }
  }
  // Pad with diverse picks so a fresh install has a real split-test set.
  for (const id of ["gemini-3-pro-preview", "grok-4", "claude-opus-4-6"]) {
    if (!seen.has(id) && getModel(id)) {
      pool.push(id)
      seen.add(id)
    }
  }
  return {
    ...DEFAULT_CONFIG,
    mainstays: [m0, m1],
    splitTestPool: pool.length > 0 ? pool : DEFAULT_CONFIG.splitTestPool,
  }
}

/** Resolve a model ID against MODELS, with friendly null handling. */
export function resolveModel(id: string | undefined): Model | undefined {
  if (!id) return undefined
  return getModel(id)
}
