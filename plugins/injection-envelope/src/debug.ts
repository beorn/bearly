/**
 * Observability hook for envelope emission.
 *
 * When `INJECTION_DEBUG_LOG` env is set, every hook decision — whether to
 * emit, skip, or emit-empty — appends a JSONL line to that file. Useful
 * when a user is seeing unexpected injected content in their scrollback
 * and can't tell which hook produced it or why.
 *
 * Format: one JSON object per line, newline-separated. Fields are
 * stable enough for `jq`-style filtering but not a public API — don't
 * program against them.
 *
 * Usage:
 *   INJECTION_DEBUG_LOG=/tmp/injection.log claude
 *   tail -f /tmp/injection.log | jq .
 *
 * Cheap when unset: one env read per call, no imports, no allocation.
 */

export interface InjectionDebugEvent {
  /** Emitter identity — which hook/path produced this. */
  source: string
  /** Claude Code session id, if available. */
  sessionId?: string
  /** What decision did the emitter make. */
  action: "emit" | "skip" | "empty"
  /** First ~200 chars of the triggering user prompt, for correlation. */
  prompt?: string
  /** Why skipped / why empty — free-form string. */
  reason?: string
  /** Number of items (snippets/pointers) in the envelope. */
  itemCount?: number
  /** Total chars of the emitted additionalContext. */
  chars?: number
  /** The full emitted additionalContext — so users can see exactly what the model gets. */
  additionalContext?: string
}

export function emitInjectionDebugEvent(event: InjectionDebugEvent): void {
  const path = process.env.INJECTION_DEBUG_LOG
  if (!path) return
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event })
  try {
    // Lazy-require so the module has zero fs overhead in the common case.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs")
    fs.appendFileSync(path, line + "\n")
  } catch {
    // Best-effort. A broken log must not break the hook.
  }
}
