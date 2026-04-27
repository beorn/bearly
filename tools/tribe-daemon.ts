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

import { unlinkSync } from "node:fs"
import { parseArgs } from "node:util"
import {
  resolveSocketPath,
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
  type TribeRole,
} from "./lib/tribe/config.ts"
import { createTribeContext, type TribeContext } from "./lib/tribe/context.ts"
import { handleToolCall, TRIBE_COORD_METHODS } from "./lib/tribe/handlers.ts"
import { logEvent, sendMessage } from "./lib/tribe/messaging.ts"
import { cleanupOldData, registerSession } from "./lib/tribe/session.ts"
import type { TribeClientApi } from "./lib/tribe/plugin-api.ts"
import { loadPlugins } from "./lib/tribe/plugin-loader.ts"
import { gitPlugin } from "./lib/tribe/git-plugin.ts"
import { beadsPlugin } from "./lib/tribe/beads-plugin.ts"
import { githubPlugin } from "./lib/tribe/github-plugin.ts"
import { healthMonitorPlugin } from "./lib/tribe/health-monitor-plugin.ts"
import { accountlyPlugin } from "./lib/tribe/accountly-plugin.ts"
import { doltReaperPlugin } from "./lib/tribe/dolt-reaper-plugin.ts"
import { createLogger } from "loggily"
import { createTimers } from "./lib/tribe/timers.ts"
import { type LoreConnState } from "./lib/tribe/lore-handlers.ts"
// Composition layer — pipe + with* factories. The boot sequence below uses
// these to assemble config, db, daemonCtx, lore, and the protocol-agnostic
// tool registry. Reading top-down through the pipe() call IS the boot order
// (see hub/composition.md). The still-imperative socket / dispatch / hot-reload
// parts attach to the assembled value below the pipe.
import { pipe, withTool, withTools, createScope } from "@bearly/daemon-spine"
import {
  createBaseTribe,
  loreTools,
  messagingTools,
  probeAndCleanSocket,
  withBroadcast,
  withClientRegistry,
  withConfig,
  withDaemonContext,
  withDatabase,
  withDispatcher,
  withHotReload,
  withLore,
  withProjectRoot,
  withSignals,
  withSocketServer,
} from "./lib/tribe/compose/index.ts"

const ac = new AbortController()
const timers = createTimers(ac.signal)

const _log = createLogger("tribe:daemon")
function log(msg: string): void {
  _log.info?.(msg)
}

// Daemon warn/error log fanout to tribe is wired by withBroadcast — see
// lib/tribe/compose/with-broadcast.ts. The loggily writer is installed once at
// module load and reads the active broadcast handle from a swap slot.

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const { values: daemonArgs } = parseArgs({
  options: {
    socket: { type: "string" },
    db: { type: "string" },
    fd: { type: "string" },
    // Default 30 minutes — long enough to survive a Claude Code session
    // restart (close terminal, reopen, reconnect), short enough that an
    // idle daemon eventually cleans itself up. The previous 30-second
    // default caused frequent "tribe MCP disconnected" errors when users
    // briefly stepped away — see km-tribe.reliability-sweep-0415.
    // Use --quit-timeout 0 to quit immediately, --quit-timeout -1 to never auto-quit.
    "quit-timeout": { type: "string", default: "1800" },
    foreground: { type: "boolean", default: false },
    // Lore (memory) handler options — see createLoreHandlers. Defaults match
    // the standalone lore daemon so behaviour is unchanged after the merge.
    "lore-db": { type: "string" },
    "focus-poll-ms": { type: "string", default: process.env.TRIBE_FOCUS_POLL_MS ?? "60000" },
    "summary-poll-ms": { type: "string", default: process.env.TRIBE_SUMMARY_POLL_MS ?? "120000" },
    "summarizer-model": { type: "string", default: process.env.TRIBE_SUMMARIZER_MODEL ?? "off" },
    "no-lore": { type: "boolean", default: false },
  },
  strict: false,
})

