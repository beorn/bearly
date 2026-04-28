/**
 * Tests for createMcpPlugin — the post-elegance-review spec.
 *
 * Settled API (km-silvercode.mcp-as-tribe-plugin, /pro round 2 elegance):
 *   - createMcpPlugin({ idleTimeoutMs?, maxLifetimeMs?, onShutdown?, ... })
 *   - Two numbers, two event-driven setTimeout calls.
 *   - SSE connect/disconnect drives connectionCount; count→0 arms idle timer.
 *   - maxLifetimeMs fires at startup regardless of activity.
 *   - Stable Unix socket, 0600, bind-before-publish.
 *   - No DSL, no slow-tick poll, no EventEmitter, no pidfile, no handshake.
 *
 * Required tests (team-lead spec):
 *   (a) idleTimeoutMs fires after no activity
 *   (b) maxLifetimeMs fires regardless of activity
 *   (c) socket mode is 0600 and bound before published
 *   (d) factory returns a clean disposable (TribePluginApi shape, stop()
 *       releases all resources)
 *
 * Plus wire conformance: SDK Client → tools/list → []
 */

import { describe, it, expect } from "vitest"
import { mkdtempSync, statSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { request as httpRequest, type IncomingMessage } from "node:http"
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createMcpPlugin } from "../mcp-plugin.ts"
import type { TribeClientApi } from "../../../tools/lib/tribe/plugin-api.ts"

// Stub TribeClientApi — the plugin doesn't talk to the tribe wire.
const noopApi: TribeClientApi = {
  send: () => {},
  broadcast: () => {},
  claimDedup: () => true,
  hasRecentMessage: () => false,
  getActiveSessions: () => [],
  getSessionNames: () => [],
  hasChief: () => false,
}

/** Allocate a per-test socket path. Tmpdir keeps macOS's 104-byte path limit safe. */
function makeSocketPath(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "mcp-test-"))
  return resolve(dir, "m.sock")
}

/**
 * Open a long-running streaming HTTP GET against `/healthz?stream=<ms>` and
 * hold it open until the caller invokes `close()`. Used to take and drop the
 * lease deterministically — the SSE response IS the lease in production.
 */
function holdStreamingRequest(socketPath: string): Promise<{ close: () => void }> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      {
        socketPath,
        method: "GET",
        path: "/healthz?stream=60000",
        agent: false,
      },
      (res: IncomingMessage) => {
        res.on("data", () => {
          /* discard */
        })
        res.on("error", () => {
          /* swallow — close path handles teardown */
        })
        resolvePromise({
          close: () => {
            try {
              req.destroy()
            } catch {
              /* already gone */
            }
          },
        })
      },
    )
    req.once("error", reject)
    req.end()
  })
}

/** Fetch shim that routes requests over a Unix socket — for the SDK Client. */
type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>

function makeUnixFetch(socketPath: string): FetchLike {
  return async (input, init) => {
    const url = typeof input === "string" ? new URL(input) : input
    const path = url.pathname + url.search
    const method = init?.method ?? "GET"
    const bodyRaw = init?.body
    const bodyBuf =
      typeof bodyRaw === "string"
        ? Buffer.from(bodyRaw, "utf8")
        : bodyRaw instanceof Uint8Array
          ? Buffer.from(bodyRaw)
          : undefined

    const headers: Record<string, string> = {}
    if (init?.headers) {
      const h = new Headers(init.headers)
      h.forEach((v, k) => {
        headers[k] = v
      })
    }
    if (bodyBuf !== undefined) headers["content-length"] = String(bodyBuf.length)

    return new Promise((resolvePromise, reject) => {
      const req = httpRequest({ socketPath, path, method, headers, agent: false }, (res: IncomingMessage) => {
        const respHeaders = new Headers()
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) for (const vv of v) respHeaders.append(k, vv)
          else if (typeof v === "string") respHeaders.set(k, v)
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            res.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
            res.on("end", () => controller.close())
            res.on("error", (err) => controller.error(err))
          },
          cancel() {
            res.destroy()
            req.destroy()
          },
        })
        resolvePromise(new Response(body, { status: res.statusCode ?? 0, headers: respHeaders }))
      })
      req.on("error", reject)
      const sig = init?.signal
      if (sig) {
        if (sig.aborted) req.destroy()
        else sig.addEventListener("abort", () => req.destroy(), { once: true })
      }
      if (bodyBuf !== undefined) req.write(bodyBuf)
      req.end()
    })
  }
}

async function until(pred: () => boolean, timeoutMs = 1_000, stepMs = 10): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting after ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

