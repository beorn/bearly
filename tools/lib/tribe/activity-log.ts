/**
 * Unified tribe session-activity log.
 *
 * Append-only JSONL capturing every observable cross-session event — direct
 * messages, broadcasts, session joins/leaves/renames. Designed for `tail -f`,
 * so `jq .` works on every line without any framing.
 *
 * Motivation: on 2026-04-21 a phantom "chief" offer arrived in a sibling
 * session's prompt stream. Forensics required direct sqlite on tribe.db to
 * discover the offer had never travelled through tribe. The activity log is
 * the observability surface that catches that class of incident live.
 *
 * Phases:
 *   1. Tribe daemon — DMs + broadcasts + session lifecycle ✓
 *   2. Recall hook injections — writeInjectActivity() called from
 *      injection-envelope.emitHookJson ✓
 *   3. Injection-gate verdicts (follow-up bead)
 *
 * Path: $TRIBE_ACTIVITY_LOG, or ~/.local/share/tribe/activity.jsonl.
 * Disable with TRIBE_ACTIVITY_LOG=off (used by tests; production leaves it
 * unset so writes happen normally).
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

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
  /** Total unshortened content length (preview is clipped). */
  chars?: number
  id?: string
  bead_id?: string | null
  /** Arbitrary decision payload — e.g. injection-gate verdicts. */
  meta?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MAX_PREVIEW = 200
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

function ensureParent(path: string): void {
  if (parentEnsuredFor === path) return
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  parentEnsuredFor = path
}

function previewOf(content: string): string {
  const clean = content.replace(/\s+/g, " ").trim()
  if (clean.length <= MAX_PREVIEW) return clean
  return clean.slice(0, MAX_PREVIEW - 1) + "…"
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Write one entry to the activity log. Append-only, synchronous, best-effort.
 * A failed write never breaks message delivery — it warns once to stderr and
 * subsequent failures are silenced.
 */
export function writeActivity(entry: ActivityEntry): void {
  if (isDisabled()) return
  const path = activityLogPath()
  try {
    ensureParent(path)
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf8")
  } catch (err) {
    if (!warned) {
      warned = true
      console.error(`[tribe:activity-log] write failed (${String(err)}); path=${path} — further failures silenced`)
    }
  }
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

  return {
    ts: msg.ts,
    source: "tribe",
    kind,
    session: msg.sender,
    peer: msg.recipient === "*" ? undefined : msg.recipient,
    type: msg.type,
    preview: previewOf(msg.content),
    id: msg.id,
    bead_id: msg.bead_id,
  }
}

/**
 * Record a recall hook injection. Called from injection-envelope.emitHookJson
 * whenever a UserPromptSubmit additionalContext is about to land in the
 * Claude Code session.
 *
 * Session attribution: $CLAUDE_SESSION_ID when Claude Code sets it, else
 * `pid-<pid>` as a last resort. The key observability value is the *content*
 * — preview shows the first 200 chars of whatever is being injected.
 */
export function writeInjectActivity(content: string, extra?: { meta?: Record<string, unknown> }): void {
  const session = process.env.CLAUDE_SESSION_ID ?? `pid-${process.pid}`
  writeActivity({
    ts: Date.now(),
    source: "recall",
    kind: "inject",
    session,
    preview: previewOf(content),
    chars: content.length,
    meta: extra?.meta,
  })
}

/** Reset cached state. Tests only. */
export function __resetActivityLogState(): void {
  parentEnsuredFor = null
  warned = false
}
