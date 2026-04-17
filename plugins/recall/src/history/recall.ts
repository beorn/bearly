/**
 * recall.ts - Orchestrator: re-exports public API from focused modules
 *
 * Search + synthesize Claude Code session history.
 * Split into:
 *   - search.ts: FTS5 search logic, query building, result scoring
 *   - synthesize.ts: LLM synthesis, model racing, lesson extraction
 *   - project-sources.ts: Project source indexing (beads, memory, docs)
 *   - scanner.ts: Session file scanning, hook handling, diagnostics
 */

// search.ts — core search function, query building, result scoring
export {
  setRecallLogging,
  parseTimeToMs,
  expandQueryVariants,
  boostedRank,
  recall,
  type RecallOptions,
  type RecallResult,
  type RecallSearchResult,
} from "./search.ts"

// synthesize.ts — LLM synthesis, model racing, lesson extraction
export {
  SYNTHESIS_PROMPT,
  raceLlmModels,
  synthesizeResults,
  formatResultsForLlm,
  remember,
  type LlmRaceModelResult,
  type LlmRaceResult,
  type SynthesisResult,
  type RememberOptions,
  type RememberResult,
} from "./synthesize.ts"

// project-sources.ts — project source indexing
export { ensureProjectSourcesIndexed } from "./project-sources.ts"

// scanner.ts — session file scanning, hook handling, diagnostics
export {
  extractTranscriptMessages,
  hookRecall,
  reviewMemorySystem,
  type HookResult,
  type ReviewResult,
} from "./scanner.ts"
