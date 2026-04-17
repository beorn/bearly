#!/usr/bin/env bun
/**
 * Lore Daemon — single per-user process serving lore MCP proxies.
 *
 * Phase 2 scope: session registration, heartbeat, and in-process recall RPCs
 * (lore.ask, lore.current_brief, lore.plan_only). Eliminates the ~400ms
 * subprocess-spawn cost per hook by keeping recall library warm.
 *
 * Usage:
 *   bun lore-daemon.ts                    # Auto-discover socket path
 *   bun lore-daemon.ts --socket /path     # Explicit socket path
 *   bun lore-daemon.ts --foreground       # Don't detach, log to stdout
 *   bun lore-daemon.ts --quit-timeout 0   # Quit immediately when last client disconnects
 */

import { createServer, type Socket as NetSocket, type Server } from "node:net"
import { existsSync, unlinkSync, writeFileSync, chmodSync } from "node:fs"
import { parseArgs } from "node:util"
import { createLogger } from "loggily"
import {
  createLineParser,
  makeResponse,
  makeError,
  isRequest,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from "./lib/socket.ts"
import { resolveLoreSocketPath, resolveLorePidPath, resolveLoreDbPath, ensureParentDir } from "./lib/config.ts"
import {
  openLoreDatabase,
  createLoreRepo,
  sessionRowToInfo,
  type LoreRepo,
  type SessionRow,
} from "./lib/database.ts"
import {
  LORE_METHODS,
  LORE_ERRORS,
  LORE_PROTOCOL_VERSION,
  type HelloParams,
  type HelloResult,
  type AskParams,
  type AskResult,
  type CurrentBriefParams,
  type CurrentBriefResult,
  type PlanOnlyParams,
  type PlanOnlyResult,
  type SessionRegisterParams,
  type SessionRegisterResult,
  type SessionHeartbeatParams,
  type SessionHeartbeatResult,
  type SessionsListResult,
  type StatusResult,
  type WorkspaceStateResult,
  type SessionFocusSummary,
} from "./lib/rpc.ts"
import { recallAgent } from "../../recall/src/lib/agent.ts"
import { planQuery, planVariants } from "../../recall/src/lib/plan.ts"
import { buildQueryContext } from "../../recall/src/lib/context.ts"
import { getCurrentSessionContext, extractSessionFocus } from "../../recall/src/lib/session-context.ts"
import { setRecallLogging } from "../../recall/src/history/recall-shared.ts"
import { resolveSummarizerMode, summarizeTail, type SummarizerMode } from "./lib/summarizer.ts"
import type { SessionStateParams, SessionStateResult, InjectDeltaParams, InjectDeltaResult } from "./lib/rpc.ts"
import { recall } from "../../recall/src/history/search.ts"
import { ensureProjectSourcesIndexed } from "../../recall/src/history/project-sources.ts"

const DAEMON_VERSION = "0.5.0"
const STARTED_AT = Date.now()

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    socket: { type: "string" },
    db: { type: "string" },
    "quit-timeout": { type: "string", default: "1800" },
    "focus-poll-ms": { type: "string", default: process.env.LORE_FOCUS_POLL_MS ?? "60000" },
    "summary-poll-ms": { type: "string", default: process.env.LORE_SUMMARY_POLL_MS ?? "120000" },
    "summarizer-model": { type: "string", default: process.env.LORE_SUMMARIZER_MODEL ?? "off" },
    foreground: { type: "boolean", default: false },
  },
  strict: false,
})

const SOCKET_PATH = resolveLoreSocketPath(args.socket as string | undefined)
const PID_PATH = resolveLorePidPath(SOCKET_PATH)
const DB_PATH = resolveLoreDbPath(args.db as string | undefined)
const QUIT_TIMEOUT_SEC = parseInt(String(args["quit-timeout"]), 10)
const FOCUS_POLL_MS = Math.max(100, parseInt(String(args["focus-poll-ms"]), 10) || 60000)
const SUMMARY_POLL_MS = Math.max(500, parseInt(String(args["summary-poll-ms"]), 10) || 120000)
const SUMMARIZER_MODE: SummarizerMode = resolveSummarizerMode(String(args["summarizer-model"]))
const FOREGROUND = args.foreground as boolean

