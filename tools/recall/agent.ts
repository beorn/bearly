/**
 * agent.ts — LLM-driven recall orchestrator.
 *
 * Replaces the default FTS5-only path with:
 *   1. Build a context bundle (cached by DB mtime).
 *   2. Round 1: plan → fan-out → coverage rerank.
 *   3. Decide round 2: off / wider / deeper, rule-based.
 *   4. Round 2 (optional): plan(mode) → fan-out → merge.
 *   5. Synthesize final answer via existing race-of-2.
 *   6. Optionally write a post-hoc trace.
 *
 * Failure modes all fall through cleanly to the existing single-query
 * `recall()` path — agent mode never makes things worse than today.
 */

import { getDb, closeDb } from "../lib/history/db.ts"
import { parseTimeToMs, recall } from "../lib/history/search.ts"
import { synthesizeResults } from "../lib/history/synthesize.ts"
import { log, THIRTY_DAYS_MS } from "../lib/history/recall-shared.ts"
import type { RecallOptions, RecallResult, RecallSearchResult } from "../lib/history/recall-shared.ts"
import { buildQueryContext, renderContextPrompt, type QueryContext } from "./context.ts"
import { planQuery, planVariants, type PlanCall, type QueryPlan } from "./plan.ts"
import { fanoutSearch, mergeFanouts, type FanoutResult } from "./fanout.ts"
import { writeTrace, type RoundTrace, type TracePayload } from "./trace.ts"

// ============================================================================
// Options
// ============================================================================

export interface AgentRecallOptions extends RecallOptions {
  /** auto (default), wider, deeper, or off. */
  round2?: "auto" | "wider" | "deeper" | "off"
  /** Cap on rounds (default 2). Useful for eval runs. */
  maxRounds?: 1 | 2
  /** Planner per-call timeout in ms (default 2500). */
  planTimeoutMs?: number
  /** Debug-plan mode — callers render the returned trace themselves. */
  debugPlan?: boolean
  /**
   * When true (default), fire synthesis on round-1 results in parallel with
   * round-2 planning. If round 2 doesn't add meaningful new top-K docs, we
   * use the speculative synth and save ~3s. If round 2 does change the top,
   * we fresh-synth on merged results (slight extra cost, same latency).
   * Set false to always synth on the final merged results (one at a time).
   */
  speculativeSynth?: boolean
}

