#!/usr/bin/env bun
/**
 * Tribe Daemon — single process per project, sessions connect via Unix socket.
 *
 * Usage:
 *   bun tribe-daemon.ts                    # Auto-discover socket path
 *   bun tribe-daemon.ts --socket /path     # Explicit socket path
 *   bun tribe-daemon.ts --quit-timeout 0   # Quit immediately when last client disconnects
 *   bun tribe-daemon.ts --fd 3             # Inherit socket fd (for hot-reload re-exec)
 *
 * The boot sequence reads top-down through the pipe(...) call below — that IS
 * the architecture. Each `withX` factory adds one capability to the daemon
 * value; cleanup registers on the root scope. See hub/composition.md for the
 * full strategy.
 */

import { createLogger } from "loggily"
import { pipe, withTool, withTools, createScope } from "@bearly/tribe-client"
import { gitPlugin } from "./lib/tribe/git-plugin.ts"
import { beadsPlugin } from "./lib/tribe/beads-plugin.ts"
import { githubPlugin } from "./lib/tribe/github-plugin.ts"
import { healthMonitorPlugin } from "./lib/tribe/health-monitor-plugin.ts"
import { accountlyPlugin } from "./lib/tribe/accountly-plugin.ts"

import {
  createBaseTribe,
  recallTools,
  messagingTools,
  probeAndCleanSocket,
  withBroadcast,
  withClientRegistry,
  withConfig,
  withDaemonContext,
  withDatabase,
  withDispatcher,
  withHotReload,
  withIdleQuit,
  withRecall,
  withMCPServer,
  withProjectRoot,
  withRuntime,
  withSignals,
  withSocketServer,
} from "./lib/tribe/compose/index.ts"
import { TOOLS_LIST } from "@bearly/tribe-client/lib/tools-list"
import { pruneOldActivityLogs } from "./lib/tribe/activity-log.ts"

const log = createLogger("tribe:daemon")

// ---------------------------------------------------------------------------
// Sync portion of the pipe — config, db, daemonCtx, recall, tools, registry,
// broadcast pipeline. Stops here so the alive-probe (async) can run before
// withSocketServer attempts to bind.
// ---------------------------------------------------------------------------

const rootScope = createScope("tribe-daemon")

const partialShape = pipe(
  createBaseTribe({ scope: rootScope, daemonVersion: "0.10.0" }),
  withConfig(),
  withProjectRoot(),
  withDatabase(),
  withDaemonContext(),
  withRecall(),
  withTools(),
  withTool(messagingTools()),
  withClientRegistry(),
  withBroadcast(),
)

// ---------------------------------------------------------------------------
// Async setup outside the pipe (per hub/composition.md § "Async — outside the
// pipe"). Probe an existing socket: if a live daemon owns it, exit; if it's
// stale, the function unlinks it so withSocketServer's bind() succeeds.
// ---------------------------------------------------------------------------

if (partialShape.config.inheritFd === null) {
  const alreadyAlive = await probeAndCleanSocket(partialShape.config.socketPath)
  if (alreadyAlive) {
    log.info?.(`Another daemon is already listening on ${partialShape.config.socketPath}, exiting`)
    process.exit(0)
  }
}

// One-shot retention sweep: remove activity-*.jsonl files older than 30 days.
// Best-effort; failures never block daemon startup. See @km/tribe/activity-log
// (acceptance criterion "Daily rotation at midnight, no event loss across
// rollover" implies bounded retention).
try {
  const removed = pruneOldActivityLogs(30)
  if (removed > 0) log.info?.(`activity-log retention: pruned ${removed} stale file(s)`)
} catch (err) {
  log.warn?.(`activity-log prune failed (non-fatal): ${String(err)}`)
}

// ---------------------------------------------------------------------------
// Bridges between later-in-the-pipe factories and earlier-in-the-pipe ones.
// withRuntime publishes plugin metadata + the shutdown callable; downstream
// factories (dispatcher, hot-reload, signals, idle-quit) call into them
// through these refs so the pipe stays linear.
//
// The refs are an artifact of "the only way to express forward references in
// a synchronous pipe is a mutable slot." Once withRuntime + withDispatcher
// share a serializable bus (TEA-style effect sink), the refs collapse.
// ---------------------------------------------------------------------------

const refs = {
  activePluginNames: [] as string[],
  stopPlugins: () => {},
  shutdown: () => {},
}

// ---------------------------------------------------------------------------
// Resume the pipe — socket bind → idle-quit → dispatcher → hot-reload →
// signals → runtime. Each factory's prerequisites are enforced by the
// type system; reading top-down IS the boot order.
// ---------------------------------------------------------------------------

