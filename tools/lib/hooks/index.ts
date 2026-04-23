/**
 * Bearly hook dispatch — pluggable router + listener registry.
 *
 * Usage:
 *   const listeners = await loadListeners({ projectPath: process.cwd() })
 *   const result = await runIngest(listeners, "session_start", "claude", { ... })
 *
 * The router is additive to the existing named-subcommand dispatcher
 * (`tools/lib/tribe/hook-dispatch.ts`). New listeners drop into
 * `~/.claude/hooks.d/*.ts` without touching core bearly code.
 */

export type {
  EnrichmentFields,
  HookEvent,
  HookSource,
  Listener,
  ListenerContext,
  ListenerResult,
  RouterResult,
} from "./types.ts"
export { HOOK_EVENTS, defineListener } from "./types.ts"
export { runIngest, runNotify } from "./router.ts"
export { loadListeners, type LoadOptions } from "./loader.ts"
