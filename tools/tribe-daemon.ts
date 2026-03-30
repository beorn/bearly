#!/usr/bin/env bun
/**
 * Tribe Daemon — single process per project, sessions connect via Unix socket.
 *
 * Usage:
 *   bun tribe-daemon.ts                    # Auto-discover socket path
 *   bun tribe-daemon.ts --socket /path     # Explicit socket path
 *   bun tribe-daemon.ts --quit-timeout 0   # Quit immediately when last client disconnects
 *   bun tribe-daemon.ts --fd 3             # Inherit socket fd (for hot-reload re-exec)
 */

import { createServer, type Socket as NetSocket, type Server } from "node:net"
import { existsSync, unlinkSync, writeFileSync, chmodSync, statSync } from "node:fs"
import { parseArgs } from "node:util"
import { randomUUID } from "node:crypto"
import {
  resolveSocketPath,
  resolvePidPath,
  createLineParser,
  makeResponse,
  makeError,
  makeNotification,
  isRequest,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from "./lib/tribe/socket.ts"
import {
  parseTribeArgs,
  parseSessionDomains,
  findBeadsDir,
  resolveDbPath,
} from "./lib/tribe/config.ts"
import { openDatabase, createStatements } from "./lib/tribe/database.ts"
import { createTribeContext, type TribeContext } from "./lib/tribe/context.ts"
import { handleToolCall } from "./lib/tribe/handlers.ts"
import { logEvent, sendMessage } from "./lib/tribe/messaging.ts"
import { cleanupOldPrunedSessions, cleanupOldData, registerSession, sendHeartbeat } from "./lib/tribe/session.ts"
import { acquireLease } from "./lib/tribe/lease.ts"
import { beadsPlugin, gitPlugin, loadPlugins, type PluginContext } from "./lib/tribe/plugins.ts"

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const { values: daemonArgs } = parseArgs({
  options: {
    socket: { type: "string" },
    fd: { type: "string" },
    "quit-timeout": { type: "string", default: "30" },
    foreground: { type: "boolean", default: false },
  },
  strict: false,
})

const SOCKET_PATH = resolveSocketPath(daemonArgs.socket as string | undefined)
const PID_PATH = resolvePidPath(SOCKET_PATH)
const QUIT_TIMEOUT = parseInt(String(daemonArgs["quit-timeout"]), 10)
const INHERIT_FD = daemonArgs.fd ? parseInt(String(daemonArgs.fd), 10) : null

// ---------------------------------------------------------------------------
// Database bootstrap (same as tribe.ts)
// ---------------------------------------------------------------------------

const tribeArgs = parseTribeArgs()
const BEADS_DIR = findBeadsDir()
const DB_PATH = resolveDbPath(tribeArgs, BEADS_DIR)
const db = openDatabase(String(DB_PATH))
const stmts = createStatements(db)

// Daemon always acts as "daemon" role — it doesn't participate as chief/member
const DAEMON_SESSION_ID = randomUUID()
const daemonCtx = createTribeContext({
  db,
  stmts,
  sessionId: DAEMON_SESSION_ID,
  sessionRole: "chief", // Daemon is the authority
  initialName: "daemon",
  domains: [],
  claudeSessionId: null,
  claudeSessionName: null,
})

log(`Starting tribe daemon`)
log(`Socket: ${SOCKET_PATH}`)
log(`DB: ${DB_PATH}`)
log(`PID: ${process.pid}`)

// ---------------------------------------------------------------------------
// Client registry
// ---------------------------------------------------------------------------

type ClientSession = {
  socket: NetSocket
  id: string
  name: string
  role: string
  domains: string[]
  project: string
  pid: number
  claudeSessionId: string | null
  ctx: TribeContext // Per-client context for handler calls
  registeredAt: number
}

const clients = new Map<string, ClientSession>() // connId → session
const socketToClient = new Map<NetSocket, string>() // socket → connId

function broadcastNotification(method: string, params?: Record<string, unknown>, exclude?: string): void {
  const msg = makeNotification(method, params)
  for (const [connId, client] of clients) {
    if (connId === exclude) continue
    try {
      client.socket.write(msg)
    } catch {
      // Client dead — will be cleaned up on disconnect
    }
  }
}

function pushToClient(connId: string, method: string, params?: Record<string, unknown>): void {
  const client = clients.get(connId)
  if (!client) return
  try {
    client.socket.write(makeNotification(method, params))
  } catch {
    // Dead client
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC handler
// ---------------------------------------------------------------------------

async function handleRequest(req: JsonRpcRequest, connId: string): Promise<string> {
  const { method, params, id } = req
  const p = (params ?? {}) as Record<string, unknown>

  try {
    switch (method) {
      case "register": {
        const name = String(p.name ?? `client-${connId.slice(0, 6)}`)
        const role = String(p.role ?? "member")
        const domains = (p.domains as string[]) ?? []
        const project = String(p.project ?? process.cwd())
        const pid = Number(p.pid ?? 0)
        const claudeSessionId = (p.claudeSessionId as string) ?? null

        // Create a per-client context so handlers work per-session
        const clientCtx = createTribeContext({
          db,
          stmts,
          sessionId: randomUUID(),
          sessionRole: role as "chief" | "member",
          initialName: name,
          domains,
          claudeSessionId,
          claudeSessionName: (p.claudeSessionName as string) ?? null,
        })

        // Register in DB
        registerSession(clientCtx)
        if (role === "chief") {
          acquireLease(db, clientCtx.sessionId, name)
        }

        const client: ClientSession = {
          socket: clients.get(connId)?.socket ?? null!,
          id: connId,
          name,
          role,
          domains,
          project,
          pid,
          claudeSessionId,
          ctx: clientCtx,
          registeredAt: Date.now(),
        }

        // Preserve the socket reference from the pre-register state
        const existing = clients.get(connId)
        if (existing) client.socket = existing.socket

        clients.set(connId, client)

        // Cancel auto-quit timer
        cancelQuitTimer()

        // Notify others
        broadcastNotification("session.joined", { name, role, domains }, connId)
        logEvent(daemonCtx, "session.joined", undefined, { name, role, via: "daemon" })

        // Find chief name for response
        let chiefName = "none"
        for (const [, c] of clients) {
          if (c.role === "chief" && c.id !== connId) { chiefName = c.name; break }
        }

        return makeResponse(id, {
          sessionId: clientCtx.sessionId,
          name,
          role,
          chief: chiefName,
          daemon: { pid: process.pid, uptime: Math.floor((Date.now() - startedAt) / 1000) },
        })
      }

      // Tribe tool calls — delegate to existing handlers
      case "tribe_send":
      case "tribe_broadcast":
      case "tribe_sessions":
      case "tribe_history":
      case "tribe_rename":
      case "tribe_join":
      case "tribe_health":
      case "tribe_reload":
      case "tribe_retro":
      case "tribe_leadership": {
        const client = clients.get(connId)
        const ctx = client?.ctx ?? daemonCtx

        const result = await handleToolCall(ctx, method, p, {
          cleanup: () => {},
          userRenamed: false,
          setUserRenamed: () => {},
        })

        // After handling, push any new messages to recipients
        // (The handler writes to DB; we need to check for new messages and push)
        pushNewMessages()

        return makeResponse(id, result)
      }

      // CLI-specific methods
      case "cli_status": {
        const sessions = Array.from(clients.values()).map((c) => ({
          name: c.name,
          role: c.role,
          domains: c.domains,
          pid: c.pid,
          claudeSessionId: c.claudeSessionId,
          connectedAt: c.registeredAt,
          uptimeMs: Date.now() - c.registeredAt,
        }))

        // Also include DB-backed sessions not connected to this daemon
        const t = Date.now() - 30_000
        const dbSessions = db.prepare(
          "SELECT name, role, domains, pid, started_at, heartbeat FROM sessions WHERE heartbeat > ? AND pruned_at IS NULL ORDER BY role DESC, started_at ASC"
        ).all(t) as Array<{ name: string; role: string; domains: string; pid: number; started_at: number; heartbeat: number }>

        // Merge: daemon-connected sessions take priority, add DB-only sessions
        const connectedNames = new Set(sessions.map(s => s.name))
        const dbOnly = dbSessions
          .filter(s => !connectedNames.has(s.name) && s.name !== "daemon")
          .map(s => ({
            name: s.name,
            role: s.role,
            domains: JSON.parse(s.domains || "[]") as string[],
            pid: s.pid,
            claudeSessionId: null,
            connectedAt: s.started_at,
            uptimeMs: Date.now() - s.started_at,
            source: "db" as const,
          }))

        const allSessions = [
          ...sessions.map(s => ({ ...s, source: "daemon" as const })),
          ...dbOnly,
        ]

        return makeResponse(id, {
          sessions: allSessions,
          daemon: {
            pid: process.pid,
            uptime: Math.floor((Date.now() - startedAt) / 1000),
            clients: clients.size,
            dbPath: DB_PATH,
            socketPath: SOCKET_PATH,
          },
        })
      }

      case "cli_health": {
        const health = await handleToolCall(daemonCtx, "tribe_health", {}, {
          cleanup: () => {},
          userRenamed: false,
          setUserRenamed: () => {},
        })
        return makeResponse(id, {
          ...health,
          daemon: {
            pid: process.pid,
            uptime: Math.floor((Date.now() - startedAt) / 1000),
            clients: clients.size,
          },
        })
      }

      case "cli_log": {
        const limit = Number(p.limit ?? 20)
        const rows = db.prepare("SELECT * FROM messages ORDER BY ts DESC LIMIT ?").all(limit)
        return makeResponse(id, { messages: (rows as unknown[]).reverse() })
      }

      case "cli_daemon": {
        return makeResponse(id, {
          pid: process.pid,
          uptime: Math.floor((Date.now() - startedAt) / 1000),
          clients: clients.size,
          dbPath: DB_PATH,
          socketPath: SOCKET_PATH,
          startedAt,
          quitTimeout: QUIT_TIMEOUT,
        })
      }

      // Stream mode for watch
      case "subscribe": {
        // Client wants to receive all notifications in real-time
        // They're already receiving them via the socket, so just ack
        return makeResponse(id, { subscribed: true })
      }

      default:
        return makeError(id, -32601, `Method not found: ${method}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`Error handling ${method}: ${msg}`)
    return makeError(id, -32603, msg)
  }
}

// ---------------------------------------------------------------------------
// Message push — check DB for new messages and push to clients
// ---------------------------------------------------------------------------

const lastDelivered = new Map<string, number>() // connId → last message ts

function pushNewMessages(): void {
  for (const [connId, client] of clients) {
    const since = lastDelivered.get(connId) ?? client.registeredAt
    try {
      const messages = db
        .prepare(
          "SELECT id, type, sender, recipient, content, bead_id, ts FROM messages WHERE ts > ? AND (recipient = ? OR recipient = '*') AND sender != ? ORDER BY ts ASC LIMIT 50",
        )
        .all(since, client.name, client.name) as Array<{
        id: string
        type: string
        sender: string
        recipient: string
        content: string
        bead_id: string | null
        ts: number
      }>

      for (const msg of messages) {
        pushToClient(connId, "channel", {
          from: msg.sender,
          type: msg.type,
          content: msg.content,
          bead_id: msg.bead_id,
          message_id: msg.id,
        })
        lastDelivered.set(connId, msg.ts)
      }
    } catch {
      // DB error — skip this cycle
    }
  }
}

// ---------------------------------------------------------------------------
// Plugins (git poller, beads watcher)
// ---------------------------------------------------------------------------

const pluginCtx: PluginContext = {
  sendMessage(to, content, type, beadId) {
    sendMessage(daemonCtx, to, content, type, beadId)
    // Push to connected clients
    pushNewMessages()
  },
  hasChief() {
    for (const [, c] of clients) {
      if (c.role === "chief") return true
    }
    return false
  },
  hasRecentMessage(contentPrefix) {
    const since = Date.now() - 300_000
    return !!stmts.hasRecentMessage.get({ $prefix: contentPrefix, $since: since })
  },
  claimDedup(key) {
    // Single writer — no need for BEGIN IMMEDIATE in daemon mode
    const result = stmts.claimDedup.run({ $key: key, $session_id: DAEMON_SESSION_ID, $ts: Date.now() })
    return result.changes > 0
  },
  sessionName: "daemon",
  sessionId: DAEMON_SESSION_ID,
  claudeSessionId: null,
  triggerReload(reason) {
    log(`Plugin requested reload: ${reason}`)
    // Broadcast to all clients that they should reload
    broadcastNotification("reload", { reason })
  },
}

const plugins = [gitPlugin(), beadsPlugin({ beadsDir: BEADS_DIR })]
const stopPlugins = loadPlugins(plugins, pluginCtx)

// Push new plugin-generated messages to clients every second
const pushInterval = setInterval(pushNewMessages, 1000)

// Heartbeat for daemon's own session record
const heartbeatInterval = setInterval(() => sendHeartbeat(daemonCtx), 10_000)

// Data cleanup every 6 hours
const cleanupInterval = setInterval(() => cleanupOldData(daemonCtx), 6 * 60 * 60 * 1000)
cleanupOldPrunedSessions(daemonCtx)
cleanupOldData(daemonCtx)

// ---------------------------------------------------------------------------
// Socket server
// ---------------------------------------------------------------------------

const startedAt = Date.now()

function handleConnection(socket: NetSocket): void {
  const connId = randomUUID()
  log(`Client connected: ${connId.slice(0, 8)}`)

  // Pre-register with socket only (full registration on "register" call)
  const placeholder: ClientSession = {
    socket,
    id: connId,
    name: `pending-${connId.slice(0, 6)}`,
    role: "member",
    domains: [],
    project: process.cwd(),
    pid: 0,
    claudeSessionId: null,
    ctx: daemonCtx,
    registeredAt: Date.now(),
  }
  clients.set(connId, placeholder)
  socketToClient.set(socket, connId)
  cancelQuitTimer()

  const parse = createLineParser(async (msg: JsonRpcMessage) => {
    if (isRequest(msg)) {
      const response = await handleRequest(msg, connId)
      try {
        socket.write(response)
      } catch {
        // Socket died during handling
      }
    }
  })

  socket.on("data", parse)

  socket.on("close", () => {
    const client = clients.get(connId)
    if (client && client.name !== `pending-${connId.slice(0, 6)}`) {
      log(`Client disconnected: ${client.name}`)
      broadcastNotification("session.left", { name: client.name }, connId)
      logEvent(daemonCtx, "session.left", undefined, { name: client.name, via: "daemon" })

      // Prune the session in DB
      try {
        const ts = Date.now()
        db.prepare(
          "UPDATE sessions SET pruned_at = ?, name = name || '-pruned-' || ? WHERE id = ? AND pruned_at IS NULL",
        ).run(ts, ts, client.ctx.sessionId)
      } catch {
        /* best effort */
      }
    }

    clients.delete(connId)
    socketToClient.delete(socket)
    lastDelivered.delete(connId)

    // Start auto-quit timer if no clients left
    if (clients.size === 0) startQuitTimer()
  })

  socket.on("error", (err) => {
    log(`Client error (${connId.slice(0, 8)}): ${err.message}`)
  })
}

let server: Server

if (INHERIT_FD !== null) {
  // Hot-reload: inherit existing socket fd
  server = createServer(handleConnection)
  server.listen({ fd: INHERIT_FD })
  log(`Inherited socket fd ${INHERIT_FD} (hot-reload)`)
} else {
  // Fresh start: clean up stale socket, create new one
  if (existsSync(SOCKET_PATH)) {
    try { unlinkSync(SOCKET_PATH) } catch { /* ignore */ }
  }
  server = createServer(handleConnection)
  server.listen(SOCKET_PATH, () => {
    // Restrict socket to owner only (no group/other access)
    try { chmodSync(SOCKET_PATH, 0o600) } catch { /* ignore on platforms that don't support it */ }
  })
  log(`Listening on ${SOCKET_PATH}`)
}

// Write PID file (owner-only)
writeFileSync(PID_PATH, String(process.pid), { mode: 0o600 })

// Ensure .beads dir is owner-only
try {
  const beadsDir = findBeadsDir()
  if (beadsDir) {
    const st = statSync(beadsDir)
    if ((st.mode & 0o077) !== 0) {
      chmodSync(beadsDir, 0o700)
      log(`Hardened .beads/ permissions to 0700`)
    }
  }
} catch { /* best effort */ }

// ---------------------------------------------------------------------------
// Auto-quit timer
// ---------------------------------------------------------------------------

let quitTimer: ReturnType<typeof setTimeout> | null = null

function startQuitTimer(): void {
  if (QUIT_TIMEOUT < 0) return // -1 = never auto-quit
  if (quitTimer) return

  log(`No clients connected. Auto-quit in ${QUIT_TIMEOUT}s...`)
  quitTimer = setTimeout(() => {
    if (clients.size === 0) {
      log("Auto-quit: no clients connected")
      shutdown()
    }
  }, QUIT_TIMEOUT * 1000)
}

function cancelQuitTimer(): void {
  if (quitTimer) {
    clearTimeout(quitTimer)
    quitTimer = null
  }
}

// ---------------------------------------------------------------------------
// Hot-reload (SIGHUP)
// ---------------------------------------------------------------------------

process.on("SIGHUP", () => {
  log("SIGHUP received — re-exec for hot-reload")

  // Pass the socket fd to the new process
  const socketFd = (server as any)._handle?.fd
  if (socketFd == null) {
    log("Cannot hot-reload: no socket fd available")
    return
  }

  // Stop accepting new connections on old server
  // But don't close existing connections — let them drain

  const argv = process.argv.slice(1).filter((a) => !a.startsWith("--fd"))
  argv.push(`--fd=${socketFd}`)

  const child = spawn(process.execPath, argv, {
    stdio: ["ignore", "inherit", "inherit", socketFd],
    detached: false,
    env: process.env,
  })

  // Give new process time to start, then exit
  child.on("error", (err) => {
    log(`Hot-reload spawn failed: ${err.message}`)
  })

  setTimeout(() => {
    log("Hot-reload: old process exiting, new process taking over")
    stopPlugins()
    clearInterval(pushInterval)
    clearInterval(heartbeatInterval)
    clearInterval(cleanupInterval)
    // Don't close server — fd is inherited by child
    process.exit(0)
  }, 1000)
})

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(): void {
  log("Shutting down...")
  stopPlugins()
  clearInterval(pushInterval)
  clearInterval(heartbeatInterval)
  clearInterval(cleanupInterval)
  cancelQuitTimer()

  // Close all client connections
  for (const [, client] of clients) {
    try { client.socket.end() } catch { /* ignore */ }
  }
  clients.clear()

  server.close()
  try { unlinkSync(SOCKET_PATH) } catch { /* ignore */ }
  try { unlinkSync(PID_PATH) } catch { /* ignore */ }
  try { db.close() } catch { /* ignore */ }
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19)
  process.stderr.write(`[tribe-daemon ${ts}] ${msg}\n`)
}

log(`Daemon ready (pid=${process.pid}, clients=${clients.size})`)