const withSocketShape = withSocketServer<typeof partialShape>()(partialShape)
const withIdleQuitShape = withIdleQuit<typeof withSocketShape>({
  triggerShutdown: () => refs.shutdown(),
})(withSocketShape)
const withDispatcherShape = withDispatcher<typeof withIdleQuitShape>({
  onActiveClient: () => withIdleQuitShape.idleQuit.markActive(),
  onIdle: () => withIdleQuitShape.idleQuit.markIdle(),
  getActivePluginNames: () => refs.activePluginNames,
  getQuitTimeoutSec: () => withSocketShape.config.quitTimeoutSec,
})(withIdleQuitShape)
// MCP-spec surface — reads the tool registry, registers initialize / tools/list
// / tools/call on the dispatcher. tools/call routes through the dispatcher's
// JSON-RPC handler when possible (preserves per-connection context wired up
// by withDispatcher), then falls back to the tool's registry handler.
const withMCPShape = withMCPServer<typeof withDispatcherShape>({
  metadata: TOOLS_LIST.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    // MCP outputSchema — paired with handler `structuredContent` emission.
    // Tools published before @km/infra/15623 lacked outputSchema; the
    // post-15623 TOOLS_LIST entries declare it for every tool.
    outputSchema: t.outputSchema,
  })),
  dispatch: async (toolName, args, ctx) => {
    // Route every registered tool through the dispatcher's handleRequest.
    // The dispatcher's tribe.* / recall cases own connection context; for
    // unknown methods it returns -32601 which we surface as an MCP error.
    if (!withDispatcherShape.tools.has(toolName)) return undefined
    const responseLine = await withDispatcherShape.dispatcher.handleRequest(
      { jsonrpc: "2.0", id: `mcp-${ctx.connId}-${Date.now()}`, method: toolName, params: args },
      ctx.connId,
    )
    const parsed = JSON.parse(responseLine.trimEnd()) as
      | { result: unknown; error?: undefined }
      | { error: { code: number; message: string }; result?: undefined }
    if ("error" in parsed && parsed.error) {
      const err = new Error(parsed.error.message) as Error & { code: number }
      err.code = parsed.error.code
      throw err
    }
    return parsed.result
  },
})(withDispatcherShape)
const withHotReloadShape = withHotReload<typeof withMCPShape>({
  stopPlugins: () => refs.stopPlugins(),
  triggerShutdown: () => refs.shutdown(),
})(withMCPShape)
// Confirm withMCPShape carries the MCP server handle (for tests / status).
log.debug?.(
  `MCP server ready: ${withMCPShape.mcpServer.toolNames.length} tools, protocol ${withMCPShape.mcpServer.protocolVersion}`,
)

const withSignalsShape = withSignals<typeof withHotReloadShape>({
  onShutdown: () => refs.shutdown(),
  onReload: () => withHotReloadShape.hotReload.reload(),
})(withHotReloadShape)
const tribe = withRuntime<typeof withSignalsShape>({
  plugins: process.env.TRIBE_NO_PLUGINS
    ? []
    : [gitPlugin, beadsPlugin, githubPlugin, healthMonitorPlugin, accountlyPlugin],
  publishActivePluginNames: (n) => {
    refs.activePluginNames = n
  },
  publishStopPlugins: (fn) => {
    refs.stopPlugins = fn
  },
  publishShutdown: (fn) => {
    refs.shutdown = fn
  },
})(withSignalsShape)

// Recall tools are conditional on recall being enabled — register them after the
// pipe so the registry stays append-only when --no-recall is set. The dispatcher
// reads the registry lazily, so late registration is safe.
if (tribe.recall) {
  for (const t of recallTools(tribe.recall)) tribe.tools.set(t.name, t)
}

log.info?.(`Starting tribe daemon`)
log.info?.(`Socket: ${tribe.config.socketPath}`)
log.info?.(`DB: ${tribe.config.dbPath}`)
log.info?.(`PID: ${process.pid}`)
if (tribe.recall) log.info?.(`Recall DB: ${tribe.config.recallDbPath}`)
log.info?.(`Daemon ready (pid=${process.pid}, clients=${tribe.registry.clients.size})`)

// ---------------------------------------------------------------------------
// Run loop — resolves when the daemon's scope aborts (shutdown / SIGTERM /
// SIGINT / hot-reload / idle-quit / fatal). Aligns with silvery's run(view, …)
// and the era2 lifecycle.
// ---------------------------------------------------------------------------

await tribe.run()
