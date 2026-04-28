/**
 * Lore RPC surface — shared types for daemon handlers and proxy client.
 *
 * Wire protocol: JSON-RPC 2.0 newline-delimited (see tools/lib/tribe/socket.ts).
 * One RPC method = one daemon capability. Each method's Params/Result types
 * are the canonical contract used by both sides.
 */

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

/**
 * Protocol version.
 *
 * - v4 (@bearly/tribe 0.10.0): legacy lore.* / tribe_* wire-name aliases
 *   removed. Daemons only speak the canonical tribe.* namespace. Clients
 *   running pre-0.10 that send legacy names now receive "method not found".
 *
 * Constant name retained as LORE_PROTOCOL_VERSION for import stability —
 * renaming would ripple across daemon, proxy, CLI, and tests for no
 * behavioural gain.
 */
export const LORE_PROTOCOL_VERSION = 4

// ---------------------------------------------------------------------------
// Method names — canonical tribe.* wire protocol, single source of truth.
// ---------------------------------------------------------------------------

export const TRIBE_METHODS = {
  hello: "tribe.hello",
  ask: "tribe.ask",
  currentBrief: "tribe.brief",
  planOnly: "tribe.plan",
  sessionRegister: "tribe.session_register",
  sessionHeartbeat: "tribe.session_heartbeat",
  sessionsList: "tribe.sessions_list",
  workspaceState: "tribe.workspace",
  sessionState: "tribe.session",
  injectDelta: "tribe.inject_delta",
  status: "tribe.status",
} as const

export type TribeMethod = (typeof TRIBE_METHODS)[keyof typeof TRIBE_METHODS]

// ---------------------------------------------------------------------------
// lore.hello — handshake + capability exchange
// ---------------------------------------------------------------------------

export type HelloParams = {
  clientName: string
  clientVersion: string
  protocolVersion: number
}

export type HelloResult = {
  protocolVersion: number
  daemonVersion: string
  daemonPid: number
  startedAt: number
}

// ---------------------------------------------------------------------------
// lore.ask — full recall agent (round 1 + optional round 2 + synthesis)
// ---------------------------------------------------------------------------

export type AskParams = {
  query: string
  limit?: number
  since?: string
  projectFilter?: string
  round2?: "auto" | "wider" | "deeper" | "off"
  maxRounds?: 1 | 2
  speculativeSynth?: boolean
  rawTrace?: boolean
}