// ---------------------------------------------------------------------------
// Compose the tribe value (km-tribe.composition-pipe). Each withX factory
// extends the value with one capability; cleanup registers on the daemon's
// root scope. Reading top-down is the boot story:
//
//   createBaseTribe   — scope, daemonSessionId, startedAt, daemonVersion, pid
//   withConfig        — argv + env → TribeConfig (socket path, db paths, …)
//   withProjectRoot   — process.cwd() (filesystem scope = "one tribe per root")
//   withDatabase      — open SQLite, register close on scope
//   withDaemonContext — daemon-role TribeContext bound to daemonSessionId
//   withLore          — memory/recall RPC surface (closed via scope.signal)
//   withTools         — establish protocol-agnostic tool registry
//   withTool(messagingTools()) — tribe.send/broadcast/members/history/…
//   withTool(loreTools(lore))  — tribe.ask/brief/plan/session_*/inject_delta
//
// The remaining imperative blocks (client registry, chief derivation, broadcast
// pipeline, socket server, JSON-RPC dispatcher, hot-reload, idle-quit, signal
// handlers) destructure the assembled value below and operate on it. Once that
// state is decomposed into withX factories of its own (follow-on bead
// km-tribe.composition-pipe-runtime), the destructuring goes away.
// ---------------------------------------------------------------------------

// Build a Scope linked to the existing AbortController so shutdown() and the
// pipe's scope cascade stay in sync (closing either fires the other's cleanup).
const rootScope = createScope("tribe-daemon")
ac.signal.addEventListener("abort", () => {
  void rootScope[Symbol.asyncDispose]().catch(() => {})
})

const partialShape = pipe(
  createBaseTribe({ scope: rootScope, daemonVersion: "0.10.0" }),
  withConfig(),
  withProjectRoot(),
  withDatabase(),
  withDaemonContext(),
  withLore(),
  withTools(),
  withTool(messagingTools()),
  withClientRegistry(),
  withBroadcast(),
)

// Async probe runs OUTSIDE the pipe (sync). If a live daemon already owns the
// socket path, exit cleanly — the rest of boot is meaningless. Otherwise the
// stale socket file is removed so withSocketServer's bind() succeeds.
if (partialShape.config.inheritFd === null) {
  const alreadyAlive = await probeAndCleanSocket(partialShape.config.socketPath)
  if (alreadyAlive) {
    log(`Another daemon is already listening on ${partialShape.config.socketPath}, exiting`)
    process.exit(0)
  }
}

// Refs for runtime hooks the dispatcher needs but that are wired up later
// (idle-quit's markActive/markIdle, plugin names, quit-timeout). Each hook is
// a thin lambda that reads through the ref so Phase 4 can land before
// withIdleQuit / withRuntime / plugin loading move into the pipe.
const activePluginNamesRef: { current: string[] } = { current: [] }
const markActiveRef: { current: () => void } = { current: () => {} }
const markIdleRef: { current: () => void } = { current: () => {} }

// Refs for shutdown / stopPlugins — wired up after the runtime constructs them.
const stopPluginsRef: { current: () => void } = { current: () => {} }
const shutdownRef: { current: () => void } = { current: () => {} }

const withSocketShape = withSocketServer<typeof partialShape>()(partialShape)
const withDispatcherShape = withDispatcher<typeof withSocketShape>({
  onActiveClient: () => markActiveRef.current(),
  onIdle: () => markIdleRef.current(),
  getActivePluginNames: () => activePluginNamesRef.current,
  getQuitTimeoutSec: () => withSocketShape.config.quitTimeoutSec,
})(withSocketShape)
const withHotReloadShape = withHotReload<typeof withDispatcherShape>({
  stopPlugins: () => stopPluginsRef.current(),
  triggerShutdown: () => shutdownRef.current(),
})(withDispatcherShape)
const tribeShape = withSignals<typeof withHotReloadShape>({
  onShutdown: () => shutdownRef.current(),
  onReload: () => withHotReloadShape.hotReload.reload(),
})(withHotReloadShape)

// Lore tools are conditional on lore being enabled — register them after the
// pipe so the registry stays append-only when --no-lore is set.
if (tribeShape.lore) {
  for (const t of loreTools(tribeShape.lore)) tribeShape.tools.set(t.name, t)
}

// Destructure into the locals the rest of this module uses. The names match
// the historical imperative versions so the transition is mechanical.
const SOCKET_PATH = tribeShape.config.socketPath
const QUIT_TIMEOUT = tribeShape.config.quitTimeoutSec
const INHERIT_FD = tribeShape.config.inheritFd
const DB_PATH = tribeShape.config.dbPath
const LORE_DB_PATH = tribeShape.config.loreDbPath
const db = tribeShape.db
const stmts = tribeShape.stmts
const DAEMON_SESSION_ID = tribeShape.daemonSessionId
const daemonCtx = tribeShape.daemonCtx
const loreHandlers = tribeShape.lore
const TOOL_REGISTRY = tribeShape.tools
const registry = tribeShape.registry
const clients = registry.clients
const socketToClient = registry.socketToClient
const broadcast = tribeShape.broadcast
void broadcast

