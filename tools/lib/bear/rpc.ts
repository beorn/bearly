/**
 * Bear RPC surface — shared types for daemon handlers and proxy client.
 *
 * Wire protocol: JSON-RPC 2.0 newline-delimited (see tools/lib/tribe/socket.ts).
 * One RPC method = one daemon capability. Each method's Params/Result types
 * are the canonical contract used by both sides.
 */

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

export const BEAR_PROTOCOL_VERSION = 1

// ---------------------------------------------------------------------------
// Method names
// ---------------------------------------------------------------------------

export const BEAR_METHODS = {
  hello: "bear.hello",
  ask: "bear.ask",
  currentBrief: "bear.current_brief",
  planOnly: "bear.plan_only",
  sessionRegister: "bear.session_register",
  sessionHeartbeat: "bear.session_heartbeat",
  sessionsList: "bear.sessions_list",
  workspaceState: "bear.workspace_state",
  sessionState: "bear.session_state",
  status: "bear.status",
} as const

export type BearMethod = (typeof BEAR_METHODS)[keyof typeof BEAR_METHODS]

// ---------------------------------------------------------------------------
// bear.hello — handshake + capability exchange
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
// bear.ask — full recall agent (round 1 + optional round 2 + synthesis)
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
// bear.current_brief — session context for the caller
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
// bear.plan_only — round-1 planner only (fast speculative context)
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
// bear.session_register — SessionStart hook writes canonical session record
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
// bear.session_heartbeat — periodic liveness update (from UserPromptSubmit)
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
// bear.sessions_list — current alive sessions (for bear status)
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
// bear.workspace_state — cross-session snapshot (Phase 3)
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
  /** First ~60 chars of tail; full tail via bear.current_brief. */
  focusHint: string
  /** LLM-summarized one-liner (Phase 4). Null when summarizer is off/missing. */
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
// bear.session_state — single-session focus+summary lookup (Phase 4)
// ---------------------------------------------------------------------------

export type SessionStateParams = {
  sessionId: string
}

export type SessionStateResult = SessionFocusSummary & {
  /** Full flattened tail (not just the hint). */
  tail: string
}

// ---------------------------------------------------------------------------
// bear.status — daemon health / self-report
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

export const BEAR_ERRORS = {
  internal: -32000,
  unknownMethod: -32601,
  invalidParams: -32602,
  notImplemented: -32003,
  fallthrough: -32010,
} as const
