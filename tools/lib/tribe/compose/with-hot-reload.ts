/**
 * withHotReload — SIGHUP-driven re-exec for picking up new daemon code.
 *
 * Two pieces:
 *
 *   1. `reload()` — close + unlink the listening socket, then spawn a DETACHED
 *      replacement (`detached:true` + `unref()`, no `--fd`) that binds the
 *      freed socket path fresh. The old process exits after a short delay.
 *      The replacement survives the old process's exit. (Earlier versions
 *      passed the listening fd to the child for zero-gap handoff, but Bun's
 *      `node:net` cannot `listen({ fd })` — fd inheritance crash-looped the
 *      child. Close-then-fresh-bind costs a sub-second reconnect window but
 *      works under Bun.)
 *
 *   2. Source file watcher — fs.watch on the daemon's source directories;
 *      coalesced via debounce; emits SIGHUP to the current process on change.
 *      Skipped when `disableWatch: true` (tests) or `TRIBE_NO_AUTORELOAD=1`.
 *
 * The factory takes runtime callbacks the daemon supplies: `getStopPlugins()`
 * (called before spawn so plugin cursors flush), `triggerShutdown()` (called
 * after the spawn delay to release the old process). The withSignals factory
 * routes SIGHUP to `reload()`.
 */

import { spawn } from "node:child_process"
import { existsSync, readdirSync, readFileSync, unlinkSync, watch, type FSWatcher } from "node:fs"
import { createHash } from "node:crypto"
import { dirname as pathDirname, resolve as pathResolve } from "node:path"
import { createLogger } from "loggily"
import type { BaseTribe } from "./base.ts"
import type { WithSocketServer } from "./with-socket-server.ts"

const log = createLogger("tribe:hot-reload")

export interface HotReloadOpts {
  /** Called before re-exec so plugin state flushes to disk. */
  stopPlugins: () => void
  /** Called after the spawn delay to abort/exit the current process. */
  triggerShutdown: () => void
  /** Skip the source-watcher (tests + non-source bundles). */
  disableWatch?: boolean
  /** ms between debounced source-change → SIGHUP emit. Default 500. */
  watchDebounceMs?: number
  /** ms to give the new process before the old exits. Default 1000. */
  spawnDelayMs?: number
}

export interface HotReload {
  /** Trigger an immediate re-exec. The withSignals factory wires SIGHUP here. */
  reload(): void
  /** Active watchers — exposed so tests can await close(). */
  readonly watchers: ReadonlyArray<FSWatcher>
}

export interface WithHotReload {
  readonly hotReload: HotReload
}

function buildSourceFiles(sourceDir: string, libTribeDir: string): string[] {
  return [
    pathResolve(sourceDir, "tribe-daemon.ts"),
    pathResolve(sourceDir, "stdio-adapter.ts"),
    ...(() => {
      try {
        return readdirSync(libTribeDir)
          .filter((f) => f.endsWith(".ts"))
          .sort()
          .map((f) => pathResolve(libTribeDir, f))
      } catch {
        // silent-fallback-allow: unreadable plugin source dir just omits extra files from hot-reload hashing.
        return []
      }
    })(),
  ]
}