export type AskResult = {
  query: string
  answer: string | null
  results: Array<{
    type: string
    sessionId: string
    sessionTitle: string | null
    timestamp?: number | string
    snippet?: string
  }>
  durationMs: number
  cost: number
  synthPath: "speculative-round1" | "fresh-merged" | "single-pass" | "none" | "no-synth"
  synthCallsUsed: number
  fellThrough: boolean
  trace?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// lore.current_brief — session context for the caller
// ---------------------------------------------------------------------------

export type CurrentBriefParams = {
  sessionIdOverride?: string
}

export type CurrentBriefResult = {
  sessionId: string | null
  detected: boolean
  ageMs?: number | null
  exchangeCount?: number
  mentionedPaths?: string[]
  mentionedBeads?: string[]
  mentionedTokens?: string[]
  /** Flattened recent messages (not an array — matches session-context.ts). */
  recentMessages?: string
}

// ---------------------------------------------------------------------------
// lore.plan_only — round-1 planner only (fast speculative context)
// ---------------------------------------------------------------------------

export type PlanOnlyParams = {
  query: string
}

export type PlanOnlyResult = {
  ok: boolean
  plan?: Record<string, unknown>
  variants?: string[]
  model?: string
  elapsedMs: number
  cost: number
  error?: string
}

// ---------------------------------------------------------------------------
// lore.session_register — SessionStart hook writes canonical session record
// ---------------------------------------------------------------------------

export type SessionRegisterParams = {
  claudePid: number
  sessionId: string
  transcriptPath?: string
  cwd?: string
  project?: string
}

export type SessionRegisterResult = {
  ok: true
  registeredAt: number
}

// ---------------------------------------------------------------------------
// lore.session_heartbeat — periodic liveness update (from UserPromptSubmit)
// ---------------------------------------------------------------------------

export type SessionHeartbeatParams = {
  claudePid: number
  sessionId?: string
}

export type SessionHeartbeatResult = {
  ok: true
  lastSeen: number
}

// ---------------------------------------------------------------------------
// lore.sessions_list — current alive sessions (for lore status)
// ---------------------------------------------------------------------------

export type SessionsListParams = Record<string, never>

export type SessionInfo = {
  claudePid: number
  sessionId: string
  transcriptPath: string | null
  cwd: string | null
  project: string | null
  startedAt: number
  lastSeen: number
  status: "alive" | "stale"
}

export type SessionsListResult = {
  sessions: SessionInfo[]
}

// ---------------------------------------------------------------------------
// lore.workspace_state — cross-session snapshot
// ---------------------------------------------------------------------------

export type WorkspaceStateParams = Record<string, never>

export type SessionFocusSummary = {
  claudePid: number
  sessionId: string
  project: string | null
  status: "alive" | "stale"
  lastSeen: number
  lastActivityTs: number | null
  ageMs: number | null
  exchangeCount: number
  mentionedPaths: string[]
  mentionedBeads: string[]
  mentionedTokens: string[]
  /** First ~60 chars of tail; full tail via lore.current_brief. */
  focusHint: string
  /** LLM-summarized one-liner. Null when summarizer is off/missing. */
  focusSummary: string | null
  looseEnds: string[]
  summaryModel: string | null
  summaryUpdatedAt: number | null
  /** When the daemon last refreshed this focus. */
  updatedAt: number | null
}

export type WorkspaceStateResult = {
  generatedAt: number
  sessions: SessionFocusSummary[]
}

// ---------------------------------------------------------------------------
// lore.session_state — single-session focus+summary lookup
// ---------------------------------------------------------------------------

export type SessionStateParams = {
  sessionId: string
}

export type SessionStateResult = SessionFocusSummary & {
  /** Full flattened tail (not just the hint). */
  tail: string
}

// ---------------------------------------------------------------------------
// lore.inject_delta — hook-side injection with daemon-held dedup
// ---------------------------------------------------------------------------

export type InjectDeltaParams = {
  prompt: string
  /**
   * Optional session-id hint. Daemon uses it to key the per-session
   * already-shown set. If omitted, daemon falls back to conn.sessionId
   * (set during lore.hello if the caller registered).
   */
  sessionId?: string
  /**
   * Max snippets to inject (default 3).
   */
  limit?: number
  /**
   * Number of turns a `sessionId:type` key remains in the seen set
   * before becoming eligible again. Default 10.
   */
  ttlTurns?: number
}

/** Reasons the daemon / library path might skip injection. */
export type InjectSkipReason =
  | "empty"
  | "short"
  | "trivial"
  | "slash_command"
  | "no_results"
  | "all_seen"
  | "low_salience"
  | "low_quality"

export type InjectDeltaResult = {
  skipped: boolean
  reason?: InjectSkipReason
  /** Same format as hookRecall: ready to pass through hookSpecificOutput.additionalContext */
  additionalContext?: string
  /** Keys newly added to the seen set this call. Daemon-only; omitted on library fallback. */
  newKeys?: string[]
  /** Current size of the per-session seen set. Daemon-only; omitted on library fallback. */
  seenCount?: number
  /** Current turn counter for the session. Daemon-only; omitted on library fallback. */
  turnNumber?: number
}

// ---------------------------------------------------------------------------
// lore.status — daemon health / self-report
// ---------------------------------------------------------------------------

export type StatusParams = Record<string, never>

export type StatusResult = {
  daemonPid: number
  daemonVersion: string
  startedAt: number
  dbPath: string
  socketPath: string
  sessionCount: number
  idleDeadline: number | null
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const LORE_ERRORS = {
  internal: -32000,
  unknownMethod: -32601,
  invalidParams: -32602,
  notImplemented: -32003,
  fallthrough: -32010,
} as const
