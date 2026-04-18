/**
 * Tribe hook dispatch — thin wrapper around recall's hook handlers.
 *
 * `tribe hook <event>` is the unified entry point for Claude Code hooks.
 * It replaces the scattered `recall session-start` / `recall session-end` /
 * `recall hook` commands while calling through to the same functions so that
 * behavior (sentinel files, daemon registration, incremental indexing, delta
 * injection) is preserved byte-for-byte.
 *
 * Events:
 *   session-start — SessionStart hook (reads stdin JSON: session_id, cwd, ...)
 *   prompt        — UserPromptSubmit hook (reads stdin JSON: prompt, ...)
 *   session-end   — SessionEnd hook
 *   pre-compact   — PreCompact hook (currently a no-op passthrough to cmdHook)
 *
 * These handlers control the Claude Code hook protocol (exit codes, stdout
 * JSON). We must not swallow errors or rewrite output — just dispatch.
 *
 * Before forwarding, we consult the autostart config and (if configured)
 * ensure both the lore and tribe daemons are running. Spawns are detached +
 * unref'd so they never block the hook; the overall 300 ms budget is shared
 * between both probes to guarantee Claude Code never waits on us.
 */

import { cmdSessionStart, cmdSessionEnd, cmdHook } from "../../../plugins/recall/src/lib/hooks.ts"
import { ensureAllDaemonsIfConfigured } from "./autostart.ts"

export type HookEvent = "session-start" | "prompt" | "session-end" | "pre-compact"

export async function dispatchHook(event: HookEvent): Promise<void> {
  // Fire-and-check autostart before the real handler runs. Errors are
  // swallowed internally — hooks must never crash here.
  try {
    await ensureAllDaemonsIfConfigured()
  } catch {
    /* never block the hook on autostart failure */
  }

  switch (event) {
    case "session-start":
      await cmdSessionStart()
      return
    case "session-end":
      await cmdSessionEnd()
      return
    case "prompt":
    case "pre-compact":
      // Both feed stdin JSON to the UserPromptSubmit-style handler. cmdHook
      // reads `hook_event_name` from stdin and routes accordingly.
      await cmdHook()
      return
  }
}
