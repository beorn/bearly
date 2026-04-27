/**
 * Relevance scoring — turns a bag of recall hits into ranked candidates.
 *
 * Score = w_rank·normalizedRank + w_overlap·entityOverlap +
 *         w_recency·recency + w_reinforcement·reinforcement
 *
 * Each component is normalized to [0, 1] before weighting so per-source
 * threshold tuning (qmd vs bearly) operates in the same unit. Weights default
 * to (0.35, 0.30, 0.20, 0.15) — entity overlap matters more than raw FTS rank
 * because the daemon's job is "is this hit about what the model is doing right
 * now?", not "is this hit globally famous?".
 */

import { entityOverlap } from "./entities.ts"
import type { RecallHit, ScoredHit } from "./types.ts"

export type RelevanceWeights = {
  rank: number
  entityOverlap: number
  recency: number
  reinforcement: number
}

export const DEFAULT_WEIGHTS: RelevanceWeights = {
  rank: 0.35,
  entityOverlap: 0.3,
  recency: 0.2,
  reinforcement: 0.15,
}

export type ReinforcementLookup = (hitId: string) => number

export type ScoreOpts = {
  /** Window entities — what the session has been touching recently. */
  windowEntities: string[]
  /** Per-source threshold (0..1) — hits below this floor are dropped pre-rank. */
  threshold: number
  /** Weight overrides. */
  weights?: Partial<RelevanceWeights>
  /** Reinforcement lookup — defaults to 0 (neutral) for unseen hits. */
  reinforcement?: ReinforcementLookup
  /** Wallclock for recency decay. Defaults to Date.now(). */
  now?: number
  /** Recency half-life in ms. Default: 7 days. */
  halfLifeMs?: number
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Score a single hit. Pure function — exposed for unit tests.
 *
 * Rank normalization: FTS ranks are typically negative-log scores from BM25;
 * lower (more negative) = better. We normalize via 1/(1+|rank|) so a rank of 0
 * → 1.0, and very-bad rank → ~0. Hits with `rank: 0` (no FTS score) treat as
 * neutral 0.5.
 */
export function scoreHit(hit: RecallHit, opts: ScoreOpts): ScoredHit {
  const w = { ...DEFAULT_WEIGHTS, ...opts.weights }
  const now = opts.now ?? Date.now()
  const halfLife = opts.halfLifeMs ?? SEVEN_DAYS_MS

  const rankComponent = hit.rank === 0 ? 0.5 : 1 / (1 + Math.abs(hit.rank))

  // Entity overlap reuses the Jaccard from entities.ts. The hit's own text
  // gets entity-extracted at score-time so the daemon doesn't have to thread
  // pre-extracted entity sets through every layer.
  const hitEntities = entityOverlap(opts.windowEntities, extractHitEntities(hit))
  // Already in [0, 1].
  const overlapComponent = hitEntities

  const recencyComponent = computeRecency(hit.ts, now, halfLife)

  const reinforcementComponent = clamp01(opts.reinforcement?.(hit.id) ?? 0)

  const score =
    w.rank * rankComponent +
    w.entityOverlap * overlapComponent +
    w.recency * recencyComponent +
    w.reinforcement * reinforcementComponent

  return {
    ...hit,
    score,
    components: {
      rank: rankComponent,
      entityOverlap: overlapComponent,
      recency: recencyComponent,
      reinforcement: reinforcementComponent,
    },
  }
}

/**
 * Score a batch of hits and return them sorted by score (descending).
 * Hits below the threshold are dropped.
 */
export function rankHits(hits: RecallHit[], opts: ScoreOpts): ScoredHit[] {
  return hits
    .map((h) => scoreHit(h, opts))
    .filter((h) => h.score >= opts.threshold)
    .sort((a, b) => b.score - a.score)
}

function computeRecency(ts: string | undefined, now: number, halfLifeMs: number): number {
  if (!ts) return 0.5
  const then = Date.parse(ts)
  if (Number.isNaN(then)) return 0.5
  const ageMs = Math.max(0, now - then)
  // Exponential decay: 1.0 at age=0, 0.5 at halfLife, ~0 at infinity.
  return Math.pow(0.5, ageMs / halfLifeMs)
}

function clamp01(x: number): number {
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

function extractHitEntities(hit: RecallHit): string[] {
  // Cheap inline — full extraction lives in entities.ts. The hit body is
  // typically ~200 chars (snippet), so a one-shot regex sweep is fine.
  const out = new Set<string>()
  const text = `${hit.title} ${hit.snippet}`
  for (const m of text.matchAll(/([\w./-]+\.(md|ts|tsx|js|json|sh|py|rs|toml|yml|yaml))\b/gi)) {
    out.add(m[1]!.toLowerCase())
  }
  for (const m of text.matchAll(/\b([a-z][\w-]*\.[\w.-]+)\b/gi)) {
    out.add(m[1]!.toLowerCase())
  }
  return Array.from(out)
}