ensureParentDir(SOCKET_PATH)
ensureParentDir(DB_PATH)

// ---------------------------------------------------------------------------
// Logging — daemon logs go to stderr; silence recall internals unless LORE_LOG
// ---------------------------------------------------------------------------

const log = createLogger("lore:daemon")
setRecallLogging(process.env.LORE_LOG === "1")

// ---------------------------------------------------------------------------
// Stale daemon check — avoid duplicate daemons on same socket
// ---------------------------------------------------------------------------

function existingDaemonPid(): number | null {
  if (!existsSync(PID_PATH)) return null
  try {
    const pid = parseInt(require("node:fs").readFileSync(PID_PATH, "utf-8").trim(), 10)
    if (isNaN(pid)) return null
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

const staleExisting = existingDaemonPid()
if (staleExisting !== null) {
  log.info?.(`Lore daemon already running at pid ${staleExisting} — exiting`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Open database
// ---------------------------------------------------------------------------

const db = openLoreDatabase(DB_PATH)
const repo: LoreRepo = createLoreRepo(db)

// ---------------------------------------------------------------------------
// Socket server
// ---------------------------------------------------------------------------

// Remove stale socket file before binding
if (existsSync(SOCKET_PATH)) {
  try {
    unlinkSync(SOCKET_PATH)
  } catch {
    /* ignore */
  }
}

type ClientConn = {
  connId: string
  socket: NetSocket
  claudePid: number | null
  sessionId: string | null
  connectedAt: number
}

const clients = new Map<string, ClientConn>()
let nextConnId = 1

// Idle quit tracking
let idleDeadline: number | null = null
function markActive(): void {
  idleDeadline = null
}
function markIdle(): void {
  if (QUIT_TIMEOUT_SEC < 0) return
  if (QUIT_TIMEOUT_SEC === 0) {
    log.info?.("Last client disconnected; quitting immediately")
    void shutdown(0)
    return
  }
  idleDeadline = Date.now() + QUIT_TIMEOUT_SEC * 1000
}

// ---------------------------------------------------------------------------
// RPC handlers
// ---------------------------------------------------------------------------

async function handleHello(_conn: ClientConn, params: HelloParams): Promise<HelloResult> {
  return {
    protocolVersion: LORE_PROTOCOL_VERSION,
    daemonVersion: DAEMON_VERSION,
    daemonPid: process.pid,
    startedAt: STARTED_AT,
  }
}

async function handleAsk(_conn: ClientConn, params: AskParams): Promise<AskResult> {
  const result = await recallAgent(params.query, {
    limit: params.limit,
    since: params.since,
    projectFilter: params.projectFilter,
    round2: params.round2,
    maxRounds: params.maxRounds,
    speculativeSynth: params.speculativeSynth,
  })
  return {
    query: result.query,
    answer: result.synthesis,
    results: result.results.map((r) => ({
      type: String(r.type),
      sessionId: r.sessionId,
      sessionTitle: r.sessionTitle,
      timestamp: r.timestamp,
      snippet: r.snippet,
    })),
    durationMs: result.durationMs,
    cost: result.llmCost ?? 0,
    synthPath: result.trace?.synthPath ?? "no-synth",
    synthCallsUsed: result.trace?.synthCallsUsed ?? 0,
    fellThrough: result.fellThrough ?? false,
    trace: params.rawTrace ? (result.trace as unknown as Record<string, unknown>) : undefined,
  }
}

async function handleCurrentBrief(conn: ClientConn, params: CurrentBriefParams): Promise<CurrentBriefResult> {
  const override = params.sessionIdOverride ?? conn.sessionId ?? undefined

  // Prefer cache when we know which session the caller belongs to and the
  // entry is fresh (<2 min). Saves the ~50-200ms of JSONL re-parse.
  const CACHE_FRESH_MS = 2 * 60 * 1000
  if (override) {
    const row = repo.getSessionBySessionId(override)
    if (row) {
      const focus = repo.getFocus(row.claude_pid)
      if (focus && Date.now() - focus.updated_at < CACHE_FRESH_MS) {
        return {
          sessionId: row.session_id,
          detected: true,
          ageMs: focus.age_ms,
          exchangeCount: focus.exchange_count,
          mentionedPaths: focus.mentioned_paths,
          mentionedBeads: focus.mentioned_beads,
          mentionedTokens: focus.mentioned_tokens,
          recentMessages: focus.tail,
        }
      }
    }
  }

  // Fall through to live parse (Phase 2 behavior).
  const ctx = getCurrentSessionContext(override ? { sessionIdOverride: override } : {})
  if (!ctx) return { sessionId: null, detected: false }
  return {
    sessionId: ctx.sessionId,
    detected: true,
    ageMs: ctx.ageMs,
    exchangeCount: ctx.exchangeCount,
    mentionedPaths: ctx.mentionedPaths,
    mentionedBeads: ctx.mentionedBeads,
    mentionedTokens: ctx.mentionedTokens,
    recentMessages: ctx.recentMessages,
  }
}

async function handlePlanOnly(_conn: ClientConn, params: PlanOnlyParams): Promise<PlanOnlyResult> {
  const context = buildQueryContext()
  try {
    const call = await planQuery(params.query, context, { round: 1 })
    if (!call.plan) {
      return {
        ok: false,
        elapsedMs: call.elapsedMs,
        cost: call.cost ?? 0,
        model: call.model,
        error: call.error ?? "plan-failed",
      }
    }
    return {
      ok: true,
      plan: call.plan as unknown as Record<string, unknown>,
      variants: planVariants(call.plan),
      model: call.model,
      elapsedMs: call.elapsedMs,
      cost: call.cost ?? 0,
    }
  } catch (err) {
    return {
      ok: false,
      elapsedMs: 0,
      cost: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function handleSessionRegister(conn: ClientConn, params: SessionRegisterParams): SessionRegisterResult {
  const now = Date.now()
  const row = repo.upsertSession({
    claudePid: params.claudePid,
    sessionId: params.sessionId,
    transcriptPath: params.transcriptPath,
    cwd: params.cwd,
    project: params.project,
    now,
  })
  repo.appendEvent({ ts: now, sessionId: params.sessionId, claudePid: params.claudePid, type: "session.registered" })
  conn.claudePid = params.claudePid
  conn.sessionId = params.sessionId
  log.debug?.(`session registered pid=${params.claudePid} session=${params.sessionId.slice(0, 8)}`)
  // Kick an initial focus refresh so workspace_state has data before the
  // next poll tick.
  if (row.transcript_path) {
    queueMicrotask(() => refreshFocusFor(row))
  }
  return { ok: true, registeredAt: row.started_at }
}

function handleSessionHeartbeat(conn: ClientConn, params: SessionHeartbeatParams): SessionHeartbeatResult {
  const now = Date.now()
  const row = repo.heartbeatSession(params.claudePid, now)
  if (row && !conn.claudePid) {
    conn.claudePid = params.claudePid
    conn.sessionId = row.session_id
  }
  return { ok: true, lastSeen: now }
}

function handleSessionsList(): SessionsListResult {
  const rows = repo.listSessions()
  return { sessions: rows.map(sessionRowToInfo) }
}

function buildSessionSummary(row: ReturnType<typeof repo.listSessions>[number]): SessionFocusSummary {
  const focus = repo.getFocus(row.claude_pid)
  const now = Date.now()
  return {
    claudePid: row.claude_pid,
    sessionId: row.session_id,
    project: row.project,
    status: row.status,
    lastSeen: row.last_seen,
    lastActivityTs: focus?.last_activity_ts ?? null,
    ageMs:
      focus?.last_activity_ts !== null && focus?.last_activity_ts !== undefined ? now - focus.last_activity_ts : null,
    exchangeCount: focus?.exchange_count ?? 0,
    mentionedPaths: focus?.mentioned_paths ?? [],
    mentionedBeads: focus?.mentioned_beads ?? [],
    mentionedTokens: focus?.mentioned_tokens ?? [],
    focusHint: focus ? extractFocusHint(focus.tail) : "",
    focusSummary: focus?.focus_summary ?? null,
    looseEnds: focus?.loose_ends ?? [],
    summaryModel: focus?.summary_model ?? null,
    summaryUpdatedAt: focus?.summary_updated_at ?? null,
    updatedAt: focus?.updated_at ?? null,
  }
}

function handleWorkspaceState(): WorkspaceStateResult {
  const rows = repo.listSessions()
  const sessions: SessionFocusSummary[] = rows.map(buildSessionSummary)
  return { generatedAt: Date.now(), sessions }
}

function handleSessionState(params: SessionStateParams): SessionStateResult {
  const row = repo.getSessionBySessionId(params.sessionId)
  if (!row) throw new Error(`Unknown sessionId: ${params.sessionId}`)
  const summary = buildSessionSummary(row)
  const focus = repo.getFocus(row.claude_pid)
  return { ...summary, tail: focus?.tail ?? "" }
}

function extractFocusHint(tail: string): string {
  if (!tail) return ""
  // Tail format (from recall/session-context.ts formatExchange):
  //   [USER] ...text...
  //   [ASSISTANT] ...text...
  // Prefer the LAST user message — that's the user's current intent.
  const blocks = tail.trim().split(/\n\n+/)
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block?.startsWith("[USER]")) {
      const hint = block.slice("[USER]".length).trim()
      if (hint) return hint.slice(0, 120)
    }
  }
  // Fall back to the last block regardless of role.
  const last = blocks[blocks.length - 1]
  if (!last) return ""
  return last.replace(/^\[(USER|ASSISTANT)\]\s*/, "").slice(0, 120)
}

// ---------------------------------------------------------------------------
// Per-session dedup state for lore.inject_delta (Phase 5)
// ---------------------------------------------------------------------------

type InjectState = {
  /** Turn counter for the session (1-indexed on first inject). */
  turnNumber: number
  /** Map of `sessionId:type` key → last turn number at which it was injected. */
  seen: Map<string, number>
}

const injectStates = new Map<string, InjectState>()

function injectStateFor(sessionId: string): InjectState {
  let state = injectStates.get(sessionId)
  if (!state) {
    state = { turnNumber: 0, seen: new Map() }
    injectStates.set(sessionId, state)
  }
  return state
}

const TRIVIAL_PROMPTS = new Set([
  "yes",
  "no",
  "y",
  "n",
  "ok",
  "okay",
  "sure",
  "continue",
  "go ahead",
  "lgtm",
  "looks good",
  "do it",
  "proceed",
  "thanks",
  "thank you",
  "done",
  "sounds good",
  "go for it",
])

function cleanSnippet(raw: string): string {
  let text = raw.trim()
  text = text.replace(/>>>|<<</g, "")
  text = text
    .replace(/\{"[^"]*"[^}]*\}/g, "")
    .replace(/\{[^}]{0,50}\}?/g, "")
    .trim()
  text = text
    .replace(/\[(?:Assistant|User)\]\s*/g, "")
    .replace(/^-{3,}\n?/gm, "")
    .trim()
  text = text.replace(/\n{3,}/g, "\n\n").trim()
  return text
}

async function handleInjectDelta(conn: ClientConn, params: InjectDeltaParams): Promise<InjectDeltaResult> {
  const prompt = params.prompt ?? ""
  const limitSnippets = typeof params.limit === "number" && params.limit > 0 ? params.limit : 3
  const ttlTurns = typeof params.ttlTurns === "number" && params.ttlTurns > 0 ? params.ttlTurns : 10
  const sessionId = params.sessionId ?? conn.sessionId ?? "unknown"

  const state = injectStateFor(sessionId)

  if (!prompt || prompt.trim().length === 0) {
    return { skipped: true, reason: "empty", seenCount: state.seen.size, turnNumber: state.turnNumber }
  }
  if (prompt.trim().length < 15) {
    return { skipped: true, reason: "short", seenCount: state.seen.size, turnNumber: state.turnNumber }
  }
  const lower = prompt.toLowerCase().trim()
  if (TRIVIAL_PROMPTS.has(lower)) {
    return { skipped: true, reason: "trivial", seenCount: state.seen.size, turnNumber: state.turnNumber }
  }
  if (prompt.startsWith("/")) {
    return { skipped: true, reason: "slash_command", seenCount: state.seen.size, turnNumber: state.turnNumber }
  }

  ensureProjectSourcesIndexed()

  // Advance the turn BEFORE doing work — we want stable numbering even on
  // recall failure.
  state.turnNumber += 1
  const turn = state.turnNumber

  const result = await recall(prompt, {
    limit: 5,
    raw: true,
    timeout: 2000,
    snippetTokens: 80,
    json: true,
  })

  if (result.results.length === 0) {
    return { skipped: true, reason: "no_results", seenCount: state.seen.size, turnNumber: turn }
  }

  const snippets: string[] = []
  const newKeys: string[] = []
  for (const r of result.results) {
    const key = `${r.sessionId}:${r.type}`
    const lastTurn = state.seen.get(key)
    if (lastTurn !== undefined && turn - lastTurn < ttlTurns) continue
    const text = cleanSnippet(r.snippet)
    if (text.length < 20) continue
    const label = r.sessionTitle ?? r.sessionId.slice(0, 8)
    snippets.push(`[${r.type}] ${label}: ${text.slice(0, 300)}`)
    newKeys.push(key)
    if (snippets.length >= limitSnippets) break
  }

  for (const k of newKeys) state.seen.set(k, turn)

  // Opportunistic GC: drop entries older than 4×TTL to keep the Map bounded.
  if (state.seen.size > 500) {
    const cutoff = turn - ttlTurns * 4
    for (const [k, t] of state.seen) {
      if (t < cutoff) state.seen.delete(k)
    }
  }

  if (snippets.length === 0) {
    return { skipped: true, reason: "all_seen", seenCount: state.seen.size, turnNumber: turn }
  }

  return {
    skipped: false,
    additionalContext: `## Session Memory\n\n${snippets.join("\n")}`,
    newKeys,
    seenCount: state.seen.size,
    turnNumber: turn,
  }
}

function handleStatus(): StatusResult {
  return {
    daemonPid: process.pid,
    daemonVersion: DAEMON_VERSION,
    startedAt: STARTED_AT,
    dbPath: DB_PATH,
    socketPath: SOCKET_PATH,
    sessionCount: repo.listSessions().filter((r) => r.status === "alive").length,
    idleDeadline,
  }
}

// ---------------------------------------------------------------------------
// RPC dispatcher
// ---------------------------------------------------------------------------

async function dispatch(conn: ClientConn, req: JsonRpcRequest): Promise<string> {
  markActive()
  try {
    const params = (req.params ?? {}) as Record<string, unknown>
    switch (req.method) {
      case LORE_METHODS.hello:
        return makeResponse(req.id, await handleHello(conn, params as unknown as HelloParams))
      case LORE_METHODS.ask:
        return makeResponse(req.id, await handleAsk(conn, params as unknown as AskParams))
      case LORE_METHODS.currentBrief:
        return makeResponse(req.id, await handleCurrentBrief(conn, params as unknown as CurrentBriefParams))
      case LORE_METHODS.planOnly:
        return makeResponse(req.id, await handlePlanOnly(conn, params as unknown as PlanOnlyParams))
      case LORE_METHODS.sessionRegister:
        return makeResponse(req.id, handleSessionRegister(conn, params as unknown as SessionRegisterParams))
      case LORE_METHODS.sessionHeartbeat:
        return makeResponse(req.id, handleSessionHeartbeat(conn, params as unknown as SessionHeartbeatParams))
      case LORE_METHODS.sessionsList:
        return makeResponse(req.id, handleSessionsList())
      case LORE_METHODS.workspaceState:
        return makeResponse(req.id, handleWorkspaceState())
      case LORE_METHODS.sessionState:
        return makeResponse(req.id, handleSessionState(params as unknown as SessionStateParams))
      case LORE_METHODS.injectDelta:
        return makeResponse(req.id, await handleInjectDelta(conn, params as unknown as InjectDeltaParams))
      case LORE_METHODS.status:
        return makeResponse(req.id, handleStatus())
      default:
        return makeError(req.id, LORE_ERRORS.unknownMethod, `Unknown method: ${req.method}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error?.(`RPC ${req.method} failed: ${msg}`)
    return makeError(req.id, LORE_ERRORS.internal, msg)
  }
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server: Server = createServer((socket) => {
  const connId = `c${nextConnId++}`
  const conn: ClientConn = {
    connId,
    socket,
    claudePid: null,
    sessionId: null,
    connectedAt: Date.now(),
  }
  clients.set(connId, conn)
  markActive()

  const parse = createLineParser((msg: JsonRpcMessage) => {
    if (!isRequest(msg)) return
    void dispatch(conn, msg).then((out) => {
      try {
        socket.write(out)
      } catch {
        /* socket already closed */
      }
    })
  })

  socket.on("data", parse)
  socket.on("error", () => {
    /* tolerate stale writes; close handler will clean up */
  })
  socket.on("close", () => {
    clients.delete(connId)
    if (clients.size === 0) markIdle()
  })
})

server.on("error", (err) => {
  log.error?.(`Server error: ${err.message}`)
  void shutdown(1)
})

server.listen(SOCKET_PATH, () => {
  try {
    chmodSync(SOCKET_PATH, 0o600)
  } catch {
    /* best effort */
  }
  writeFileSync(PID_PATH, String(process.pid))
  log.info?.(`Lore daemon listening at ${SOCKET_PATH} (pid ${process.pid}, db ${DB_PATH})`)
  markIdle() // Start idle countdown; cleared by first connection
})

// ---------------------------------------------------------------------------
// Background janitor — sweep dead sessions and check idle deadline
// ---------------------------------------------------------------------------

const janitor: NodeJS.Timeout = setInterval(() => {
  const now = Date.now()
  repo.sweepDeadSessions(now, 15 * 60 * 1000) // stale after 15min no heartbeat
  if (idleDeadline !== null && now >= idleDeadline) {
    log.info?.("Idle timeout reached; shutting down")
    void shutdown(0)
  }
}, 30_000) as unknown as NodeJS.Timeout
janitor.unref?.()

// ---------------------------------------------------------------------------
// Focus poller (Phase 3) — refresh session_focus for alive sessions
// ---------------------------------------------------------------------------

function refreshFocusFor(row: SessionRow): void {
  if (!row.transcript_path) return
  try {
    const focus = extractSessionFocus(row.transcript_path, { sessionId: row.session_id })
    if (!focus) return
    repo.upsertFocus({
      claudePid: row.claude_pid,
      lastActivityTs: focus.lastActivityTs,
      ageMs: focus.ageMs,
      exchangeCount: focus.exchangeCount,
      mentionedPaths: focus.mentionedPaths,
      mentionedBeads: focus.mentionedBeads,
      mentionedTokens: focus.mentionedTokens,
      tail: focus.tail,
      updatedAt: Date.now(),
    })
  } catch (err) {
    log.debug?.(`focus refresh failed for pid=${row.claude_pid}: ${err instanceof Error ? err.message : err}`)
  }
}

function refreshAllFocus(): void {
  for (const row of repo.listSessions()) {
    if (row.status !== "alive") continue
    refreshFocusFor(row)
  }
}

const focusPoller: NodeJS.Timeout = setInterval(refreshAllFocus, FOCUS_POLL_MS) as unknown as NodeJS.Timeout
focusPoller.unref?.()

// ---------------------------------------------------------------------------
// Summarizer poller (Phase 4) — opt-in via --summarizer-model
// ---------------------------------------------------------------------------

const SUMMARY_STALE_IF_IDLE_MS = 30 * 60 * 1000 // skip sessions idle >30min

async function refreshSummariesOnce(): Promise<void> {
  if (SUMMARIZER_MODE === "off") return
  for (const row of repo.listSessions()) {
    if (row.status !== "alive") continue
    const focus = repo.getFocus(row.claude_pid)
    if (!focus?.tail) continue
    const ageMs = focus.last_activity_ts ? Date.now() - focus.last_activity_ts : null
    if (ageMs !== null && ageMs > SUMMARY_STALE_IF_IDLE_MS) continue
    // Skip if we already summarized this activity ts.
    if (
      focus.summary_updated_at !== null &&
      focus.last_activity_ts !== null &&
      focus.summary_updated_at >= focus.last_activity_ts
    ) {
      continue
    }
    try {
      const summary = await summarizeTail(focus.tail, { mode: SUMMARIZER_MODE, timeoutMs: 10_000 })
      if (!summary) continue
      repo.upsertSummary({
        claudePid: row.claude_pid,
        focusSummary: summary.focus,
        looseEnds: summary.looseEnds,
        summaryModel: summary.model,
        summaryCost: summary.cost,
        summaryUpdatedAt: Date.now(),
      })
      log.debug?.(`summary refreshed pid=${row.claude_pid} model=${summary.model} cost=$${summary.cost.toFixed(5)}`)
    } catch (err) {
      log.debug?.(`summary refresh failed for pid=${row.claude_pid}: ${err instanceof Error ? err.message : err}`)
    }
  }
}

const summarizerPoller: NodeJS.Timeout | null =
  SUMMARIZER_MODE !== "off"
    ? (setInterval(() => {
        void refreshSummariesOnce()
      }, SUMMARY_POLL_MS) as unknown as NodeJS.Timeout)
    : null
summarizerPoller?.unref?.()

// ---------------------------------------------------------------------------
// Signal handlers + shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false
async function shutdown(code: number): Promise<never> {
  if (shuttingDown) process.exit(code)
  shuttingDown = true
  clearInterval(janitor)
  for (const conn of clients.values()) {
    try {
      conn.socket.end()
    } catch {
      /* ignore */
    }
  }
  clients.clear()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  try {
    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH)
  } catch {
    /* ignore */
  }
  try {
    if (existsSync(PID_PATH)) unlinkSync(PID_PATH)
  } catch {
    /* ignore */
  }
  try {
    repo.close()
  } catch {
    /* ignore */
  }
  process.exit(code)
}

process.on("SIGINT", () => void shutdown(0))
process.on("SIGTERM", () => void shutdown(0))
process.on("uncaughtException", (err) => {
  log.error?.(`Uncaught: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
})
process.on("unhandledRejection", (err) => {
  log.error?.(`Unhandled rejection: ${err instanceof Error ? err.message : String(err)}`)
})

if (FOREGROUND) {
  log.info?.("Lore daemon running in foreground")
}
