/**
 * withHotReload — SIGHUP-driven re-exec that preserves the listening fd.
 *
 * Two pieces:
 *
 *   1. `reload()` — spawn(process.execPath, argv, { stdio: [..., fd] }) so the
 *      new process inherits the listening Unix socket. The old process exits
 *      after a short delay to let the child bind.
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
import { existsSync, readdirSync, readFileSync, watch, type FSWatcher } from "node:fs"
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

      const socketFd = (t.socket.server as unknown as { _handle?: { fd?: number } })._handle?.fd
      if (socketFd == null) {
        log.info?.("Cannot hot-reload: no socket fd available")
        return
      }

      const argv = process.argv.slice(1).filter((a) => !a.startsWith("--fd"))
      argv.push(`--fd=${socketFd}`)

      const child = spawn(process.execPath, argv, {
        stdio: ["ignore", "inherit", "inherit", socketFd],
        detached: false,
        env: process.env,
      })

      child.on("error", (err) => {
        log.info?.(`Hot-reload spawn failed: ${err.message}`)
      })

      // Give new process time to start, then exit. Use a raw setTimeout here —
      // we WANT this timer to fire even after `triggerShutdown()` is initiated
      // by something else, because the new process needs the old one out of
      // the way to take over the fd cleanly.
      const exitTimer = setTimeout(() => {
        log.info?.("Hot-reload: old process exiting, new process taking over")
        opts.triggerShutdown()
      }, spawnDelayMs) as unknown as { unref?: () => void }
      exitTimer.unref?.()
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
          watchers.push(
            watch(libTribeDir, { persistent: false }, (_event, filename) => onSourceChange(filename)),
          )
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