export interface AgentRecallResult extends RecallResult {
  trace: {
    rounds: RoundTrace[]
    decision: { round2Mode: "wider" | "deeper" | "off"; reason: string }
    contextChars: number
    /** Which synth path delivered the answer. */
    synthPath?: "speculative-round1" | "fresh-merged" | "single-pass" | "none"
    /**
     * How many synth calls were actually made (billed). 1 = no waste.
     * 2 = speculative was fired AND a fresh synth was also needed —
     * the speculative answer was discarded because round 2 added new
     * top-K docs. Use this to see whether speculative mode paid off.
     */
    synthCallsUsed?: number
    /** True iff a round-1-only answer was ever produced (speculative or single-pass). */
    round1ShortCircuited?: boolean
  }
  /** Path the trace file was written to, if RECALL_AGENT_TRACE is set. */
  traceFile?: string | null
  /** True if agent mode fell through to the default recall path. */
  fellThrough?: boolean
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_PLAN_TIMEOUT_MS = 8000
const DEFAULT_SYNTH_TIMEOUT_MS = 4000
const DEFAULT_LIMIT = 10

// Round-2 decision thresholds
const STRONG_COVERAGE = 4 // top doc hit by ≥4 variants → "strong cluster"
const WEAK_DOC_COUNT = 3 // fewer than this many docs with coverage > 1 → weak
// Short-circuit (skip round 2 when round 1 is already good enough).
// We short-circuit if EITHER the fraction is high OR the absolute count is
// high. Absolute count catches specific-token queries where the planner
// produces many variants (say 26) and the top doc matches ~8 of them —
// 8/26 = 0.31 fraction (below 0.4) but 8 is a clear cluster.
const SHORT_CIRCUIT_COVERAGE_FRACTION = 0.35
const SHORT_CIRCUIT_COVERAGE_ABSOLUTE = 6

// Round-2-adds-value threshold — how many NEW top-K docs does round 2 need
// to contribute before we pay for a fresh synth on merged results?
const ROUND2_NEW_DOCS_THRESHOLD = 2

// ============================================================================
// Public API
// ============================================================================

export async function recallAgent(query: string, options: AgentRecallOptions = {}): Promise<AgentRecallResult> {
  const startedAt = Date.now()
  const {
    limit = DEFAULT_LIMIT,
    since,
    projectFilter,
    timeout = DEFAULT_SYNTH_TIMEOUT_MS,
    planTimeoutMs = DEFAULT_PLAN_TIMEOUT_MS,
    maxRounds = 2,
    round2 = "auto",
    snippetTokens = 200,
  } = options

  const db = getDb()
  const rounds: RoundTrace[] = []
  const planCosts: number[] = []
  const planElapsed: number[] = []
  const fanoutElapsed: number[] = []

  // Speculative synth defaults on — env var or explicit option can disable.
  const speculativeSynth =
    options.speculativeSynth !== undefined ? options.speculativeSynth : process.env.RECALL_SPECULATIVE_SYNTH !== "0"

  let decision: { round2Mode: "wider" | "deeper" | "off"; reason: string } = {
    round2Mode: "off",
    reason: "not-evaluated",
  }

  // ──────────────────────────────────────────────────────────────────────
  // Time filter (reuse the existing parser so the UI contract is identical)
  // ──────────────────────────────────────────────────────────────────────
  let sinceTime: number | undefined
  if (since) {
    const parsed = parseTimeToMs(since)
    if (parsed === undefined) {
      log(`agent: invalid time filter "${since}" — falling through`)
      return fallthrough(query, options, startedAt, rounds, decision)
    }
    sinceTime = parsed
  } else {
    sinceTime = Date.now() - THIRTY_DAYS_MS
  }

  // ──────────────────────────────────────────────────────────────────────
  // Context bundle
  // ──────────────────────────────────────────────────────────────────────
  let context: QueryContext
  try {
    context = buildQueryContext()
  } catch (err) {
    log(`agent: context build failed — falling through (${(err as Error).message})`)
    return fallthrough(query, options, startedAt, rounds, decision)
  }

  const contextChars = renderContextPrompt(context).length
  log(
    `agent: context built (${contextChars} chars, ${context.recentSessions.length} sessions, ${context.recentBeads.length} beads, ${context.rareVocabulary.length} vocab tokens)`,
  )

  // ──────────────────────────────────────────────────────────────────────
  // Round 1
  // ──────────────────────────────────────────────────────────────────────
  const planR1 = await planQuery(query, context, { round: 1, timeoutMs: planTimeoutMs })
  planElapsed.push(planR1.elapsedMs)
  if (planR1.cost) planCosts.push(planR1.cost)

  if (!planR1.plan) {
    log(`agent: round 1 planner failed (${planR1.error ?? "unknown"}) — falling through`)
    rounds.push(buildRoundTrace(1, undefined, planR1, [], null))
    return fallthrough(query, options, startedAt, rounds, decision, contextChars)
  }

  // Apply planner-provided time hint only if caller didn't pass --since
  if (!since && planR1.plan.time_hint) {
    const hinted = parseTimeToMs(planR1.plan.time_hint)
    if (hinted !== undefined) {
      log(`agent: applying planner time_hint "${planR1.plan.time_hint}"`)
      sinceTime = hinted
    }
  }

  const variantsR1 = planVariants(planR1.plan)
  log(`agent: round 1 plan → ${variantsR1.length} variants (planner=${planR1.model} ${planR1.elapsedMs}ms)`)

  if (variantsR1.length === 0) {
    log(`agent: round 1 produced zero variants — falling through`)
    rounds.push(buildRoundTrace(1, undefined, planR1, [], null))
    return fallthrough(query, options, startedAt, rounds, decision, contextChars)
  }

  const fanoutR1 = fanoutSearch(db, variantsR1, {
    limit,
    sinceTime,
    projectFilter,
    snippetTokens,
  })
  fanoutElapsed.push(fanoutR1.stats.msTotal)
  rounds.push(buildRoundTrace(1, undefined, planR1, variantsR1, fanoutR1))

  log(
    `agent: round 1 fanout → ${fanoutR1.stats.rawHits} raw, ${fanoutR1.stats.uniqueDocs} unique, top-coverage=${fanoutR1.stats.topCoverage}/${variantsR1.length} (${fanoutR1.stats.msTotal}ms)`,
  )

  // ──────────────────────────────────────────────────────────────────────
  // Speculative synth (runs in parallel with round 2)
  //
  // Kick off a synthesis on round-1 results before we commit to round 2.
  // If round 2 ends up not changing the top-K docs meaningfully, we'll
  // use this speculative answer — saving ~3s of serial LLM time. If
  // round 2 DOES change the top, we pay for a fresh synth on merged
  // results (the speculative call settles in the background, wasted).
  // ──────────────────────────────────────────────────────────────────────
  const speculativeSynthStart = Date.now()
  const speculativeSynthPromise: Promise<{ text: string | null; cost?: number }> | null =
    speculativeSynth && fanoutR1.results.length > 0
      ? synthesizeResults(query, fanoutR1.results, timeout).catch(() => ({ text: null }))
      : null
  if (speculativeSynthPromise) {
    log(`agent: speculative synth fired on round-1 results (${fanoutR1.results.length} docs)`)
  }

  // ──────────────────────────────────────────────────────────────────────
  // Decide round 2
  // ──────────────────────────────────────────────────────────────────────
  let finalFanout: FanoutResult = fanoutR1

  if (maxRounds >= 2 && round2 !== "off") {
    decision = chooseRound2Mode(round2, fanoutR1, variantsR1.length, limit)
    log(`agent: round 2 decision = ${decision.round2Mode} (${decision.reason})`)

    if (decision.round2Mode !== "off") {
      const planR2 = await planQuery(query, context, {
        round: 2,
        mode: decision.round2Mode,
        priorPlan: planR1.plan,
        priorResults: fanoutR1.results,
        priorVariants: variantsR1,
        timeoutMs: planTimeoutMs,
      })
      planElapsed.push(planR2.elapsedMs)
      if (planR2.cost) planCosts.push(planR2.cost)

      if (!planR2.plan) {
        const msg =
          planR2.error === "empty-plan"
            ? "round 2 planner had nothing new to add (empty plan) — keeping round 1 results"
            : `round 2 planner failed (${planR2.error ?? "unknown"}) — keeping round 1 results`
        log(`agent: ${msg}`)
        rounds.push(buildRoundTrace(2, decision.round2Mode, planR2, [], null))
      } else {
        // Filter out variants we already tried in round 1
        const r1Set = new Set(variantsR1)
        const variantsR2 = planVariants(planR2.plan).filter((v) => !r1Set.has(v))
        log(`agent: round 2 plan → ${variantsR2.length} NEW variants (planner=${planR2.model} ${planR2.elapsedMs}ms)`)

        if (variantsR2.length > 0) {
          const fanoutR2 = fanoutSearch(db, variantsR2, {
            limit,
            sinceTime,
            projectFilter,
            snippetTokens,
          })
          fanoutElapsed.push(fanoutR2.stats.msTotal)
          rounds.push(buildRoundTrace(2, decision.round2Mode, planR2, variantsR2, fanoutR2))
          log(
            `agent: round 2 fanout → ${fanoutR2.stats.rawHits} raw, ${fanoutR2.stats.uniqueDocs} unique, top-coverage=${fanoutR2.stats.topCoverage}/${variantsR2.length} (${fanoutR2.stats.msTotal}ms)`,
          )
          finalFanout = mergeFanouts(fanoutR1, fanoutR2, limit)
        } else {
          rounds.push(buildRoundTrace(2, decision.round2Mode, planR2, [], null))
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Synthesis — choose between speculative (round-1) and fresh (merged)
  //
  // If round 2 ran AND contributed ≥2 new top-K docs, the speculative
  // synth is now stale — run a fresh synth on merged results. Otherwise
  // the speculative result reflects what matters, and we save ~3s.
  // ──────────────────────────────────────────────────────────────────────
  const synthStart = Date.now()
  let synthesis: { text: string | null; cost?: number } = { text: null }
  let synthPath: NonNullable<AgentRecallResult["trace"]["synthPath"]> = "none"
  let synthCallsUsed = 0
  let round1ShortCircuited = false

  if (finalFanout.results.length > 0) {
    const round2Ran = finalFanout !== fanoutR1
    const newDocsInTop = round2Ran ? countNewDocsInTopK(fanoutR1.results, finalFanout.results, limit) : 0

    const useSpeculative = speculativeSynthPromise !== null && (!round2Ran || newDocsInTop < ROUND2_NEW_DOCS_THRESHOLD)

    if (useSpeculative) {
      const specResult = await speculativeSynthPromise!
      synthesis = { text: specResult.text, cost: specResult.cost }
      synthPath = round2Ran ? "speculative-round1" : "single-pass"
      synthCallsUsed = 1
      round1ShortCircuited = true
      const saved = Date.now() - speculativeSynthStart
      log(
        `agent: using speculative synth on round 1 (${round2Ran ? `r2 added ${newDocsInTop}<${ROUND2_NEW_DOCS_THRESHOLD} new top-K` : "no round 2"}, elapsed=${saved}ms, 1 synth call)`,
      )
    } else {
      // Fresh synth on merged results. Await the speculative synth too
      // (usually already done) to capture its cost — it was a real billed
      // call whose result we're abandoning, and our cost + synth-count
      // report should reflect that honestly.
      const [freshResult, abandonedSpec] = await Promise.all([
        synthesizeResults(query, finalFanout.results, timeout),
        speculativeSynthPromise ?? Promise.resolve({ text: null as string | null, cost: undefined }),
      ])
      synthesis = {
        text: freshResult.text,
        cost: (freshResult.cost ?? 0) + (abandonedSpec.cost ?? 0),
      }
      synthPath = round2Ran ? "fresh-merged" : "single-pass"
      synthCallsUsed = speculativeSynthPromise ? 2 : 1
      round1ShortCircuited = false
      log(
        `agent: using fresh synth on ${round2Ran ? `merged results (r2 added ${newDocsInTop} new top-K)` : "round 1 results (speculative disabled)"} — ${synthCallsUsed} synth call${synthCallsUsed === 1 ? "" : "s"}${
          abandonedSpec.cost ? ` (abandoned spec cost $${abandonedSpec.cost.toFixed(4)})` : ""
        }`,
      )
    }
  }
  const synthMs = Date.now() - synthStart

  const totalMs = Date.now() - startedAt
  const plannerUsd = planCosts.reduce((s, x) => s + x, 0)
  const synthUsd = synthesis.cost ?? 0

  log(
    `agent: done — ${finalFanout.results.length} results, synth=${synthesis.text ? "ok" : "none"} (total=${totalMs}ms, plan=${planElapsed.reduce((a, b) => a + b, 0)}ms, fanout=${fanoutElapsed.reduce((a, b) => a + b, 0)}ms, synth=${synthMs}ms, cost=$${(plannerUsd + synthUsd).toFixed(4)})`,
  )

  const result: AgentRecallResult = {
    query,
    synthesis: synthesis.text,
    results: finalFanout.results,
    durationMs: totalMs,
    llmCost: plannerUsd + synthUsd,
    timing: {
      searchMs: fanoutElapsed.reduce((a, b) => a + b, 0),
      llmMs: planElapsed.reduce((a, b) => a + b, 0) + synthMs,
    },
    trace: { rounds, decision, contextChars, synthPath, synthCallsUsed, round1ShortCircuited },
  }

  const traceFile = writeTrace(buildTracePayload(result, options, context, synthMs, plannerUsd, synthUsd))
  if (traceFile) result.traceFile = traceFile

  closeDb()
  return result
}

// ============================================================================
// Round-2 decision
// ============================================================================

function chooseRound2Mode(
  requested: "auto" | "wider" | "deeper" | "off",
  fanoutR1: FanoutResult,
  variantCount: number,
  limit: number,
): { round2Mode: "wider" | "deeper" | "off"; reason: string } {
  if (requested === "off") return { round2Mode: "off", reason: "forced-off" }
  if (requested === "wider") return { round2Mode: "wider", reason: "forced-wider" }
  if (requested === "deeper") return { round2Mode: "deeper", reason: "forced-deeper" }

  // auto
  const { stats, results } = fanoutR1

  // Short-circuit: round 1 is already good enough.
  //   Fraction ≥ 0.35 covers queries with a clear majority consensus.
  //   Absolute ≥ 6 covers specific-token queries where variant count is high
  //     (e.g., 8/26 = 0.31 fraction but 8 is still a strong cluster).
  const coverageFraction = variantCount > 0 ? stats.topCoverage / variantCount : 0
  const haveFullResults = results.length >= limit
  const fractionShort = coverageFraction >= SHORT_CIRCUIT_COVERAGE_FRACTION
  const absoluteShort = stats.topCoverage >= SHORT_CIRCUIT_COVERAGE_ABSOLUTE
  if (haveFullResults && (fractionShort || absoluteShort)) {
    const rationale = fractionShort
      ? `fraction=${coverageFraction.toFixed(2)}≥${SHORT_CIRCUIT_COVERAGE_FRACTION}`
      : `absolute=${stats.topCoverage}≥${SHORT_CIRCUIT_COVERAGE_ABSOLUTE}`
    return {
      round2Mode: "off",
      reason: `short-circuit (top-coverage=${stats.topCoverage}/${variantCount}, ${rationale}, results=${results.length}/${limit})`,
    }
  }

  // Zero results — always widen
  if (stats.uniqueDocs === 0) {
    return { round2Mode: "wider", reason: "zero-results → widen" }
  }

  // Strong cluster → deeper
  if (stats.topCoverage >= STRONG_COVERAGE) {
    return {
      round2Mode: "deeper",
      reason: `strong-cluster (top-coverage=${stats.topCoverage} ≥ ${STRONG_COVERAGE})`,
    }
  }

  // Weak coverage → wider
  const docsWithMultipleHits = countDocsAbove(fanoutR1.hitCounts, 1)
  if (docsWithMultipleHits < WEAK_DOC_COUNT) {
    return {
      round2Mode: "wider",
      reason: `weak-coverage (${docsWithMultipleHits} docs with >1 hit)`,
    }
  }

  // Moderate — default to deeper since we have some cluster signal
  return {
    round2Mode: "deeper",
    reason: `moderate-coverage (${docsWithMultipleHits} multi-hit docs)`,
  }
}

function countDocsAbove(hitCounts: Map<string, number>, threshold: number): number {
  let n = 0
  for (const v of hitCounts.values()) if (v > threshold) n++
  return n
}

/**
 * How many of the top-K docs in `after` are NOT present in top-K of `before`?
 * Used to decide if round 2 meaningfully changed the answer set — below the
 * threshold, the speculative synth on round-1 results is still fine.
 */
function countNewDocsInTopK(before: RecallSearchResult[], after: RecallSearchResult[], k: number): number {
  const beforeKeys = new Set(before.slice(0, k).map((r) => `${r.type}:${r.sessionId}`))
  let n = 0
  for (const r of after.slice(0, k)) {
    const key = `${r.type}:${r.sessionId}`
    if (!beforeKeys.has(key)) n++
  }
  return n
}

// ============================================================================
// Trace helpers
// ============================================================================

function buildRoundTrace(
  round: 1 | 2,
  mode: "wider" | "deeper" | undefined,
  planCall: PlanCall,
  variants: string[],
  fanout: FanoutResult | null,
): RoundTrace {
  return {
    round,
    mode,
    planner: {
      model: planCall.model ?? null,
      elapsedMs: planCall.elapsedMs,
      error: planCall.error,
    },
    plan: planCall.plan,
    variants,
    stats: fanout?.stats ?? {
      totalQueries: 0,
      rawHits: 0,
      uniqueDocs: 0,
      topCoverage: 0,
      medianCoverage: 0,
      msTotal: 0,
    },
  }
}

function buildTracePayload(
  result: AgentRecallResult,
  options: AgentRecallOptions,
  context: QueryContext,
  synthMs: number,
  plannerUsd: number,
  synthUsd: number,
): TracePayload {
  return {
    query: result.query,
    options,
    context: {
      chars: result.trace.contextChars,
      sessions: context.recentSessions.length,
      beads: context.recentBeads.length,
      vocabTokens: context.rareVocabulary.length,
    },
    rounds: result.trace.rounds,
    decision: result.trace.decision,
    synthPath: result.trace.synthPath,
    synthCallsUsed: result.trace.synthCallsUsed,
    round1ShortCircuited: result.trace.round1ShortCircuited,
    results: result.results.map((r) => ({
      sessionId: r.sessionId,
      type: r.type,
      title: r.sessionTitle,
      rank: r.rank,
    })),
    synthesisText: result.synthesis,
    timing: {
      planMs: result.trace.rounds.map((r) => r.planner.elapsedMs),
      fanoutMs: result.trace.rounds.map((r) => r.stats.msTotal),
      synthMs,
      totalMs: result.durationMs,
    },
    costs: {
      plannerUsd,
      synthesisUsd: synthUsd,
      totalUsd: plannerUsd + synthUsd,
    },
  }
}

// ============================================================================
// Fallthrough
// ============================================================================

async function fallthrough(
  query: string,
  options: AgentRecallOptions,
  startedAt: number,
  rounds: RoundTrace[],
  decision: { round2Mode: "wider" | "deeper" | "off"; reason: string },
  contextChars = 0,
): Promise<AgentRecallResult> {
  const baseline = await recall(query, options)
  return {
    ...baseline,
    durationMs: Date.now() - startedAt,
    trace: { rounds, decision, contextChars },
    fellThrough: true,
  }
}