function computeSourceHash(files: string[]): string {
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

export function withHotReload<T extends BaseTribe & WithSocketServer>(
  opts: HotReloadOpts,
): (t: T) => T & WithHotReload {
  return (t) => {
    const spawnDelayMs = opts.spawnDelayMs ?? 1000
    const watchDebounceMs = opts.watchDebounceMs ?? 500

    function reload(): void {
      log.info?.("SIGHUP received — re-exec for hot-reload")
      // Stop plugins BEFORE spawning so cursor/state flushes to disk
      // (prevents duplicate event delivery in the new process).
      opts.stopPlugins()

      // Re-exec strategy: close-then-spawn-detached-fresh.
      //
      // The previous strategy passed the listening socket fd to the child
      // (`--fd=N` + `stdio[3]=fd`) so it could inherit the bound socket. That
      // only works under Node — Bun's `node:net` throws "Bun does not support
      // listening on a file descriptor" on `server.listen({ fd })`. Under Bun
      // the child crash-looped on startup, the old daemon exited anyway, and
      // every session saw "No daemon running" (reproduced 2026-05-21 via the
      // `tribe.reload` MCP tool, which routes here through SIGHUP).
      //
      // Instead: the OLD daemon closes + unlinks the socket, then spawns the
      // replacement DETACHED (its own session via `detached:true` + `unref()`,
      // so it survives this process's exit) with a FRESH bind — no `--fd`.
      // The child binds the now-free socket path. There is a sub-second
      // window with no listener; adapters reconnect transparently via
      // `createReconnectingClient`'s backoff. Crucially the daemon SURVIVES
      // a reload — `detached` severs it from the dying parent's lifecycle.
      // Mark the socket as handed off BEFORE closing so the scope-cleanup
      // defer in withSocketServer skips its own unlink (it would otherwise
      // race the replacement daemon's fresh bind).
      t.socket.handedOff = true
      try {
        t.socket.server.close()
      } catch {
        /* already closing */
      }
      try {
        if (existsSync(t.socket.socketPath)) unlinkSync(t.socket.socketPath)
      } catch {
        /* not present or no permission */
      }

      const argv = process.argv.slice(1).filter((a) => !a.startsWith("--fd"))

      const child = spawn(process.execPath, argv, {
        stdio: "ignore",
        detached: true,
        env: process.env,
      })
      child.unref()

      child.on("error", (err) => {
        log.info?.(`Hot-reload spawn failed: ${err.message}`)
      })

      // Give new process time to start, then exit. Use a raw setTimeout here —
      // we WANT this timer to fire even after `triggerShutdown()` is initiated
      // by something else, because the new process needs the old one out of
      // the way to take over the fd cleanly. Do NOT unref — if every other
      // handle is also unref'd or the loop is sync-starved, the donor stays
      // alive serving its now-dead state. See @km/bearly/hot-reload-zombie-
      // exit-not-forced for the zombie-daemon incident.
      setTimeout(() => {
        log.info?.("Hot-reload: old process exiting, new process taking over")
        opts.triggerShutdown()
      }, spawnDelayMs)

      // Belt-and-braces nuke: if triggerShutdown + withRuntime's force-exit
      // hammer somehow still don't terminate this process — say a sync-heavy
      // plugin starves both timers' callbacks — SIGKILL self at
      // spawnDelayMs + 1500ms. Synchronous, kernel-enforced, can't be
      // starved. This is the last line of defense; previous fixes (dropping
      // .unref() on both timers) should make it unreachable in practice,
      // but the historical zombie-daemon incident proved we need the hammer.
      setTimeout(() => {
        log.info?.("Hot-reload: belt-and-braces SIGKILL — clean shutdown did not terminate process")
        try {
          process.kill(process.pid, "SIGKILL")
        } catch {
          /* even the kill failed; nothing left to try */
        }
      }, spawnDelayMs + 1500)
    }

    // Source-file watcher — auto-SIGHUP on code changes.
    const watchers: FSWatcher[] = []
    if (!opts.disableWatch && !process.env.TRIBE_NO_AUTORELOAD) {
      const sourceDir = pathDirname(new URL(import.meta.url).pathname)
      // Resolve relative to the actual tribe-daemon location (one level up
      // from this compose/ dir; lib/tribe sits next to it).
      const toolsDir = pathResolve(sourceDir, "../../../")
      const libTribeDir = pathResolve(sourceDir, "../")
      const sourceFiles = buildSourceFiles(toolsDir, libTribeDir)

      let sourceHash = computeSourceHash(sourceFiles)
      let reloadDebounce: ReturnType<typeof setTimeout> | null = null

      const onSourceChange = (filename: string | null): void => {
        if (filename && !filename.endsWith(".ts")) return
        if (reloadDebounce) clearTimeout(reloadDebounce)
        reloadDebounce = setTimeout(() => {
          const newHash = computeSourceHash(sourceFiles)
          if (newHash === sourceHash) return // No actual change
          log.info?.(`Source changed (${sourceHash} → ${newHash}), triggering hot-reload`)
          sourceHash = newHash
          process.emit("SIGHUP")
        }, watchDebounceMs)
      }

      try {
        watchers.push(watch(toolsDir, { persistent: false }, (_event, filename) => onSourceChange(filename)))
      } catch {
        /* dir not present in compiled bundle */
      }
      if (existsSync(libTribeDir)) {
        try {
          watchers.push(watch(libTribeDir, { persistent: false }, (_event, filename) => onSourceChange(filename)))
        } catch {
          /* permission denied or similar */
        }
      }

      log.info?.(`Watching source files for auto-reload`)

      t.scope.defer(() => {
        if (reloadDebounce) clearTimeout(reloadDebounce)
        for (const w of watchers) {
          try {
            w.close()
          } catch {
            /* already closed */
          }
        }
      })
    }

    return {
      ...t,
      hotReload: { reload, watchers },
    }
  }
}
