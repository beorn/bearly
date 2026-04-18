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
 * - v2 (@bearly/tribe 0.9.0): MCP-surface rename to tribe.* namespace.
 *   Daemon-internal method strings still used the legacy lore.* / tribe_*
 *   forms on the wire.
 * - v3 (@bearly/tribe 0.9.0, Phase 4): daemon-internal RPC methods renamed
 *   to the unified tribe.* namespace. Daemons accept the legacy names
 *   as silent aliases for the 0.9 upgrade window; removal in 0.10.
 */
export const LORE_PROTOCOL_VERSION = 3

// ---------------------------------------------------------------------------
// Method names
//
// TRIBE_METHODS is the canonical source of truth for the wire protocol.
// LORE_METHODS is a deprecated alias kept for backwards compatibility with
// any external importers; it resolves to the same values (the new
// `tribe.*` strings), NOT the historical `lore.*` strings.
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

/**
 * @deprecated Use `TRIBE_METHODS` instead. Preserved with the SAME string
 * values as TRIBE_METHODS — both resolve to the new `tribe.*` wire names.
 * Scheduled for removal in @bearly/tribe 0.10.
 */
export const LORE_METHODS = TRIBE_METHODS

/** @deprecated Use `TribeMethod` instead. */
export type LoreMethod = TribeMethod

/**
 * Legacy daemon-internal method names (the `lore.*` / `tribe_*` wire strings
 * that v2 daemons used). These are accepted by v3 daemons as silent aliases
 * for the 0.9 upgrade window; clients should use TRIBE_METHODS on new code.
 * Removal target: 0.10.
 */
export const LEGACY_METHOD_ALIASES: Readonly<Record<string, string>> = {
  "lore.hello": TRIBE_METHODS.hello,
  "lore.ask": TRIBE_METHODS.ask,
  "lore.current_brief": TRIBE_METHODS.currentBrief,
  "lore.plan_only": TRIBE_METHODS.planOnly,
  "lore.session_register": TRIBE_METHODS.sessionRegister,
  "lore.session_heartbeat": TRIBE_METHODS.sessionHeartbeat,
  "lore.sessions_list": TRIBE_METHODS.sessionsList,
  "lore.workspace_state": TRIBE_METHODS.workspaceState,
  "lore.session_state": TRIBE_METHODS.sessionState,
  "lore.inject_delta": TRIBE_METHODS.injectDelta,
  "lore.status": TRIBE_METHODS.status,
}

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
export type InjectSkipReason = "empty" | "short" | "trivial" | "slash_command" | "no_results" | "all_seen"

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
