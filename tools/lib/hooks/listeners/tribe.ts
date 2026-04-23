/**
 * tribe listener — forwards bearly hook router events to the legacy
 * tribe hook-dispatch pipeline.
 *
 * This is the bridge that lets the four Claude Code lifecycle hooks
 * (SessionStart / UserPromptSubmit / SessionEnd / PreCompact) ride the
 * pluggable router instead of hard-coded `tribe hook <event>` subcommands
 * in `~/.claude/settings.json`. Semantics are preserved byte-for-byte —
 * we just call `dispatchHook(legacyEvent)` with the matching legacy event.
 *
 * Event mapping (bearly router event → legacy dispatchHook event):
 *
 *   session_start                                       → session-start
 *   user_prompt_submit                                  → prompt
 *   session_end                                         → session-end
 *   notification (notificationType === "pre-compact")   → pre-compact
 *
 * All other events are ignored — tribe only cares about the four lifecycle
 * hooks.
 *
 * Opt-in activation: copy or symlink this file to `~/.claude/hooks.d/tribe.ts`
 * after migrating `settings.json` entries from named subcommands to
 * `tribe hook ingest --event <event> --source claude`. See the migration
 * preview at `hub/km/integrations/settings-migration-preview.json` for the
 * full activation flow.
 *
 * Failure isolation: dispatchHook is wrapped in try/catch. A tribe failure
 * must never propagate to the router (which would log it as an error) — the
 * autostart + recall handlers already have their own internal swallow for
 * the same reason; this is belt + suspenders for the listener boundary.
 *
 * Source filter: `["claude"]` — tribe's named subcommands today only fire
 * on Claude's lifecycle. Other agents can be added explicitly when needed.
 */

import { dispatchHook as realDispatchHook, type HookEvent as LegacyHookEvent } from "../../tribe/hook-dispatch.ts"
import { defineListener, type HookSource, type Listener, type ListenerContext } from "../types.ts"

export type DispatchHookFn = (event: LegacyHookEvent) => Promise<void>

export interface CreateTribeListenerOptions {
  /**
   * dispatchHook override — use to inject a mock in tests. Defaults to the
   * real `dispatchHook` from `../../tribe/hook-dispatch.ts`.
   */
  dispatchHook?: DispatchHookFn
  /**
   * Listener name. Defaults to "tribe".
   */
  name?: string
  /**
   * Source filter. Defaults to ["claude"].
   */
  sources?: readonly HookSource[]
  /**
   * Per-listener timeout override. Defaults to 5000ms — matches the tribe
   * subcommands' historical budget. dispatchHook already enforces a 300ms
   * autostart probe internally.
   */
  timeoutMs?: number
}

/**
 * Translate a router `ListenerContext` into the legacy `dispatchHook` event,
 * or `undefined` if tribe should ignore the event.
 *
 * Exported for tests and for anyone re-implementing the mapping.
 */
export function mapToLegacyEvent(ctx: Pick<ListenerContext, "event" | "notificationType">): LegacyHookEvent | undefined {
  switch (ctx.event) {
    case "session_start":
      return "session-start"
    case "user_prompt_submit":
      return "prompt"
    case "session_end":
      return "session-end"
    case "notification":
      return ctx.notificationType === "pre-compact" ? "pre-compact" : undefined
    default:
      return undefined
  }
}

function debugEnabled(): boolean {
  return Boolean(process.env.BEARLY_HOOKS_DEBUG || process.env.KM_HOOKS_DEBUG)
}

function warn(message: string): void {
  if (debugEnabled()) process.stderr.write(`[tribe-listener] ${message}\n`)
}

export function createTribeListener(opts: CreateTribeListenerOptions = {}): Listener {
  const dispatchHook = opts.dispatchHook ?? realDispatchHook
  const name = opts.name ?? "tribe"
  const sources = opts.sources ?? (["claude"] as const)
  const timeoutMs = opts.timeoutMs ?? 5_000

  return defineListener({
    name,
    // Declare only the events we care about so the router short-circuits
    // irrelevant dispatches instead of even constructing a ListenerContext
    // for us. `notification` is wide — we narrow again inside `handle`
    // via notificationType.
    events: ["session_start", "user_prompt_submit", "session_end", "notification"],
    sources,
    timeoutMs,
    handle: async (ctx) => {
      const legacyEvent = mapToLegacyEvent(ctx)
      if (!legacyEvent) return
      try {
        await dispatchHook(legacyEvent)
      } catch (err) {
        // Swallow — tribe failures must never propagate. The legacy pipeline
        // has its own logging (autostart + recall both swallow their own
        // errors internally) so a failure here is almost certainly a bug
        // worth surfacing in BEARLY_HOOKS_DEBUG mode.
        warn(`dispatchHook(${legacyEvent}) failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  })
}

const defaultTribeListener: Listener = createTribeListener()
export default defaultTribeListener
