/**
 * Unified tribe session-activity log.
 *
 * Routed through loggily at `.debug` level on the `tribe:activity` namespace.
 * Loggily writes JSON events to both the configured file sink and any
 * upstream pipeline (OTel, console, etc.) that the daemon sets up.
 *
 * Motivation: on 2026-04-21 a phantom "chief" offer arrived in a sibling
 * session's prompt stream. Forensics required direct sqlite on tribe.db to
 * discover the offer had never travelled through tribe. The activity log is
 * the observability surface that catches that class of incident live.
 *
 * Phases:
 *   1. Tribe daemon — DMs + broadcasts + session lifecycle ✓
 *   2. Recall hook injections — writeInjectActivity() from emit.ts ✓
 *   3. Injection-gate verdicts (follow-up bead)
 *
 * Path: $TRIBE_ACTIVITY_LOG, or ~/.local/share/tribe/activity.jsonl.
 * Disable with TRIBE_ACTIVITY_LOG=off (used by tests; production leaves
 * unset so loggily writes to the default path at debug level).
 *
 * Why debug level + explicit config array: the loggily config pins level
 * to "debug" explicitly, so the activity stream fires regardless of the
 * daemon's wider LOG_LEVEL / DEBUG env. Keeps the contract simple:
 * activity is always observable, always at debug, always in one place.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { createLogger, type ConditionalLogger } from "loggily"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActivityKind = "dm" | "broadcast" | "event" | "session" | "rename" | "inject" | "gate"
export type ActivitySource = "tribe" | "recall" | "gate"

export interface ActivityEntry {
  ts: number
  source: ActivitySource
  kind: ActivityKind
  session: string
  peer?: string
  type?: string
  preview?: string
  chars?: number
  id?: string
  bead_id?: string | null
  meta?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_PATH_SUFFIX = "/.local/share/tribe/activity.jsonl"

export function activityLogPath(): string {
  const override = process.env.TRIBE_ACTIVITY_LOG
  if (override && override !== "off") return override
  const home = process.env.HOME ?? ""
  return `${home}${DEFAULT_PATH_SUFFIX}`
}

function isDisabled(): boolean {
  return process.env.TRIBE_ACTIVITY_LOG === "off"
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

let parentEnsuredFor: string | null = null
let warned = false
let cachedLogger: ConditionalLogger | null = null
let cachedLoggerPath: string | null = null

function ensureParent(path: string): void {
  if (parentEnsuredFor === path) return
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  parentEnsuredFor = path
}

function getLogger(): ConditionalLogger | null {
  if (isDisabled()) return null
  const path = activityLogPath()
  if (cachedLogger && cachedLoggerPath === path) return cachedLogger
  ensureParent(path)
  // Explicit config array. `level: debug` pins the level; `format: json`
  // makes the downstream Writable receive JSON-serialized strings. The
  // Writable writes synchronously (`appendFileSync`) so tail-f readers and
  // tests both see events immediately — no buffered flush ambiguity.
  cachedLogger = createLogger("tribe:activity", [
    { level: "debug", format: "json" },
    {
      objectMode: false,
      write: (data: unknown) => {
        try {
          const line =
            typeof data === "string" ? (data.endsWith("\n") ? data : data + "\n") : JSON.stringify(data) + "\n"
          appendFileSync(path, line, "utf8")
        } catch (err) {
          if (!warned) {
            warned = true
            console.error(
              `[tribe:activity-log] write failed (${String(err)}); path=${path} — further failures silenced`,
            )
          }
        }
      },
    },
  ])
  cachedLoggerPath = path
  return cachedLogger
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Write one entry at `debug` level on the `tribe:activity` namespace.
 * Append-only, synchronous, best-effort. Failed writes never break message
 * delivery — they warn once to stderr and subsequent failures are silenced.
 */
export function writeActivity(entry: ActivityEntry): void {
  const log = getLogger()
  if (!log) return
  // Passing the entry as `data` means loggily inlines its fields at top
  // level in the JSON output, alongside `time`, `level`, `name`, `msg`.
  log.debug?.("activity", entry as unknown as Record<string, unknown>)
}

/**
 * Derive an ActivityEntry from the onMessageInserted callback payload.
 *
 * Maps the internal `direct|broadcast|event` message kinds to activity kinds:
 *   - `direct`    → `dm`
 *   - `broadcast` with type='session' → `session` (joined/left broadcasts)
 *   - `broadcast` with type='notify' and content starting 'Member "' → `rename`
 *   - other `broadcast` → `broadcast`
 *   - `event` → `event` (journal-only rows, rarely reached since logEvent
 *     bypasses onMessageInserted)
 */
export function activityFromMessage(msg: {
  id: string
  ts: number
  type: string
  kind: "direct" | "broadcast" | "event"
  sender: string
  recipient: string
  content: string
  bead_id: string | null
}): ActivityEntry {
  let kind: ActivityKind
  if (msg.kind === "event") {
    kind = "event"
  } else if (msg.kind === "direct") {
    kind = "dm"
  } else if (msg.type === "session") {
    kind = "session"
  } else if (msg.type === "notify" && msg.content.startsWith('Member "')) {
    kind = "rename"
  } else {
    kind = "broadcast"
  }

  const clean = msg.content.replace(/\s+/g, " ").trim()
  const preview = clean.length <= 200 ? clean : clean.slice(0, 199) + "…"

  return {
    ts: msg.ts,
    source: "tribe",
    kind,
    session: msg.sender,
    peer: msg.recipient === "*" ? undefined : msg.recipient,
    type: msg.type,
    preview,
    id: msg.id,
    bead_id: msg.bead_id,
  }
}

/**
 * Record a recall hook injection. Called from injection-envelope.emitHookJson
 * whenever a UserPromptSubmit additionalContext is about to land in the
 * Claude Code session.
 *
 * Unlike tribe messages (which carry short broadcasts/DMs and benefit from
 * 200-char preview caps), injections are the whole payload of interest. We
 * log the **full** content verbatim so `tail -f | jq '.preview'` shows what
 * actually reached the prompt. Whitespace is still collapsed for single-line
 * jq output; `chars` reports the post-collapse length.
 *
 * Session attribution: $CLAUDE_SESSION_ID when Claude Code sets it, else
 * `pid-<pid>` as a last resort.
 */
export function writeInjectActivity(content: string, extra?: { meta?: Record<string, unknown> }): void {
  const session = process.env.CLAUDE_SESSION_ID ?? `pid-${process.pid}`
  const collapsed = content.replace(/\s+/g, " ").trim()
  writeActivity({
    ts: Date.now(),
    source: "recall",
    kind: "inject",
    session,
    preview: collapsed,
    chars: collapsed.length,
    meta: extra?.meta,
  })
}

/** Reset cached state. Tests only. */
export function __resetActivityLogState(): void {
  parentEnsuredFor = null
  warned = false
  cachedLogger = null
  cachedLoggerPath = null
}
