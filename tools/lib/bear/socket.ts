/**
 * Bear socket utilities — JSON-RPC wire protocol + client with auto-start and
 * reconnection. Modeled on tools/lib/tribe/socket.ts (same wire format so a
 * future unified daemon can speak both dialects on one socket).
 *
 * No peer-to-peer sockets here — bear is a pure client/daemon model.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs"
import { createConnection, type Socket } from "node:net"
import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import { createLogger } from "loggily"
import { createTimers } from "../tribe/timers.ts"
import { resolveBearPidPath } from "./config.ts"

const log = createLogger("bear:socket")

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 types — re-exported from here for dependency locality
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

export function makeError(id: number | string, code: number, message: string, data?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, data } }) + "\n"
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
    buffer = lines.pop()!
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

export type BearClient = {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  notify(method: string, params?: Record<string, unknown>): void
  onNotification(handler: (method: string, params?: Record<string, unknown>) => void): void
  close(): void
  socket: Socket
}

export function connectToDaemon(socketPath: string, opts?: { callTimeoutMs?: number }): Promise<BearClient> {
  const callTimeoutMs = opts?.callTimeoutMs ?? 30_000
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
          if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, data: msg.error.data }))
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
      const client: BearClient = {
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

      resolve(client)
    })
  })
}

// ---------------------------------------------------------------------------
// Auto-start daemon
// ---------------------------------------------------------------------------

export type ConnectOrStartOpts = {
  daemonScript?: string
  dbPath?: string
  callTimeoutMs?: number
  /** If set, do not spawn a daemon when connection fails; throw instead. */
  noSpawn?: boolean
  maxStartupAttempts?: number
}

export async function connectOrStart(socketPath: string, opts?: ConnectOrStartOpts): Promise<BearClient> {
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

  const script = opts?.daemonScript ?? resolve(dirname(new URL(import.meta.url).pathname), "../../bear-daemon.ts")
  const daemonArgs = ["--socket", socketPath]
  if (opts?.dbPath) daemonArgs.push("--db", opts.dbPath)
  const child = spawn(process.execPath, [script, ...daemonArgs], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  })
  child.unref()

  const maxAttempts = opts?.maxStartupAttempts ?? 10
  // Use referenced setTimeouts here — if the CLI has no other handles, we
  // still need to block the event loop until the daemon is reachable.
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise<void>((r) => setTimeout(r, Math.min(100 * 2 ** attempt, 2000)))
    try {
      return await connectToDaemon(socketPath, { callTimeoutMs: opts?.callTimeoutMs })
    } catch {
      /* keep trying */
    }
  }
  throw new Error(`Failed to connect to bear daemon at ${socketPath} after starting it`)
}

// ---------------------------------------------------------------------------
// Reconnecting client
// ---------------------------------------------------------------------------

export type ReconnectingClientOpts = {
  socketPath: string
  onConnect?: (client: BearClient) => Promise<void>
  onDisconnect?: () => void
  onReconnect?: () => void
  maxAttempts?: number
  callTimeoutMs?: number
  dbPath?: string
}

export async function createReconnectingClient(opts: ReconnectingClientOpts): Promise<BearClient> {
  const { socketPath, onConnect, onDisconnect, onReconnect, maxAttempts = 30, callTimeoutMs, dbPath } = opts
  let current = await connectOrStart(socketPath, { callTimeoutMs, dbPath })
  if (onConnect) await onConnect(current)
  let closed = false
  let reconnectAc: AbortController | null = null
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
            return
          }
          if (closed) return
          try {
            current = await connectOrStart(socketPath, { callTimeoutMs, dbPath })
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
  }) as BearClient
}

// ---------------------------------------------------------------------------
// PID file
// ---------------------------------------------------------------------------

export function readBearDaemonPid(socketPath: string): number | null {
  try {
    const pid = parseInt(readFileSync(resolveBearPidPath(socketPath), "utf-8").trim(), 10)
    if (isNaN(pid)) return null
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}
