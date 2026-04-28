/**
 * Provider dispatch — thin re-export router.
 *
 * This file used to be a 3061-LOC monolith mixing TTY raw-mode, HTTP fetch,
 * JSONL persistence, and signal handling. Phase 4 of the @bearly/llm refactor
 * shattered it into per-feature modules under `cmd/` and helper modules under
 * `lib/` and `ui/`. This stub preserves the public import path
 * (`./lib/dispatch`) for cli.ts and any external caller; new code should
 * import directly from the per-feature modules.
 *
 * Module map:
 *   cmd/ask.ts            askAndFinish
 *   cmd/pro.ts            runProDual
 *   cmd/deep.ts           runDeep
 *   cmd/debate.ts         runDebate
 *   cmd/recover.ts        runRecover, runAwait, classifyRecovery, pollResponseToCompletion, RecoveryOutcome
 *   cmd/leaderboard.ts    runLeaderboard, runPromoteReview, runBacktest
 *   cmd/judge-history.ts  runJudgeHistory
 *   cmd/quota.ts          runQuota
 *   cmd/discover.ts       runDiscoverModels
 *   cmd/diagnostics.ts    runDiagnostics, buildDiagnostics, Diagnostics* types
 *   cmd/pricing.ts        performPricingUpdate, maybeAutoUpdatePricing, discoverNewModels, PricingUpdateResult
 *   ui/confirm.ts         confirmOrExit, promptChoice (sole owner of TTY raw-mode)
 *   lib/signals.ts        withSignalAbort (sole owner of process signal handlers)
 *   lib/context-files.ts  buildContext (FTS history + file/text)
 */

export { askAndFinish } from "../cmd/ask"
export { runProDual } from "../cmd/pro"
export { runDeep } from "../cmd/deep"
export { runDebate } from "../cmd/debate"
export {
  runRecover,
  runAwait,
  classifyRecovery,
  pollResponseToCompletion,
  checkAndRecoverPartials,
  type RecoveryOutcome,
} from "../cmd/recover"
export { runLeaderboard, runPromoteReview, runBacktest } from "../cmd/leaderboard"
export { runJudgeHistory } from "../cmd/judge-history"
export { runQuota } from "../cmd/quota"
export { runDiscoverModels } from "../cmd/discover"
export {
  runDiagnostics,
  buildDiagnostics,
  type DiagnosticsSpeedRow,
  type DiagnosticsFailureRow,
  type DiagnosticsCostRow,
  type DiagnosticsReport,
} from "../cmd/diagnostics"
export {
  performPricingUpdate,
  maybeAutoUpdatePricing,
  discoverNewModels,
  type PricingUpdateResult,
} from "../cmd/pricing"
export { confirmOrExit } from "../ui/confirm"
export { buildContext } from "./context-files"
