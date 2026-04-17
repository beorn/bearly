/**
 * @bearly/recall — barrel export
 *
 * Session history recall: FTS-indexed search, LLM-driven planner, multi-round
 * agent over Claude Code transcripts. Stateless per-call library + CLI.
 *
 * Used standalone via `bun recall` CLI, or as a dependency of @bearly/lore
 * (the memory daemon that adds focus cache, summaries, and dedup on top).
 */

export { recallAgent } from "./lib/agent.ts"
export { planQuery, planVariants } from "./lib/plan.ts"
export { fanoutSearch, mergeFanouts } from "./lib/fanout.ts"
export { buildQueryContext, renderContextPrompt } from "./lib/context.ts"
export { getCurrentSessionContext, extractSessionFocus } from "./lib/session-context.ts"
export { writeTrace } from "./lib/trace.ts"

export { recall, boostedRank, expandQueryVariants, setRecallLogging, parseTimeToMs } from "./history/search.ts"
export {
  synthesizeResults,
  raceLlmModels,
  remember,
  SYNTHESIS_PROMPT,
  formatResultsForLlm,
} from "./history/synthesize.ts"
export { hookRecall, extractTranscriptMessages, reviewMemorySystem } from "./history/scanner.ts"
export { ensureProjectSourcesIndexed } from "./history/project-sources.ts"

export type { RecallOptions, RecallResult, RecallSearchResult } from "./history/recall-shared.ts"
export type {
  LlmRaceModelResult,
  LlmRaceResult,
  SynthesisResult,
  RememberOptions,
  RememberResult,
} from "./history/synthesize.ts"
export type { HookResult, ReviewResult } from "./history/scanner.ts"
export type { QueryContext } from "./lib/context.ts"
export type { PlanCall, QueryPlan } from "./lib/plan.ts"
export type { FanoutResult } from "./lib/fanout.ts"
export type { RoundTrace, TracePayload } from "./lib/trace.ts"
