/**
 * Tribe socket utilities — discovery, JSON-RPC protocol, daemon client.
 * Shared between daemon, proxy, and CLI.
 */

import { existsSync, mkdirSync, unlinkSync, readFileSync } from "node:fs"
import { resolve, dirname, basename } from "node:path"
import { createConnection, type Socket } from "node:net"
import { spawn } from "node:child_process"
import { createLogger } from "loggily"
import { findBeadsDir } from "./config.ts"
import { createTimers } from "./timers.ts"

const log = createLogger("tribe:socket")

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

export const TRIBE_PROTOCOL_VERSION = 2

// ---------------------------------------------------------------------------
// Socket discovery
// ---------------------------------------------------------------------------

/** Resolve daemon socket path. Priority: flag > env > user-level (default) */
export function resolveSocketPath(socketArg?: string): string {
  if (socketArg) return socketArg
  if (process.env.TRIBE_SOCKET) return process.env.TRIBE_SOCKET

  // Always use user-level daemon socket (one daemon per user)
  const xdg = process.env.XDG_RUNTIME_DIR
  return xdg ? resolve(xdg, "tribe.sock") : resolve(process.env.HOME ?? "/tmp", ".local/share/tribe/tribe.sock")
}

/** Resolve PID file path (derived from socket path — each socket gets its own PID file) */
export function resolvePidPath(socketPath: string): string {
  const base = basename(socketPath).replace(/\.sock$/, "")
  return resolve(dirname(socketPath), `${base}.pid`)
}

/** Resolve peer socket path for direct proxy-to-proxy connections */
export function resolvePeerSocketPath(sessionId: string): string {
  const xdg = process.env.XDG_RUNTIME_DIR
  const dir = xdg ?? resolve(process.env.HOME ?? "/tmp", ".local/share/tribe")
  return resolve(dir, `s-${sessionId.slice(0, 12)}.sock`)
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 types
// ---------------------------------------------------------------------------

export type JsonRpcRequest = {
  jsonrpc: "2.0"
  id: number | string
  method: string
  params?: Record<string, unknown>
}

export type JsonRpcResponse = {
  jsonrpc: "2.0"
  id: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type JsonRpcNotification = {
  jsonrpc: "2.0"
  method: string
  params?: Record<string, unknown>
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "method" in msg && "id" in msg
}

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "id" in msg && !("method" in msg)
}

export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return "method" in msg && !("id" in msg)
}

export function makeRequest(id: number, method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
}

export function makeResponse(id: number | string, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"
}

export function makeError(id: number | string, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"
}

export function makeNotification(method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"
}

// ---------------------------------------------------------------------------
// Line-delimited JSON parser
// ---------------------------------------------------------------------------

export function createLineParser(onMessage: (msg: JsonRpcMessage) => void): (chunk: Buffer) => void {
  let buffer = ""
  return (chunk: Buffer) => {
    buffer += chunk.toString()
    const lines = buffer.split("\n")
    buffer = lines.pop()! // Keep incomplete line in buffer
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        onMessage(JSON.parse(trimmed) as JsonRpcMessage)
      } catch {
        log.warn?.(`Invalid JSON: ${trimmed.slice(0, 100)}`)
      }
    }
  }
}

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

export function connectToDaemon(socketPath: string): Promise<DaemonClient> {
  return new Promise((resolve, reject) => {
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
          if (msg.error) p.reject(new Error(msg.error.message))
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
        // Reject all pending calls
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
            }, 10_000)
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
          // Reject all pending calls so nothing hangs
          for (const [, p] of pending) p.reject(new Error("Connection closed"))
          pending.clear()
          ac.abort()
          socket.end()
        },
        socket,
      }

      resolve(client)
    })
  })
}

// ---------------------------------------------------------------------------
// Auto-start daemon
// ---------------------------------------------------------------------------

/** Try connecting; if daemon not running, start it and retry */
export async function connectOrStart(
  socketPath: string,
  opts?: { daemonScript?: string; dbPath?: string },
): Promise<DaemonClient> {
  // Try connecting first
  try {
    return await connectToDaemon(socketPath)
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "ECONNREFUSED" && code !== "ENOENT") throw err
  }

  // Clean up stale socket file
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath)
    } catch {
      /* ignore */
    }
  }

  // Ensure socket directory exists
  const socketDir = dirname(socketPath)
  if (!existsSync(socketDir)) mkdirSync(socketDir, { recursive: true })

  // Start daemon
  const script = opts?.daemonScript ?? resolve(dirname(new URL(import.meta.url).pathname), "../../tribe-daemon.ts")
  const daemonArgs = ["--socket", socketPath]
  if (opts?.dbPath) daemonArgs.push("--db", opts.dbPath)
  const child = spawn(process.execPath, [script, ...daemonArgs], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  })
  child.unref()

  // Wait for socket to appear with exponential backoff
  const startupAc = new AbortController()
  const startupTimers = createTimers(startupAc.signal)
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      await startupTimers.delay(Math.min(100 * 2 ** attempt, 2000))
      try {
        return await connectToDaemon(socketPath)
      } catch {
        // Keep trying
      }
    }
  } finally {
    startupAc.abort()
  }

  throw new Error(`Failed to connect to tribe daemon at ${socketPath} after starting it`)
}

// ---------------------------------------------------------------------------
// Reconnecting client
// ---------------------------------------------------------------------------

export type ReconnectingClientOpts = {
  socketPath: string
  /** Called after each successful (re)connect — use for register/subscribe */
  onConnect: (client: DaemonClient) => Promise<void>
  /** Called on disconnect (before reconnect attempt) */
  onDisconnect?: () => void
  /** Called on successful reconnect */
  onReconnect?: () => void
  /** Max reconnect attempts (default: 30) */
  maxAttempts?: number
}

/**
 * Create a client that auto-reconnects on disconnect.
 * Wraps connectOrStart + register/subscribe in a single reusable pattern.
 */
export async function createReconnectingClient(opts: ReconnectingClientOpts): Promise<DaemonClient> {
  const { socketPath, onConnect, onDisconnect, onReconnect, maxAttempts = 30 } = opts
  let current = await connectOrStart(socketPath)
  await onConnect(current)
  let closed = false
  let reconnectAc: AbortController | null = null
  // Persistent notification handlers — replayed onto each new connection
  const notificationHandlers: Array<(method: string, params?: Record<string, unknown>) => void> = []

  const setupReconnect = () => {
    current.socket.on("close", () => {
      if (closed) return
      onDisconnect?.()
      // Abort any prior reconnect attempt
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
            current = await connectOrStart(socketPath)
            await onConnect(current)
            // Replay notification handlers onto new connection
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

  // Return a proxy that always delegates to the current client
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

/** Read PID from PID file, or null if missing/dead */
export function readDaemonPid(socketPath: string): number | null {
  try {
    const pid = parseInt(readFileSync(resolvePidPath(socketPath), "utf-8").trim(), 10)
    if (isNaN(pid)) return null
    process.kill(pid, 0) // Throws if dead
    return pid
  } catch {
    return null
  }
}
