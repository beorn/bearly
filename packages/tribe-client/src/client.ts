/**
 * Daemon client — connect to a Unix-socket JSON-RPC daemon, send requests
 * and notifications, receive responses and pushed notifications.
 *
 * Three layers, lowest to highest:
 *
 *  1. `connectToDaemon(socketPath, opts?)` — plain connect; rejects on
 *     ECONNREFUSED / ENOENT. Per-call timeout configurable.
 *  2. `connectOrStart(socketPath, opts)` — connect; if no daemon, spawn the
 *     supplied `daemonScript` as a detached child and retry with
 *     exponential backoff.
 *  3. `createReconnectingClient(opts)` — proxy that wraps a current client
 *     and transparently reconnects (via connectOrStart) on socket close,
 *     replaying registered notification handlers.
 */

import { existsSync, mkdirSync, unlinkSync } from "node:fs"
import { createConnection, type Socket } from "node:net"
import { spawn } from "node:child_process"
import { dirname } from "node:path"
import { createLogger } from "loggily"
import { createLineParser } from "./parser.ts"
import { isNotification, isResponse, makeNotification, makeRequest } from "./rpc.ts"
import { createTimers } from "./timers.ts"

const log = createLogger("tribe-client:client")

// ---------------------------------------------------------------------------
// Daemon client
// ---------------------------------------------------------------------------

export type DaemonClient = {
  /** Send a JSON-RPC request and wait for response */
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  /** Send a notification (no response expected) */
  notify(method: string, params?: Record<string, unknown>): void
  /** Register a handler for server-pushed notifications */
  onNotification(handler: (method: string, params?: Record<string, unknown>) => void): void
  /** Close the connection */
  close(): void
  /** The raw socket */
  socket: Socket
}

export type ConnectToDaemonOpts = {
  /** Per-call request timeout. Default: 10000 ms. */
  callTimeoutMs?: number
}

export function connectToDaemon(socketPath: string, opts?: ConnectToDaemonOpts): Promise<DaemonClient> {
  const callTimeoutMs = opts?.callTimeoutMs ?? 10_000
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(socketPath)
    const pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
    const notificationHandlers: Array<(method: string, params?: Record<string, unknown>) => void> = []
    let nextId = 1

    const ac = new AbortController()
    const timers = createTimers(ac.signal)

    const parse = createLineParser((msg) => {
      if (isResponse(msg)) {
        const p = pending.get(msg.id)
        if (p) {
          pending.delete(msg.id)
          if (msg.error)
            p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, data: msg.error.data }))
          else p.resolve(msg.result)
        }
      } else if (isNotification(msg)) {
        for (const h of notificationHandlers) h(msg.method, msg.params)
      }
    })

    socket.on("data", parse)
    socket.on("error", reject)
    socket.once("connect", () => {
      socket.removeListener("error", reject)
      socket.on("error", (err) => {
        log.error?.(`Connection error: ${err.message}`)
        for (const [, p] of pending) p.reject(err)
        pending.clear()
      })

      let timeouts = 0
      const client: DaemonClient = {
        call(method, params) {
          return new Promise((res, rej) => {
            const id = nextId++
            pending.set(id, { resolve: res, reject: rej })
            socket.write(makeRequest(id, method, params))
            timers.setTimeout(() => {
              if (!pending.delete(id)) return
              rej(new Error(`Request ${method} timed out`))
              if (++timeouts >= 3) {
                log.warn?.(`${timeouts} consecutive timeouts, destroying connection`)
                socket.destroy()
              }
            }, callTimeoutMs)
          }).then((v) => {
            timeouts = 0
            return v
          })
        },
        notify(method, params) {
          socket.write(makeNotification(method, params))
        },
        onNotification(handler) {
          notificationHandlers.push(handler)
        },
        close() {
          for (const [, p] of pending) p.reject(new Error("Connection closed"))
          pending.clear()
          ac.abort()
          socket.end()
        },
        socket,
      }

      resolvePromise(client)
    })
  })
}

// ---------------------------------------------------------------------------
// Auto-start daemon
// ---------------------------------------------------------------------------

export type ConnectOrStartOpts = {
  /** Path to the daemon entry script (required to spawn). */
  daemonScript?: string
  /** Extra args appended after `--socket <socketPath>` when spawning. */
  daemonArgs?: string[]
  /** Per-call request timeout once connected. */
  callTimeoutMs?: number
  /** If set, do not spawn a daemon when connection fails; throw instead. */
  noSpawn?: boolean
  /** Max reconnect attempts after spawning. Default 10. */
  maxStartupAttempts?: number
}

