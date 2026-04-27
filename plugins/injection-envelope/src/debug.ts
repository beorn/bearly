/**
 * Observability for envelope emission, routed through loggily.
 *
 * Every hook decision (emit / skip / empty) flows into the `injection:*`
 * namespace tree:
 * - `injection:wrap`  — successful framed-envelope emission (action="emit")
 * - `injection:skip`  — caller decided not to inject (action="skip" / "empty")
 *
 * Files / network sinks are wired downstream via loggily's `addWriterFor`.
 *
 * Hosts (the Claude Code hook entry point) typically install a writer
 * explicitly via {@link installInjectionFileWriter}; for one-release
 * back-compat we also support lazy install on first emit when
 * `INJECTION_DEBUG_LOG=/path` (or the unified `LOGGILY_FILE`) is set.
 * Library consumers without either env var pay nothing.
 */

import { addWriterFor, createFileWriter, createLogger } from "loggily"

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

const wrapLog = createLogger("injection:wrap")
const skipLog = createLogger("injection:skip")

const _installedPaths = new Set<string>()

/**
 * Pipe `injection:*` events to a JSONL file at `path`. Idempotent per path
 * (calling twice with the same path is a no-op). Returns the unsubscribe
 * handle from loggily so callers can detach the writer if needed.
 */
export function installInjectionFileWriter(path: string): () => void {
  if (_installedPaths.has(path)) return () => {}
  _installedPaths.add(path)
  const writer = createFileWriter(path)
  return addWriterFor("injection:*", (_formatted, _level, _ns, event) => {
    if (event.kind !== "log") return
    writer.write(
      JSON.stringify({
        ts: new Date(event.time).toISOString(),
        namespace: event.namespace,
        level: event.level,
        msg: event.message,
        ...event.props,
      }),
    )
  })
}

let _envChecked = false
function ensureFileWriterFromEnv(): void {
  if (_envChecked) return
  _envChecked = true
  const path = process.env.INJECTION_DEBUG_LOG ?? process.env.LOGGILY_FILE
  if (path) installInjectionFileWriter(path)
}

export function emitInjectionDebugEvent(event: InjectionDebugEvent): void {
  ensureFileWriterFromEnv()
  const log = event.action === "emit" ? wrapLog : skipLog
  log.info?.(event.action, { ...event })
}