/** Single entry point for all observable activities. Writes to DB; the messaging
 *  layer's fanout hook delivers to connected clients synchronously (see
 *  withBroadcast). No polling tick involved.
 *
 *  km-tribe.event-classification: daemon log activity (session join/leave,
 *  rename, status) is ambient — the channel marker already tags these as
 *  notification-only, but routing them to inbox-only spares the channel
 *  entirely. */
function logActivity(type: string, content: string): void {
  sendMessage(daemonCtx, "*", content, type, undefined, undefined, "broadcast", {
    delivery: "pull",
    responseExpected: "no",
    pluginKind: `daemon:${type}`,
  })
}

log(`Starting tribe daemon`)
log(`Socket: ${SOCKET_PATH}`)
log(`DB: ${DB_PATH}`)
log(`PID: ${process.pid}`)
if (loreHandlers) log(`Lore DB: ${LORE_DB_PATH}`)

// ---------------------------------------------------------------------------
// Plugins (git / beads / github / health / accountly)
//
// Plugins are optional observer modules that emit messages onto the tribe
// wire via TribeClientApi. The daemon's core responsibilities (register,
// broadcast, fanout, lore) don't depend on any plugin — TRIBE_NO_PLUGINS=1
// boots a fully functional daemon with zero plugins.
// ---------------------------------------------------------------------------

const tribeClientApi: TribeClientApi = {
  send(recipient, content, type, beadId, classification) {
    sendMessage(
      daemonCtx,
      recipient,
      content,
      type,
      beadId,
      undefined,
      recipient === "*" ? "broadcast" : "direct",
      classification ?? {},
    )
  },
  broadcast(content, type, beadId, classification) {
    sendMessage(daemonCtx, "*", content, type, beadId, undefined, "broadcast", classification ?? {})
  },
  claimDedup(key) {
    const result = stmts.claimDedup.run({ $key: key, $session_id: DAEMON_SESSION_ID, $ts: Date.now() })
    return result.changes > 0
  },
  hasRecentMessage(contentPrefix) {
    const since = Date.now() - 300_000
    return !!stmts.hasRecentMessage.get({ $prefix: contentPrefix, $since: since })
  },
  getActiveSessions() {
    return Array.from(clients.values())
      .filter((c) => c.role !== "watch" && c.role !== "pending")
      .map((c) => ({ name: c.name, pid: c.pid, role: c.role }))
  },
  getSessionNames() {
    return Array.from(clients.values())
      .filter((c) => c.role !== "watch" && c.role !== "pending")
      .map((c) => c.name)
  },
  hasChief() {
    return registry.getChiefId() !== null
  },
}

const plugins = process.env.TRIBE_NO_PLUGINS
  ? []
  : [gitPlugin, beadsPlugin, githubPlugin, healthMonitorPlugin, accountlyPlugin, doltReaperPlugin]
const loadedPlugins = loadPlugins(plugins, tribeClientApi)
const activePluginNames = loadedPlugins.active.filter((p) => p.active).map((p) => p.name)
const stopPlugins = loadedPlugins.stop

// Publish the plugin names through the dispatcher's runtime hook (cli_status).
activePluginNamesRef.current = activePluginNames

// 1-second tick: idle-liveness only. Messages are delivered synchronously via
// the ctx.onMessageInserted fanout hook (km-tribe.event-bus), so there's no
// polling drain in this tick anymore.
const livenessInterval = timers.setInterval(() => {
  checkLiveness()
}, 1000)

// Data cleanup every 6 hours
const cleanupInterval = timers.setInterval(() => cleanupOldData(daemonCtx), 6 * 60 * 60 * 1000)
cleanupOldData(daemonCtx)

// withDispatcher already attached `handleConnection` to socket.server during
// composition. The connection-as-lease idle hooks are wired via the
// markActive/markIdle ref lambdas defined alongside the pipe.

// ---------------------------------------------------------------------------
// Auto-quit liveness — declarative deadline + periodic check
// ---------------------------------------------------------------------------
//
// Liveness is a pure function of current state, not an event-driven timer:
//   - markActive()   — clear the deadline (someone is using us)
//   - markIdle()     — set the deadline (we may be done; checkLiveness decides)
//   - checkLiveness() — runs from the existing 1s tick poller
//
// This eliminates the bug class where a code path forgets to start/cancel
// a setTimeout. Adding a new "extends life" trigger is one line: markActive().