export async function connectOrStart(socketPath: string, opts?: ConnectOrStartOpts): Promise<DaemonClient> {
  try {
    return await connectToDaemon(socketPath, { callTimeoutMs: opts?.callTimeoutMs })
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "ECONNREFUSED" && code !== "ENOENT") throw err
    if (opts?.noSpawn) throw err
  }

  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath)
    } catch {
      /* ignore */
    }
  }

  const socketDir = dirname(socketPath)
  if (!existsSync(socketDir)) mkdirSync(socketDir, { recursive: true })

  const script = opts?.daemonScript
  if (!script) {
    throw new Error(`connectOrStart: no daemon at ${socketPath} and no daemonScript provided to spawn one`)
  }

  const args = ["--socket", socketPath, ...(opts?.daemonArgs ?? [])]
  const child = spawn(process.execPath, [script, ...args], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  })
  child.unref()

  const maxAttempts = opts?.maxStartupAttempts ?? 10
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise<void>((r) => setTimeout(r, Math.min(100 * 2 ** attempt, 2000)))
    try {
      return await connectToDaemon(socketPath, { callTimeoutMs: opts?.callTimeoutMs })
    } catch {
      /* keep trying */
    }
  }

  throw new Error(`Failed to connect to daemon at ${socketPath} after starting it`)
}

// ---------------------------------------------------------------------------
// Reconnecting client
// ---------------------------------------------------------------------------

export type ReconnectingClientOpts = {
  socketPath: string
  /** Called after each successful (re)connect — use for register/subscribe */
  onConnect?: (client: DaemonClient) => Promise<void>
  /** Called on disconnect (before reconnect attempt) */
  onDisconnect?: () => void
  /** Called on successful reconnect */
  onReconnect?: () => void
  /** Max reconnect attempts (default: 30) */
  maxAttempts?: number
  /** Forwarded to connectOrStart on each (re)connect */
  callTimeoutMs?: number
  daemonScript?: string
  daemonArgs?: string[]
  maxStartupAttempts?: number
}

/**
 * Create a client that auto-reconnects on disconnect.
 * Wraps connectOrStart + register/subscribe in a single reusable pattern.
 *
 * Notification handlers registered via `client.onNotification(handler)` are
 * persistent — they're replayed on every successful reconnect, so callers
 * never need to re-subscribe.
 */
export async function createReconnectingClient(opts: ReconnectingClientOpts): Promise<DaemonClient> {
  const {
    socketPath,
    onConnect,
    onDisconnect,
    onReconnect,
    maxAttempts = 30,
    callTimeoutMs,
    daemonScript,
    daemonArgs,
    maxStartupAttempts,
  } = opts
  const startOpts: ConnectOrStartOpts = { callTimeoutMs, daemonScript, daemonArgs, maxStartupAttempts }
  let current = await connectOrStart(socketPath, startOpts)
  if (onConnect) await onConnect(current)
  let closed = false
  let reconnectAc: AbortController | null = null
  // Persistent notification handlers — replayed onto each new connection
  const notificationHandlers: Array<(method: string, params?: Record<string, unknown>) => void> = []

  const setupReconnect = () => {
    current.socket.on("close", () => {
      if (closed) return
      onDisconnect?.()
      reconnectAc?.abort()
      reconnectAc = new AbortController()
      const timers = createTimers(reconnectAc.signal)
      void (async () => {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (closed) return
          const ms = Math.min(500 * 2 ** attempt, 10_000)
          try {
            await timers.delay(ms)
          } catch {
            return // Aborted (closed or new reconnect superseded)
          }
          if (closed) return
          try {
            current = await connectOrStart(socketPath, startOpts)
            if (onConnect) await onConnect(current)
            for (const h of notificationHandlers) current.onNotification(h)
            setupReconnect()
            onReconnect?.()
            return
          } catch {
            log.debug?.(`Reconnect attempt ${attempt + 1} failed`)
          }
        }
        log.error?.(`Failed to reconnect after ${maxAttempts} attempts`)
      })()
    })
  }
  setupReconnect()

  return new Proxy(current, {
    get(_, prop) {
      if (prop === "close")
        return () => {
          closed = true
          reconnectAc?.abort()
          current.close()
          current.socket.unref()
        }
      if (prop === "onNotification")
        return (handler: (method: string, params?: Record<string, unknown>) => void) => {
          notificationHandlers.push(handler)
          current.onNotification(handler)
        }
      return (current as Record<string | symbol, unknown>)[prop]
    },
  }) as DaemonClient
}

// ---------------------------------------------------------------------------
// Liveness probes
// ---------------------------------------------------------------------------

/** True iff the socket accepts a TCP-style connection. */
export function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection(socketPath)
    let settled = false
    const done = (alive: boolean) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
      resolvePromise(alive)
    }
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
  })
}
