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
import { pipe, withTool, withTools, createScope } from "@bearly/daemon-spine"
import { gitPlugin } from "./lib/tribe/git-plugin.ts"
import { beadsPlugin } from "./lib/tribe/beads-plugin.ts"
import { githubPlugin } from "./lib/tribe/github-plugin.ts"
import { healthMonitorPlugin } from "./lib/tribe/health-monitor-plugin.ts"
import { accountlyPlugin } from "./lib/tribe/accountly-plugin.ts"
import { doltReaperPlugin } from "./lib/tribe/dolt-reaper-plugin.ts"
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
  withIdleQuit,
  withLore,
  withProjectRoot,
  withRuntime,
  withSignals,
  withSocketServer,
} from "./lib/tribe/compose/index.ts"

const log = createLogger("tribe:daemon")

// ---------------------------------------------------------------------------
// Sync portion of the pipe — config, db, daemonCtx, lore, tools, registry,
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
  withLore(),
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
const withHotReloadShape = withHotReload<typeof withDispatcherShape>({
  stopPlugins: () => refs.stopPlugins(),
  triggerShutdown: () => refs.shutdown(),
})(withDispatcherShape)
const withSignalsShape = withSignals<typeof withHotReloadShape>({
  onShutdown: () => refs.shutdown(),
  onReload: () => withHotReloadShape.hotReload.reload(),
})(withHotReloadShape)
const tribe = withRuntime<typeof withSignalsShape>({
  plugins: process.env.TRIBE_NO_PLUGINS
    ? []
    : [gitPlugin, beadsPlugin, githubPlugin, healthMonitorPlugin, accountlyPlugin, doltReaperPlugin],
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

// Lore tools are conditional on lore being enabled — register them after the
// pipe so the registry stays append-only when --no-lore is set. The dispatcher
// reads the registry lazily, so late registration is safe.
if (tribe.lore) {
  for (const t of loreTools(tribe.lore)) tribe.tools.set(t.name, t)
}

log.info?.(`Starting tribe daemon`)
log.info?.(`Socket: ${tribe.config.socketPath}`)
log.info?.(`DB: ${tribe.config.dbPath}`)
log.info?.(`PID: ${process.pid}`)
if (tribe.lore) log.info?.(`Lore DB: ${tribe.config.loreDbPath}`)
log.info?.(`Daemon ready (pid=${process.pid}, clients=${tribe.registry.clients.size})`)

// ---------------------------------------------------------------------------
// Run loop — resolves when the daemon's scope aborts (shutdown / SIGTERM /
// SIGINT / hot-reload / idle-quit / fatal). Aligns with silvery's run(view, …)
// and the era2 lifecycle.
// ---------------------------------------------------------------------------

await tribe.run()
