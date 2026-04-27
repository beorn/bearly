/**
 * withRuntime — the apply-and-emit loop. Owns plugin lifecycle, the
 * shutdown() entry point, the cleanup tick, and `tribe.run()`.
 *
 * The factory takes:
 *
 *   - `buildPluginApi(t)` — derive the TribeClientApi from the daemon value.
 *     The default api uses the daemon's daemonCtx + registry; tests may
 *     swap a stub.
 *   - `plugins` — observer plugins to load. Filtered by available(); each
 *     active plugin's stop() is collected and called on shutdown.
 *   - `cleanupIntervalMs` (default 6h) — how often `cleanupOldData` runs.
 *
 * Hooks that other phases need to call into the runtime:
 *
 *   - `publishActivePluginNames(names)` — let withDispatcher's cli_status see
 *     the loaded plugin names.
 *   - `publishStopPlugins(fn)` — let withHotReload's re-exec call stop() so
 *     plugin cursors flush.
 *   - `publishShutdown(fn)` — let withSignals + withIdleQuit + withHotReload
 *     trigger graceful shutdown.
 *
 * The `tribe.run()` method exposed in the value resolves when the daemon's
 * scope.signal aborts (shutdown / SIGINT / hot-reload / idle-quit / fatal).
 */

import { createLogger } from "loggily"
import { sendMessage } from "../messaging.ts"
import { cleanupOldData, backfillDefaultRoomMembers } from "../session.ts"
import { loadPlugins } from "../plugin-loader.ts"
import type { TribeClientApi, TribePluginApi } from "../plugin-api.ts"
import type { BaseTribe } from "./base.ts"
import type { WithBroadcast } from "./with-broadcast.ts"
import type { WithClientRegistry } from "./with-client-registry.ts"
import type { WithDaemonContext } from "./with-daemon-context.ts"
import type { WithDatabase } from "./with-database.ts"
import type { WithLore } from "./with-lore.ts"
import type { WithSocketServer } from "./with-socket-server.ts"

const log = createLogger("tribe:runtime")

type RuntimeShape = BaseTribe &
  WithDatabase &
  WithDaemonContext &
  WithLore &
  WithClientRegistry &
  WithBroadcast &
  WithSocketServer

export interface RuntimeOpts<T extends RuntimeShape> {
  /** Build the TribeClientApi the plugins see. Defaults to the canonical impl. */
  buildPluginApi?: (t: T) => TribeClientApi
  /** Plugins to load. Filtered by `available()`. */
  plugins: TribePluginApi[]
  /** Cleanup interval (data retention). Default 6h. */
  cleanupIntervalMs?: number
  /** Bridges to other factories — see file header. */
  publishActivePluginNames: (names: string[]) => void
  publishStopPlugins: (fn: () => void) => void
  publishShutdown: (fn: () => void) => void
}

export interface Runtime {
  /** Resolves when the daemon's scope aborts. */
  run(): Promise<void>
  /** Synchronous shutdown — closes plugins, aborts scope, exits. */
  shutdown(): void
}

export interface WithRuntime {
  readonly runtime: Runtime
  /** Re-exposes `tribe.run()` at the value level for ergonomics. */
  run(): Promise<void>
}

function defaultBuildPluginApi<T extends RuntimeShape>(t: T): TribeClientApi {
  const { stmts, daemonCtx, daemonSessionId, registry } = t
  const { clients } = registry
  return {
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
      const result = stmts.claimDedup.run({ $key: key, $session_id: daemonSessionId, $ts: Date.now() })
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
}

export function withRuntime<T extends RuntimeShape>(
  opts: RuntimeOpts<T>,
): (t: T) => T & WithRuntime {
  return (t) => {
    const buildPluginApi = opts.buildPluginApi ?? defaultBuildPluginApi
    const cleanupIntervalMs = opts.cleanupIntervalMs ?? 6 * 60 * 60 * 1000

    // Build the api the plugins see, then load.
    const tribeClientApi = buildPluginApi(t)
    const loadedPlugins = loadPlugins(opts.plugins, tribeClientApi)
    const activePluginNames = loadedPlugins.active.filter((p) => p.active).map((p) => p.name)
    const stopPlugins = loadedPlugins.stop

    opts.publishActivePluginNames(activePluginNames)
    opts.publishStopPlugins(stopPlugins)

    // Cleanup tick — registers on root scope so disposal stops it.
    const cleanupInterval = setInterval(
      () => cleanupOldData(t.daemonCtx),
      cleanupIntervalMs,
    ) as unknown as { unref?: () => void }
    cleanupInterval.unref?.()
    t.scope.defer(() => clearInterval(cleanupInterval as unknown as ReturnType<typeof setInterval>))
    cleanupOldData(t.daemonCtx)

    // Matrix-shape invariant (km-tribe.matrix-shape): every row in `sessions`
    // must have a corresponding row in `room_members` for its project's
    // default room. registerSession() satisfies the invariant for new sessions;
    // this backfill catches historic rows from before the invariant existed
    // (DBs that migrated through v10 but haven't yet seen a registerSession on
    // every row) and any code path that bypasses registerSession.
    const backfilled = backfillDefaultRoomMembers(t.daemonCtx)
    if (backfilled > 0) {
      log.info?.(`backfilled ${backfilled} room_members row(s) at startup`)
    }

    let exited = false
    function shutdown(): void {
      if (exited) return
      exited = true
      log.info?.("Shutting down...")
      stopPlugins()
      // Close lore explicitly for ordering (the scope.defer in withLore would
      // catch it too, but we want it before sockets so the focus poller and
      // summarizer don't keep writing as the db closes).
      void t.lore?.close()
      // Close all client sockets cleanly.
      for (const [, client] of t.registry.clients) {
        try {
          client.socket.end()
        } catch {
          /* ignore */
        }
      }
      t.registry.clients.clear()
      // Cascade everything else through scope.dispose. Server.close + socket
      // file unlink + db close + watcher close all live in scope-deferred
      // disposers registered by their factories.
      void t.scope[Symbol.asyncDispose]().catch(() => {})
      // Belt-and-braces: top-level exit. The dispose cascade is async; force
      // exit guarantees the process terminates even if a defer hangs.
      const exitTimer = setTimeout(() => process.exit(0), 250) as unknown as { unref?: () => void }
      exitTimer.unref?.()
    }

    opts.publishShutdown(shutdown)

    function run(): Promise<void> {
      return new Promise((resolve) => {
        if (t.scope.signal.aborted) {
          resolve()
          return
        }
        t.scope.signal.addEventListener("abort", () => resolve(), { once: true })
      })
    }

    return {
      ...t,
      runtime: { run, shutdown },
      run,
    }
  }
}
