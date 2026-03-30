/**
 * Tribe socket utilities — discovery, JSON-RPC protocol, daemon client.
 * Shared between daemon, proxy, and CLI.
 */

import { existsSync, unlinkSync, readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { createConnection, type Socket } from "node:net"
import { spawn } from "node:child_process"
import { findBeadsDir } from "./config.ts"

// ---------------------------------------------------------------------------
// Socket discovery
// ---------------------------------------------------------------------------

/** Resolve daemon socket path. Priority: flag > env > .beads/tribe.sock > per-user fallback */
export function resolveSocketPath(socketArg?: string): string {
  if (socketArg) return socketArg
  if (process.env.TRIBE_SOCKET) return process.env.TRIBE_SOCKET

  const beadsDir = findBeadsDir()
  if (beadsDir) return resolve(beadsDir, "tribe.sock")

  // Per-user fallback
  const xdg = process.env.XDG_RUNTIME_DIR
  if (xdg) return resolve(xdg, "tribe.sock")
  return `/tmp/tribe-${process.getuid?.() ?? process.pid}.sock`
}

/** Resolve PID file path (same directory as socket) */
export function resolvePidPath(socketPath: string): string {
  return resolve(dirname(socketPath), "tribe.pid")
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
        onMessage(JSON.parse(trimmed))
      } catch {
        process.stderr.write(`[tribe-socket] Invalid JSON: ${trimmed.slice(0, 100)}\n`)
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
        process.stderr.write(`[tribe-socket] Connection error: ${err.message}\n`)
        // Reject all pending calls
        for (const [, p] of pending) p.reject(err)
        pending.clear()
      })

      const client: DaemonClient = {
        call(method, params) {
          return new Promise((res, rej) => {
            const id = nextId++
            pending.set(id, { resolve: res, reject: rej })
            socket.write(makeRequest(id, method, params))
            // Timeout after 30s
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id)
                rej(new Error(`Request ${method} timed out`))
              }
            }, 30_000)
          })
        },
        notify(method, params) {
          socket.write(makeNotification(method, params))
        },
        onNotification(handler) {
          notificationHandlers.push(handler)
        },
        close() {
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
export async function connectOrStart(socketPath: string, daemonScript?: string): Promise<DaemonClient> {
  // Try connecting first
  try {
    return await connectToDaemon(socketPath)
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "ECONNREFUSED" && code !== "ENOENT") throw err
  }

  // Clean up stale socket file
  if (existsSync(socketPath)) {
    try { unlinkSync(socketPath) } catch { /* ignore */ }
  }

  // Start daemon
  const script = daemonScript ?? resolve(dirname(new URL(import.meta.url).pathname), "../../tribe-daemon.ts")
  const child = spawn(process.execPath, [script, "--socket", socketPath], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  })
  child.unref()

  // Wait for socket to appear with exponential backoff
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((r) => setTimeout(r, Math.min(100 * 2 ** attempt, 2000)))
    try {
      return await connectToDaemon(socketPath)
    } catch {
      // Keep trying
    }
  }

  throw new Error(`Failed to connect to tribe daemon at ${socketPath} after starting it`)
}

/** Read PID from PID file, or null */
export function readDaemonPid(socketPath: string): number | null {
  const pidPath = resolvePidPath(socketPath)
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10)
    if (isNaN(pid)) return null
    // Check if process is alive
    try { process.kill(pid, 0); return pid } catch { return null }
  } catch {
    return null
  }
}