let idleDeadline: number | null = null

function markActive(): void {
  idleDeadline = null
}

function markIdle(): void {
  if (QUIT_TIMEOUT < 0) return // -1 = never auto-quit
  if (idleDeadline !== null) return // already counting down
  idleDeadline = Date.now() + QUIT_TIMEOUT * 1000
  log(`No clients connected. Auto-quit in ${QUIT_TIMEOUT}s...`)
}

// Wire the dispatcher's runtime hooks now that markActive/markIdle exist.
// Phase 8 (withIdleQuit) will fold these into a factory so the refs go away.
markActiveRef.current = markActive
markIdleRef.current = markIdle

function checkLiveness(): void {
  // Expire pending sessions that never sent a register message (>60s)
  const now = Date.now()
  for (const [connId, client] of clients) {
    if (client.role === "pending" && now - client.registeredAt > 60_000) {
      log(`Expiring stale pending session: ${client.name} (age=${Math.floor((now - client.registeredAt) / 1000)}s)`)
      clients.delete(connId)
      socketToClient.delete(client.socket)
      try {
        client.socket.destroy()
      } catch {
        /* already dead */
      }
    }
  }

  if (idleDeadline === null) return
  // Defensive: if a client snuck in, abort the countdown
  if (clients.size > 0) {
    idleDeadline = null
    return
  }
  if (now >= idleDeadline) {
    log("Auto-quit: idle deadline reached")
    shutdown()
  }
}


// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(): void {
  log("Shutting down...")
  stopPlugins()
  ac.abort() // Clears all managed timers (push, cleanup, quit, debounce)
  // Close lore handlers (stops focus poller + summarizer, closes lore.db).
  // `ac.abort()` above already triggers this via the AbortSignal hook, but
  // call explicitly for clarity and pre-abort ordering.
  void loreHandlers?.close()
  // Watchers, server, socket file unlink, and db close are all registered on
  // the root scope by withHotReload / withSocketServer / withDatabase — the
  // ac.abort() above triggers rootScope's asyncDispose, which cascades them.

  // Close all client connections
  for (const [, client] of clients) {
    try {
      client.socket.end()
    } catch {
      /* ignore */
    }
  }
  clients.clear()

  // Belt-and-braces unlink — Hot-reload + scope close handle this normally,
  // but a SIGINT during a wedged dispose path benefits from the explicit call.
  try {
    unlinkSync(SOCKET_PATH)
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

// SIGINT / SIGTERM / SIGHUP are routed via withSignals → shutdownRef /
// hotReload.reload(). Wire shutdownRef + stopPluginsRef now that they exist.
shutdownRef.current = shutdown
stopPluginsRef.current = stopPlugins

log(`Daemon ready (pid=${process.pid}, clients=${clients.size})`)

// Begin idle countdown immediately. If a client connects before the deadline,
// markActive() in handleConnection clears it. This handles the case where a
// daemon is spawned but no client ever connects (e.g. spawning test crashes).
if (clients.size === 0) markIdle()

// ---------------------------------------------------------------------------
// Runtime entry — `await tribe.run()`
//
// The composition pipe at the top of this file builds the daemon value; this
// section attaches the still-imperative socket / dispatch / hot-reload /
// idle-quit behavior to it. The historical entry point is "module-load
// runs everything"; `tribe.run()` formalises that into an awaitable that
// resolves when the daemon shuts down (SIGTERM, SIGINT, idle quit, fatal
// error). Aligns with silvery's `run(view, …)` and the era2 lifecycle.
//
// Today this is a thin wait-for-abort. Once the runtime decomposes into
// withSocketServer / withDispatcher / withSignals / withHotReload factories
// (follow-on bead km-tribe.composition-pipe-runtime), `run()` moves into
// `withRuntime()` and becomes the proper apply-and-emit loop.
// ---------------------------------------------------------------------------

const tribe = {
  ...tribeShape,
  /** Resolves when the daemon shuts down. The Scope cascade fires before resolve. */
  run(): Promise<void> {
    return new Promise((resolve) => {
      if (ac.signal.aborted) {
        resolve()
        return
      }
      ac.signal.addEventListener("abort", () => resolve(), { once: true })
    })
  },
} as const

// Top-level await — the module's last act is the run loop.
// Since the daemon installs SIGINT/SIGTERM handlers that call shutdown() →
// process.exit(0), this await typically doesn't return; it's a clean entry
// point for callers that need to know the daemon is exiting.
await tribe.run()
