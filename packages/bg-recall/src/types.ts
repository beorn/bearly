/**
 * Shared types for the bg-recall daemon.
 *
 * Kept in one file so the per-module surface stays small. Every type in here
 * is exported from the package barrel — they're the public contract for hosts
 * who embed the daemon (CLI, tests, alternate runtimes).
 */

export type ToolCallEvent = {
  /** Claude Code session id this tool call belongs to. */
  sessionId: string
  /** Tribe member name for the session (used as the hint recipient). */
  sessionName: string
  /** Tool name as Claude Code reports it (`Read`, `Bash`, `Grep`, …). */
  tool: string
  /** Free-form representation of the tool input — paths, queries, snippets. */
  input?: string
  /** Free-form representation of the tool output — first ~2KB. */
  output?: string
  /** Wallclock ms when the event was observed. */
  ts: number
}

export type RecallHit = {
  /** Stable id for this hit — used by `retrieve_memory(<id>)`. */
  id: string
  /** Where the hit came from (`bearly`, `qmd`, etc.). */
  source: string
  title: string
  /** Human-readable snippet body. The quality gate sees this. */
  snippet: string
  /** ISO-8601 timestamp of the underlying source. */
  ts: string
  /** FTS rank as returned by the source (lower = better). */
  rank: number
  /** Optional — sessionId of the hit's origin (if it's a session). */
  sessionId?: string
}

export type RecallQueryResult = {
  source: string
  query: string
  hits: RecallHit[]
  durationMs: number
}

/** A scored candidate — survivors of relevance scoring become hint candidates. */
export type ScoredHit = RecallHit & {
  score: number
  components: {
    rank: number
    entityOverlap: number
    recency: number
    reinforcement: number
  }
}

export type Hint = {
  id: string
  ts: number
  /** Recipient session id — keyed off the same id metrics + throttle use. */
  sessionId: string
  /** Recipient tribe member name — what tribe.send routes to. */
  to: string
  source: string
  /** The text that lands in the recipient's `<channel>` block. */
  content: string
  /** Hit metadata — for `bg-recall explain`. */
  hit: ScoredHit
  /** Entities that triggered this hint. */
  triggerEntities: string[]
  /** Top-3 candidates considered (winner first). */
  candidates: Array<{ id: string; source: string; score: number; rejectReason?: string }>
}

export type RejectReason =
  | "below-threshold"
  | "quality-gate"
  | "dedup"
  | "throttle"
  | "no-entities"
  | "no-hits"
  | "below-floor"

export type Decision = {
  ts: number
  sessionId: string
  trigger: ToolCallEvent
  entities: string[]
  queries: RecallQueryResult[]
  candidates: Array<{ hit: RecallHit; score: number; rejectReason?: RejectReason }>
  emitted?: Hint
  rejected?: { reason: RejectReason; detail?: string }
}

export type AdoptionStatus = "pending" | "adopted" | "ignored"

export type SessionMetrics = {
  sessionId: string
  sessionName: string
  toolCalls: number
  hintsFired: number
  hintsAdopted: number
  hintsIgnored: number
  lastActivityMs: number
  topEntities: Array<{ entity: string; count: number }>
}

export type DaemonStatus = {
  state: "starting" | "running" | "idle" | "error" | "stopped"
  startedAt: number
  lastActivityMs: number
  sessions: SessionMetrics[]
  recentHints: Array<{
    id: string
    ts: number
    to: string
    source: string
    title: string
    adoption: AdoptionStatus
  }>
  totals: { toolCalls: number; queries: number; hintsFired: number; rejected: number }
}

/** Quality-gate facade — the daemon doesn't care which implementation is wired. */
export type QualityGate = {
  /** Returns `true` if the snippet is safe to surface as a hint. */
  isAcceptable(text: string): boolean
  /** Returns a structured reason — useful for the JSONL log. */
  analyze(text: string): { rejectReason?: string }
}

/** Recall facade — the daemon calls this once per source per query. */
export type RecallFn = (query: string, opts?: { since?: string; limit?: number }) => Promise<RecallQueryResult>

/** Tribe-send facade — the daemon never speaks the wire protocol directly. */
export type TribeSend = (to: string, content: string, type: string, meta?: Record<string, unknown>) => Promise<void>
