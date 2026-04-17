#!/usr/bin/env bun
/**
 * Bear Daemon — single per-user process serving bear MCP proxies.
 *
 * Phase 2 scope: session registration, heartbeat, and in-process recall RPCs
 * (bear.ask, bear.current_brief, bear.plan_only). Eliminates the ~400ms
 * subprocess-spawn cost per hook by keeping recall library warm.
 *
 * Usage:
 *   bun bear-daemon.ts                    # Auto-discover socket path
 *   bun bear-daemon.ts --socket /path     # Explicit socket path
 *   bun bear-daemon.ts --foreground       # Don't detach, log to stdout
 *   bun bear-daemon.ts --quit-timeout 0   # Quit immediately when last client disconnects
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
} from "./lib/bear/socket.ts"
import { resolveBearSocketPath, resolveBearPidPath, resolveBearDbPath, ensureParentDir } from "./lib/bear/config.ts"
import { openBearDatabase, createBearRepo, sessionRowToInfo, type BearRepo } from "./lib/bear/database.ts"
import {
  BEAR_METHODS,
  BEAR_ERRORS,
  BEAR_PROTOCOL_VERSION,
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
} from "./lib/bear/rpc.ts"
import { recallAgent } from "./recall/agent.ts"
import { planQuery, planVariants } from "./recall/plan.ts"
import { buildQueryContext } from "./recall/context.ts"
import { getCurrentSessionContext } from "./recall/session-context.ts"
import { setRecallLogging } from "./lib/history/recall-shared.ts"

const DAEMON_VERSION = "0.2.0"
const STARTED_AT = Date.now()

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    socket: { type: "string" },
    db: { type: "string" },
    "quit-timeout": { type: "string", default: "1800" },
    foreground: { type: "boolean", default: false },
  },
  strict: false,
})

const SOCKET_PATH = resolveBearSocketPath(args.socket as string | undefined)
const PID_PATH = resolveBearPidPath(SOCKET_PATH)
const DB_PATH = resolveBearDbPath(args.db as string | undefined)
const QUIT_TIMEOUT_SEC = parseInt(String(args["quit-timeout"]), 10)
const FOREGROUND = args.foreground as boolean

ensureParentDir(SOCKET_PATH)
ensureParentDir(DB_PATH)

// ---------------------------------------------------------------------------
// Logging — daemon logs go to stderr; silence recall internals unless BEAR_LOG
// ---------------------------------------------------------------------------

const log = createLogger("bear:daemon")
setRecallLogging(process.env.BEAR_LOG === "1")

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
  log.info?.(`Bear daemon already running at pid ${staleExisting} — exiting`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Open database
// ---------------------------------------------------------------------------

const db = openBearDatabase(DB_PATH)
const repo: BearRepo = createBearRepo(db)

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
    protocolVersion: BEAR_PROTOCOL_VERSION,
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
      case BEAR_METHODS.hello:
        return makeResponse(req.id, await handleHello(conn, params as unknown as HelloParams))
      case BEAR_METHODS.ask:
        return makeResponse(req.id, await handleAsk(conn, params as unknown as AskParams))
      case BEAR_METHODS.currentBrief:
        return makeResponse(req.id, await handleCurrentBrief(conn, params as unknown as CurrentBriefParams))
      case BEAR_METHODS.planOnly:
        return makeResponse(req.id, await handlePlanOnly(conn, params as unknown as PlanOnlyParams))
      case BEAR_METHODS.sessionRegister:
        return makeResponse(req.id, handleSessionRegister(conn, params as unknown as SessionRegisterParams))
      case BEAR_METHODS.sessionHeartbeat:
        return makeResponse(req.id, handleSessionHeartbeat(conn, params as unknown as SessionHeartbeatParams))
      case BEAR_METHODS.sessionsList:
        return makeResponse(req.id, handleSessionsList())
      case BEAR_METHODS.status:
        return makeResponse(req.id, handleStatus())
      default:
        return makeError(req.id, BEAR_ERRORS.unknownMethod, `Unknown method: ${req.method}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error?.(`RPC ${req.method} failed: ${msg}`)
    return makeError(req.id, BEAR_ERRORS.internal, msg)
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
  log.info?.(`Bear daemon listening at ${SOCKET_PATH} (pid ${process.pid}, db ${DB_PATH})`)
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
  log.error?.(`Uncaught: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
})
process.on("unhandledRejection", (err) => {
  log.error?.(`Unhandled rejection: ${err instanceof Error ? err.message : String(err)}`)
})

if (FOREGROUND) {
  log.info?.("Bear daemon running in foreground")
}
