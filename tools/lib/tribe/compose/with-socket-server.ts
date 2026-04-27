/**
 * withSocketServer — bind the Unix socket the daemon listens on.
 *
 * Two cases:
 *
 *   1. Hot-reload: `--fd N` inherits an already-bound listening fd from the
 *      previous process (`withHotReload` re-execs with the fd preserved).
 *
 *   2. Fresh start: bind + chmod 0600. The caller is responsible for any
 *      pre-bind alive-probe — `pipe(...)` is synchronous, so async work like
 *      probing a remote socket happens outside the pipe (see
 *      `probeAndCleanSocket()` exported below for the standard probe routine).
 *
 * The server is created but no `connection` handler is attached here — that
 * is `withDispatcher`'s job. Node `Server` accepts post-listen `.on("connection",
 * fn)` listeners; subsequent accepts fire the listener.
 *
 * Cleanup: server.close() + (when not inheriting) unlinkSync(socketPath)
 * registered on root scope.
 */

import { createConnection, createServer, type Server } from "node:net"
import { existsSync, unlinkSync, chmodSync } from "node:fs"
import { createLogger } from "loggily"
import type { BaseTribe } from "./base.ts"
import type { WithConfig } from "./with-config.ts"

const log = createLogger("tribe:socket")

export interface SocketServer {
  readonly server: Server
  readonly socketPath: string
  /** True when the server bound to an inherited fd (hot-reload re-exec). */
  readonly inheritedFd: boolean
  /** Wall-clock ms when bind completed — used for join-suppress window etc. */
  readonly startedAt: number
}

export interface WithSocketServer {
  readonly socket: SocketServer
}

/**
 * Probe an existing socket path. If a live daemon is listening, returns true
 * (caller should `process.exit(0)`). If the socket exists but is stale,
 * removes it and returns false. If the socket doesn't exist, returns false.
 *
 * Async — meant to run BEFORE the pipe call. See hub/composition.md
 * § "Async — outside the pipe".
 */
export async function probeAndCleanSocket(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) return false
  const alive = await new Promise<boolean>((resolvePromise) => {
    const probe = createConnection(socketPath)
    let settled = false
    const finish = (v: boolean): void => {
      if (settled) return
      settled = true
      try {
        probe.destroy()
      } catch {
        /* ignore */
      }
      resolvePromise(v)
    }
    probe.once("connect", () => finish(true))
    probe.once("error", () => finish(false))
    const t = setTimeout(() => finish(false), 500) as unknown as { unref?: () => void }
    t.unref?.()
  })
  if (alive) return true
  try {
    unlinkSync(socketPath)
  } catch {
    /* ignore */
  }
  return false
}

/**
 * withSocketServer — bind the Unix socket. Synchronous. The fresh-start path
 * assumes the caller has already invoked `probeAndCleanSocket(...)` to handle
 * stale-socket cleanup and another-daemon-running detection.
 */
export function withSocketServer<T extends BaseTribe & WithConfig>(): (t: T) => T & WithSocketServer {
  return (t) => {
    const socketPath = t.config.socketPath
    const inheritFd = t.config.inheritFd

    let server: Server
    let inheritedFd = false

    if (inheritFd !== null) {
      server = createServer()
      server.listen({ fd: inheritFd })
      inheritedFd = true
      log.info?.(`Inherited socket fd ${inheritFd} (hot-reload)`)
    } else {
      server = createServer()
      server.listen(socketPath, () => {
        try {
          chmodSync(socketPath, 0o600)
        } catch {
          /* not all platforms support it */
        }
      })
      log.info?.(`Listening on ${socketPath}`)
    }

    // Cleanup — close the server and (when not inheriting) unlink the socket
    // file. Hot-reload short-circuits server.close() by letting the new
    // process inherit the listening fd before this scope closes.
    t.scope.defer(() => {
      try {
        server.close()
      } catch {
        /* already closing */
      }
      if (!inheritedFd) {
        try {
          unlinkSync(socketPath)
        } catch {
          /* not present or no permission */
        }
      }
    })

    const socket: SocketServer = {
      server,
      socketPath,
      inheritedFd,
      startedAt: Date.now(),
    }
    return { ...t, socket }
  }
}