describe("createMcpPlugin (post-elegance-review spec)", () => {
  // (a) idleTimeoutMs fires after no activity
  it("idleTimeoutMs fires shutdown when connection count drops to zero and stays there", async () => {
    const shutdowns: string[] = []
    const socketPath = makeSocketPath()
    const plugin = createMcpPlugin({
      socketPath,
      idleTimeoutMs: 80, // tiny window
      maxLifetimeMs: 60_000, // big enough that lifetime can't fire first
      onShutdown: (reason) => shutdowns.push(reason),
    })
    const stop = plugin.start(noopApi) ?? (() => {})
    try {
      await until(() => plugin.getAddress() !== null)

      // Take the lease so idle timer is held off.
      const conn = await holdStreamingRequest(socketPath)
      await until(() => plugin.getConnectionCount() >= 1)
      // Past the idle window with the lease held → no shutdown yet.
      await new Promise((r) => setTimeout(r, 150))
      expect(shutdowns).toHaveLength(0)

      // Drop the lease → idle timer arms → fires after idleTimeoutMs.
      conn.close()
      await until(() => plugin.getConnectionCount() === 0)
      await until(() => shutdowns.length > 0, 1_000)
      expect(shutdowns[0]).toBe("idle")
    } finally {
      stop()
    }
  })

  // (b) maxLifetimeMs fires regardless of activity
  it("maxLifetimeMs fires shutdown even while connections are held", async () => {
    const shutdowns: string[] = []
    const socketPath = makeSocketPath()
    const plugin = createMcpPlugin({
      socketPath,
      idleTimeoutMs: 60_000, // big — wouldn't fire in this test
      maxLifetimeMs: 100, // tiny lifetime — must fire
      onShutdown: (reason) => shutdowns.push(reason),
    })
    const stop = plugin.start(noopApi) ?? (() => {})
    try {
      await until(() => plugin.getAddress() !== null)

      // Hold an active connection — proves lifetime fires regardless.
      const conn = await holdStreamingRequest(socketPath)
      await until(() => plugin.getConnectionCount() >= 1)
      try {
        await until(() => shutdowns.length > 0, 1_000)
        expect(shutdowns[0]).toBe("max-lifetime")
      } finally {
        conn.close()
      }
    } finally {
      stop()
    }
  })

  // (c) socket mode 0600 and bound before published
  it("publishes the socket at mode 0600 — bind-before-publish path", async () => {
    const socketPath = makeSocketPath()
    const plugin = createMcpPlugin({
      socketPath,
      idleTimeoutMs: 60_000,
      maxLifetimeMs: 60_000,
    })
    const stop = plugin.start(noopApi) ?? (() => {})
    try {
      await until(() => plugin.getAddress() !== null)
      // Socket file exists at the published path with 0600 mode.
      expect(existsSync(socketPath)).toBe(true)
      const mode = statSync(socketPath).mode & 0o777
      expect(mode).toBe(0o600)

      // No leftover temp .tmp.sock files in the directory — rename completed.
      const dir = resolve(socketPath, "..")
      const tempLeftover = readdirSync(dir).filter((f) => f.endsWith(".tmp.sock"))
      expect(tempLeftover).toEqual([])
    } finally {
      stop()
    }
  })

  // (d) factory returns a clean disposable
  it("returns a TribePluginApi-shaped handle whose stop() releases all resources", async () => {
    const socketPath = makeSocketPath()
    const plugin = createMcpPlugin({
      socketPath,
      idleTimeoutMs: 60_000,
      maxLifetimeMs: 60_000,
    })
    // Plugin shape conforms to TribePluginApi.
    expect(plugin.name).toBe("mcp")
    expect(typeof plugin.available).toBe("function")
    expect(typeof plugin.start).toBe("function")
    expect(plugin.available()).toBe(true)
    // Pre-start observability — no address yet.
    expect(plugin.getAddress()).toBeNull()
    expect(plugin.getConnectionCount()).toBe(0)

    const stop = plugin.start(noopApi)
    expect(typeof stop).toBe("function")
    try {
      await until(() => plugin.getAddress() !== null)
      expect(existsSync(socketPath)).toBe(true)
    } finally {
      stop?.()
    }
    // After stop(): socket file unlinked, address cleared, connection count zero.
    expect(existsSync(socketPath)).toBe(false)
    expect(plugin.getAddress()).toBeNull()
    expect(plugin.getConnectionCount()).toBe(0)

    // Re-stop is idempotent.
    expect(() => stop?.()).not.toThrow()
  })

  // Wire conformance — SDK Client → tools/list → []
  it("MCP wire conformance: SDK Client → tools/list returns []", async () => {
    const socketPath = makeSocketPath()
    const plugin = createMcpPlugin({
      socketPath,
      idleTimeoutMs: 60_000,
      maxLifetimeMs: 60_000,
    })
    const stop = plugin.start(noopApi) ?? (() => {})
    try {
      await until(() => plugin.getAddress() !== null)

      const client = new McpClient({ name: "test-client", version: "0.0.0" }, { capabilities: {} })
      const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
        fetch: makeUnixFetch(socketPath),
      })
      await client.connect(transport)

      const tools = await client.listTools()
      expect(tools.tools).toEqual([])
    } finally {
      stop()
    }
  })
})
