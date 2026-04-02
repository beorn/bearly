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
import { existsSync, unlinkSync, writeFileSync, chmodSync, readdirSync, readFileSync, watch } from "node:fs"
import { parseArgs } from "node:util"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { dirname as pathDirname, resolve as pathResolve } from "node:path"
import {
  resolveSocketPath,
  resolvePidPath,
  createLineParser,
  makeResponse,
  makeError,
  makeNotification,
  isRequest,
  TRIBE_PROTOCOL_VERSION,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from "./lib/tribe/socket.ts"
import {
  parseTribeArgs,
  parseSessionDomains,
  resolveDbPath,
  detectRole,
  detectName,
  resolveProjectId,
} from "./lib/tribe/config.ts"
import { openDatabase, createStatements } from "./lib/tribe/database.ts"
import { createTribeContext, type TribeContext } from "./lib/tribe/context.ts"
import { handleToolCall } from "./lib/tribe/handlers.ts"
import { logEvent, sendMessage } from "./lib/tribe/messaging.ts"
import { cleanupOldPrunedSessions, cleanupOldData, registerSession, sendHeartbeat } from "./lib/tribe/session.ts"
import { acquireLease } from "./lib/tribe/lease.ts"
import { beadsPlugin, gitPlugin, loadPlugins, type PluginContext } from "./lib/tribe/plugins.ts"
import { githubPlugin } from "./lib/tribe/github-plugin.ts"
import { createLogger } from "loggily"
import { createTimers } from "./lib/tribe/timers.ts"

const ac = new AbortController()
const timers = createTimers(ac.signal)

const _log = createLogger("tribe:daemon")
function log(msg: string): void {
  _log.info?.(msg)
}

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const { values: daemonArgs } = parseArgs({
  options: {
    socket: { type: "string" },
    db: { type: "string" },
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
// Database bootstrap
// ---------------------------------------------------------------------------

const tribeArgs = parseTribeArgs()
// --db from daemon args takes priority over parseTribeArgs
if (daemonArgs.db) tribeArgs.db = daemonArgs.db as string
const DB_PATH = resolveDbPath(tribeArgs)
const db = openDatabase(String(DB_PATH))
const stmts = createStatements(db)

// Daemon always acts as "daemon" role — it doesn't participate as chief/member
const DAEMON_SESSION_ID = randomUUID()
const daemonCtx = createTribeContext({
  db,
  stmts,
  sessionId: DAEMON_SESSION_ID,
  sessionRole: "member", // Daemon is neutral — doesn't claim chief role
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
  projectName: string
  projectId: string
  pid: number
  claudeSessionId: string | null
  peerSocket: string | null // Peer socket path for direct proxy-to-proxy connections
  conn: string // Connection path (socket or db)
  ctx: TribeContext
  registeredAt: number
}

const clients = new Map<string, ClientSession>() // connId → session
const socketToClient = new Map<NetSocket, string>() // socket → connId

/** No-op handler opts for daemon-side tool calls (no MCP session to clean up) */
const DAEMON_HANDLER_OPTS = { cleanup: () => {}, userRenamed: false, setUserRenamed: () => {} } as const

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

/** Single entry point for all observable activities.
 *  Writes to DB → pushNewMessages delivers to all clients on next tick (≤1s). */
function logActivity(type: string, content: string): void {
  sendMessage(daemonCtx, "*", content, type)
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
// Helpers
// ---------------------------------------------------------------------------

/** Make a path relative to cwd */
function relPath(p: string): string {
  const cwd = process.cwd()
  return p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p
}

/** Generate a unique member-<pid> name, with random suffix if taken */
function generateMemberName(pid: number, connId: string): string {
  const pidName = `member-${pid || connId.slice(0, 6)}`
  const taken = db.prepare("SELECT id FROM sessions WHERE name = ? AND pruned_at IS NULL").get(pidName)
  return taken ? `member-${pid}-${Math.random().toString(36).slice(2, 5)}` : pidName
}

/** Deduplicate name against connected clients */
function deduplicateName(name: string): string {
  const connectedNames = new Set(Array.from(clients.values()).map((c) => c.name))
  if (!connectedNames.has(name)) return name
  const base = name
  let suffix = 2
  while (connectedNames.has(`${base}-${suffix}`)) suffix++
  return `${base}-${suffix}`
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
        const clientPid = Number(p.pid ?? 0)
        const claudeSessionName = (p.claudeSessionName as string) ?? null
        const claudeSessionId = (p.claudeSessionId as string) ?? null
        const role = String(p.role ?? "member") as "chief" | "member"

        // Name priority: explicit > Claude session name > recovered from DB > role-based > pid-based
        let name: string
        if (p.name) {
          name = String(p.name)
        } else if (claudeSessionName) {
          name = claudeSessionName
        } else {
          // Try recovering name from previous session with same Claude session ID
          const prev = claudeSessionId
            ? (db
                .prepare(
                  "SELECT name FROM sessions WHERE claude_session_id = ? AND pruned_at IS NULL ORDER BY heartbeat DESC LIMIT 1",
                )
                .get(claudeSessionId) as { name: string } | null)
            : null
          if (prev && !prev.name.startsWith("member-") && !prev.name.startsWith("pending-")) {
            name = prev.name
          } else {
            const projectName = String(
              p.projectName ??
                String(p.project ?? process.cwd())
                  .split("/")
                  .pop() ??
                "unknown",
            )
            name = role === "chief" ? "chief" : projectName
          }
        }
        name = deduplicateName(name)

        const domains = (p.domains as string[]) ?? []
        const project = String(p.project ?? process.cwd())
        const projectName = String(p.projectName ?? project.split("/").pop() ?? "unknown")
        const projectId = String(p.projectId ?? resolveProjectId(project))
        const peerSocket = (p.peerSocket as string) ?? null
        const pid = Number(p.pid ?? 0)

        // Log protocol version mismatch as warning
        const clientProtocolVersion = p.protocolVersion ? Number(p.protocolVersion) : undefined
        if (clientProtocolVersion !== undefined && clientProtocolVersion !== TRIBE_PROTOCOL_VERSION) {
          log(
            `Protocol version mismatch: client=${clientProtocolVersion}, daemon=${TRIBE_PROTOCOL_VERSION} (session=${name})`,
          )
        }

        const clientCtx = createTribeContext({
          db,
          stmts,
          sessionId: randomUUID(),
          sessionRole: role,
          initialName: name,
          domains,
          claudeSessionId,
          claudeSessionName,
        })

        registerSession(clientCtx, projectId)
        if (role === "chief") {
          acquireLease(db, clientCtx.sessionId, name)
        }

        const client: ClientSession = {
          socket: clients.get(connId)!.socket,
          id: connId,
          name,
          role,
          domains,
          project,
          projectName,
          projectId,
          pid,
          claudeSessionId,
          peerSocket,
          conn: relPath(SOCKET_PATH),
          ctx: clientCtx,
          registeredAt: Date.now(),
        }
        clients.set(connId, client)
        cancelQuitTimer()

        const shortProject = project.replace(process.env.HOME ?? "", "~")
        // Suppress join broadcasts during first 10s after daemon start (reconnection burst after hot-reload)
        if (Date.now() - startedAt > 10_000) {
          // Detect sub-agents: if another session shares the same claudeSessionId, this is a sub-agent
          let parentName: string | null = null
          if (claudeSessionId) {
            for (const [cid, c] of clients) {
              if (cid !== connId && c.claudeSessionId === claudeSessionId) {
                parentName = c.name
                break
              }
            }
          }
          const suffix = parentName ? ` (sub-agent of ${parentName})` : ""
          logActivity("session", `${name} joined (${role}) pid=${pid} ${shortProject}${suffix}`)
        }

        const chief = Array.from(clients.values()).find((c) => c.role === "chief" && c.id !== connId)

        // Return current coordination state for this project
        const coordState = db
          .prepare("SELECT key, value FROM coordination WHERE project_id = ?")
          .all(projectId) as Array<{ key: string; value: string | null }>

        return makeResponse(id, {
          sessionId: clientCtx.sessionId,
          name,
          role,
          chief: chief?.name ?? "none",
          protocolVersion: TRIBE_PROTOCOL_VERSION,
          coordinationState: coordState,
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

        const result = await handleToolCall(ctx, method, p, DAEMON_HANDLER_OPTS)

        // Sync client registry after name/role changes
        // (Don't logActivity here — the handler already broadcasts for rename,
        // and for join the session announces itself. Avoids duplicate messages.)
        if ((method === "tribe_join" || method === "tribe_rename") && client) {
          client.name = ctx.getName()
          client.role = ctx.getRole()
        }

        // After handling, push any new messages to recipients
        // (The handler writes to DB; we need to check for new messages and push)
        pushNewMessages()

        return makeResponse(id, result)
      }

      // CLI-specific methods
      case "cli_status": {
        const now = Date.now()

        // Build parent map: first session per claudeSessionId is the parent
        const parentMap = new Map<string, string>()
        for (const [, c] of clients) {
          if (c.claudeSessionId && !parentMap.has(c.claudeSessionId)) {
            parentMap.set(c.claudeSessionId, c.name)
          }
        }

        const sessions = Array.from(clients.values()).map((c) => {
          const parent = c.claudeSessionId ? parentMap.get(c.claudeSessionId) : undefined
          return {
            id: c.id,
            name: c.name,
            role: c.role,
            domains: c.domains,
            pid: c.pid,
            project: c.project,
            projectName: c.projectName,
            projectId: c.projectId,
            claudeSessionId: c.claudeSessionId,
            peerSocket: c.peerSocket,
            connectedAt: c.registeredAt,
            uptimeMs: now - c.registeredAt,
            source: "daemon" as const,
            conn: c.conn,
            resources: [] as string[],
            parent: parent && parent !== c.name ? parent : undefined,
          }
        })

        return makeResponse(id, {
          sessions,
          daemon: {
            pid: process.pid,
            uptime: Math.floor((Date.now() - startedAt) / 1000),
            clients: clients.size,
            dbPath: DB_PATH,
            socketPath: SOCKET_PATH,
            resources: activePluginNames,
          },
        })
      }

      case "cli_health": {
        const health = await handleToolCall(
          daemonCtx,
          "tribe_health",
          {},
          {
            cleanup: () => {},
            userRenamed: false,
            setUserRenamed: () => {},
          },
        )
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

      // Log event — fire-and-forget from proxies for observability
      case "log_event": {
        const client = clients.get(connId)
        const ctx = client?.ctx ?? daemonCtx
        // Write to legacy events table
        logEvent(
          ctx,
          String(p.type ?? "unknown"),
          p.bead_id as string | undefined,
          p.meta as Record<string, unknown> | undefined,
        )
        // Also write to new event_log table (observability, with project_id)
        db.prepare("INSERT INTO event_log (ts, session_id, project_id, type, meta) VALUES (?, ?, ?, ?, ?)").run(
          Date.now(),
          client?.ctx?.sessionId ?? null,
          String(p.project_id ?? client?.projectId ?? ""),
          String(p.type ?? ""),
          p.meta ? JSON.stringify(p.meta) : null,
        )
        // If content is provided, also broadcast via logActivity for watch visibility
        if (p.content) logActivity(String(p.type ?? "event"), String(p.content))
        return makeResponse(id, { ok: true })
      }

      // Discovery — find peers by project, name, or resource
      case "discover": {
        const query = {
          project_id: p.project_id as string | undefined,
          name: p.name as string | undefined,
        }

        let results = Array.from(clients.values()).filter((c) => !c.name.startsWith("pending-"))
        if (query.project_id) results = results.filter((c) => c.projectId === query.project_id)
        if (query.name) results = results.filter((c) => c.name === query.name)

        return makeResponse(id, {
          results: results.map((c) => ({
            name: c.name,
            role: c.role,
            project: c.project,
            projectId: c.projectId,
            peerSocket: c.peerSocket,
            domains: c.domains,
          })),
        })
      }

      // Coordination state — queryable key-value per project
      case "set_state": {
        const client = clients.get(connId)
        const projectId = String(p.project_id ?? client?.projectId ?? "")
        const key = String(p.key)
        const value = p.value !== undefined ? JSON.stringify(p.value) : null
        db.prepare(
          "INSERT OR REPLACE INTO coordination (project_id, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)",
        ).run(projectId, key, value, client?.name ?? "daemon", Date.now())
        return makeResponse(id, { ok: true })
      }

      case "get_state": {
        const client = clients.get(connId)
        const projectId = String(p.project_id ?? client?.projectId ?? "")
        if (p.key) {
          const row = db
            .prepare("SELECT * FROM coordination WHERE project_id = ? AND key = ?")
            .get(projectId, String(p.key))
          return makeResponse(id, { state: row ?? null })
        }
        const rows = db.prepare("SELECT * FROM coordination WHERE project_id = ?").all(projectId)
        return makeResponse(id, { state: rows })
      }

      // Stream mode for watch
      case "subscribe": {
        return makeResponse(id, { subscribed: true })
      }

      // Client heartbeat — keeps session alive in DB
      case "heartbeat": {
        const hbClient = clients.get(connId)
        if (hbClient?.ctx) sendHeartbeat(hbClient.ctx)
        return makeResponse(id, { ok: true })
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
      // Watch sessions see ALL messages; regular sessions see only theirs + broadcasts
      const query = client.name.startsWith("watch-")
        ? "SELECT id, type, sender, recipient, content, bead_id, ts FROM messages WHERE ts > ? AND sender != ? ORDER BY ts ASC LIMIT 50"
        : "SELECT id, type, sender, recipient, content, bead_id, ts FROM messages WHERE ts > ? AND (recipient = ? OR recipient = '*') AND sender != ? ORDER BY ts ASC LIMIT 50"
      const params = client.name.startsWith("watch-") ? [since, client.name] : [since, client.name, client.name]
      const messages = db.prepare(query).all(...params) as Array<{
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
    logActivity("reload", `reload: ${reason}`)
  },
  getSessionNames() {
    return Array.from(clients.values())
      .filter((c) => !c.name.startsWith("watch-") && !c.name.startsWith("pending-"))
      .map((c) => c.name)
  },
}

const plugins = [gitPlugin(), beadsPlugin(), githubPlugin()]
const activePluginNames = plugins.filter((p) => p.available()).map((p) => p.name)
const stopPlugins = loadPlugins(plugins, pluginCtx)

// Push new plugin-generated messages to clients every second
const pushInterval = timers.setInterval(pushNewMessages, 1000)

// Heartbeat for daemon's own session record
const heartbeatInterval = timers.setInterval(() => sendHeartbeat(daemonCtx), 10_000)

// Data cleanup every 6 hours
const cleanupInterval = timers.setInterval(() => cleanupOldData(daemonCtx), 6 * 60 * 60 * 1000)
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
    projectName: "unknown",
    projectId: "",
    pid: 0,
    claudeSessionId: null,
    peerSocket: null,
    conn: "",
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
      logActivity("session", `${client.name} left`)

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
    // Error triggers close event, which handles cleanup
    socket.destroy()
  })
}

let server: Server

if (INHERIT_FD !== null) {
  // Hot-reload: inherit existing socket fd
  server = createServer(handleConnection)
  server.listen({ fd: INHERIT_FD })
  log(`Inherited socket fd ${INHERIT_FD} (hot-reload)`)
} else {
  // Check if another daemon is already running
  if (existsSync(PID_PATH)) {
    try {
      const existingPid = parseInt(readFileSync(PID_PATH, "utf-8").trim(), 10)
      if (!isNaN(existingPid)) {
        try {
          process.kill(existingPid, 0) // Throws if dead
          log(`Another daemon is already running (pid ${existingPid}), exiting`)
          process.exit(0)
        } catch {
          // PID is dead — stale file, continue startup
        }
      }
    } catch {
      /* can't read PID file */
    }
  }

  // Fresh start: clean up stale socket, create new one
  if (existsSync(SOCKET_PATH)) {
    try {
      unlinkSync(SOCKET_PATH)
    } catch {
      /* ignore */
    }
  }
  server = createServer(handleConnection)
  server.listen(SOCKET_PATH, () => {
    // Restrict socket to owner only (no group/other access)
    try {
      chmodSync(SOCKET_PATH, 0o600)
    } catch {
      /* ignore on platforms that don't support it */
    }
  })
  log(`Listening on ${SOCKET_PATH}`)
}

// Write PID file (owner-only)
writeFileSync(PID_PATH, String(process.pid), { mode: 0o600 })

// ---------------------------------------------------------------------------
// Auto-quit timer
// ---------------------------------------------------------------------------

let quitTimer: ReturnType<typeof setTimeout> | null = null

function startQuitTimer(): void {
  if (QUIT_TIMEOUT < 0) return // -1 = never auto-quit
  if (quitTimer) return

  log(`No clients connected. Auto-quit in ${QUIT_TIMEOUT}s...`)
  quitTimer = timers.setTimeout(() => {
    if (clients.size === 0) {
      log("Auto-quit: no clients connected")
      shutdown()
    }
  }, QUIT_TIMEOUT * 1000)
}

function cancelQuitTimer(): void {
  if (quitTimer) {
    timers.clearTimeout(quitTimer)
    quitTimer = null
  }
}

// ---------------------------------------------------------------------------
// Hot-reload (SIGHUP)
// ---------------------------------------------------------------------------

process.on("SIGHUP", () => {
  log("SIGHUP received — re-exec for hot-reload")
  // Don't broadcast reload — sessions reconnect automatically and don't need to know

  // Stop plugins BEFORE spawning — ensures cursor/state is flushed to disk
  // so the new process reads up-to-date state (prevents duplicate event delivery)
  stopPlugins()

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

  timers.setTimeout(() => {
    log("Hot-reload: old process exiting, new process taking over")
    ac.abort()
    // Don't close server — fd is inherited by child
    process.exit(0)
  }, 1000)
})

// ---------------------------------------------------------------------------
// Source file watcher — auto-SIGHUP on code changes
// ---------------------------------------------------------------------------

const sourceDir = pathDirname(new URL(import.meta.url).pathname)
const libTribeDir = pathResolve(sourceDir, "lib/tribe")

function computeSourceHash(): string {
  const files = [
    pathResolve(sourceDir, "tribe-daemon.ts"),
    pathResolve(sourceDir, "tribe-proxy.ts"),
    ...(() => {
      try {
        return readdirSync(libTribeDir)
          .filter((f) => f.endsWith(".ts"))
          .sort()
          .map((f) => pathResolve(libTribeDir, f))
      } catch {
        return []
      }
    })(),
  ]
  const hash = createHash("md5")
  for (const f of files) {
    try {
      hash.update(readFileSync(f))
    } catch {
      /* missing */
    }
  }
  return hash.digest("hex").slice(0, 12)
}

let sourceHash = computeSourceHash()
let reloadDebounce: ReturnType<typeof setTimeout> | null = null

function onSourceChange(filename: string | null): void {
  if (filename && !filename.endsWith(".ts")) return
  if (reloadDebounce) timers.clearTimeout(reloadDebounce)
  reloadDebounce = timers.setTimeout(() => {
    const newHash = computeSourceHash()
    if (newHash === sourceHash) return // No actual change
    log(`Source changed (${sourceHash} → ${newHash}), triggering hot-reload`)
    sourceHash = newHash
    process.emit("SIGHUP")
  }, 500)
}

// Watch both the tools dir (tribe-daemon.ts, tribe-proxy.ts) and lib/tribe/
const watchers = [
  watch(sourceDir, { persistent: false }, (_event, filename) => onSourceChange(filename)),
  ...(existsSync(libTribeDir)
    ? [watch(libTribeDir, { persistent: false }, (_event, filename) => onSourceChange(filename))]
    : []),
]
log(`Watching source files for auto-reload`)

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(): void {
  log("Shutting down...")
  stopPlugins()
  ac.abort() // Clears all managed timers (push, heartbeat, cleanup, quit, debounce)
  for (const w of watchers) w.close()

  // Close all client connections
  for (const [, client] of clients) {
    try {
      client.socket.end()
    } catch {
      /* ignore */
    }
  }
  clients.clear()

  server.close()
  try {
    unlinkSync(SOCKET_PATH)
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(PID_PATH)
  } catch {
    /* ignore */
  }
  try {
    db.close()
  } catch {
    /* ignore */
  }
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

log(`Daemon ready (pid=${process.pid}, clients=${clients.size})`)
