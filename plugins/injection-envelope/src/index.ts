/**
 * @bearly/injection-envelope — the single chokepoint for all
 * UserPromptSubmit `hookSpecificOutput.additionalContext` emission.
 *
 * Every bearly / accountly / tribe / telegram / github / beads /
 * system-reminder emitter MUST route through this package. Raw
 * `additionalContext` emission outside this library is caught by
 * `tools/lint-injection-emitters.ts` in CI.
 *
 * See README.md for the full rationale and phase-0/1/2/3/5 plan.
 */

export { wrapInjectedContext, emitHookJson, CONTEXT_PROTOCOL_FOOTER } from "./emit.ts"
export type { WrapOptions, InjectedItem, EmitMode } from "./emit.ts"

export { rewriteImperativeAsReported, sanitize } from "./sanitize.ts"

export type { RegisteredSource } from "./registry.ts"

export {
  extractEntities,
  extractShingles,
  looksLikeExplicitWriteAuth,
  readTurnManifest,
  writeTurnManifest,
  clearTurnManifest,
  turnManifestPathForSession,
  sessionsDir,
} from "./manifest.ts"
export type { TurnManifest, InjectedSpan } from "./manifest.ts"

export {
  retrieveMemory,
  registerRetrieveSource,
  qmdFetcher,
  resetRetrieveFetchers,
  retrieveFetcherCount,
} from "./retrieve.ts"
export type { RetrievedMemory, RetrieveFetcher } from "./retrieve.ts"

export { emitInjectionDebugEvent } from "./debug.ts"
export type { InjectionDebugEvent } from "./debug.ts"
