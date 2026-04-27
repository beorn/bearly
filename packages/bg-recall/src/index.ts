/**
 * @bearly/bg-recall — barrel export
 *
 * Standalone-ready package: a daemon that watches active Claude Code sessions,
 * runs entity-driven recall queries, and injects high-relevance hints via the
 * tribe channel. The daemon is built around four primitives — a Pipeline (pure
 * scoring + dedup), a Throttle (per-session rate limit), Metrics
 * (adoption + per-session counts), and a Logger (JSONL).
 *
 * Hosts wire the package together by passing in:
 *   - `sources` — per-source `recall(query)` async functions
 *   - `tribeSend` — wired to the tribe daemon's `tribe.send` RPC
 *   - `qualityGate` — composed with @bearly/recall's `analyzeQuality`
 *
 * The package never speaks Unix sockets or shells out — it's pure logic + a
 * tiny lifecycle. The host (`bg-recall.ts` in bearly tools/) owns the IPC.
 */

export { createBgRecallDaemon } from "./daemon.ts"
export type { BgRecallConfig, BgRecallDaemon } from "./daemon.ts"

export { createPipeline, DEFAULT_PIPELINE_CONFIG } from "./pipeline.ts"
export type { Pipeline, PipelineConfig } from "./pipeline.ts"

export { createThrottle, DEFAULT_THROTTLE } from "./throttle.ts"
export type { Throttle, ThrottleConfig } from "./throttle.ts"

export { createMetrics, DEFAULT_METRICS_CONFIG } from "./metrics.ts"
export type { Metrics, MetricsConfig } from "./metrics.ts"

export { createExplainRing } from "./explain.ts"
export type { ExplainRing } from "./explain.ts"

export { extractEntities, extractShingles, entitiesFromToolCall, entityOverlap } from "./entities.ts"
export { rankHits, scoreHit, DEFAULT_WEIGHTS } from "./relevance.ts"
export type { RelevanceWeights, ScoreOpts } from "./relevance.ts"

export { sanitizeForChannel, rewriteImperativeAsReported } from "./sanitize.ts"

export { formatStatus, formatExplain, shortPath } from "./status.ts"

export type {
  AdoptionStatus,
  DaemonStatus,
  Decision,
  Hint,
  QualityGate,
  RecallFn,
  RecallHit,
  RecallQueryResult,
  RejectReason,
  ScoredHit,
  SessionMetrics,
  ToolCallEvent,
  TribeSend,
} from "./types.ts"
