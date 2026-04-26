/**
 * Tests for createMcpPlugin — Unix socket wire + MCP SDK transport +
 * EventEmitter request_quit channel.
 *
 *   1. lifecycle: connect raw HTTP → wire count 0 → 1; disconnect → 0;
 *      idle window expires → events.emit("request_quit", "idle"). Validates
 *      the connection-as-lease design ruling end-to-end.
 *   2. tools/list: SDK Client (StreamableHTTPClientTransport) over a
 *      Unix-socket fetch shim → `tools/list` → `[]`. Validates wire
 *      conformance with the @modelcontextprotocol/sdk transport.
 *   3. initial-predicate composition: a custom predicate fires before
 *      the idle window — proves predicates compose as flat thunks.
 *   4. registerQuitPredicate after start() works.
 *   5. multi-listener: two `events.on("request_quit", ...)` listeners
 *      both receive the event — pins the EventEmitter contract that
 *      motivated the swap from `onRequestQuit` callback.
 */

import { describe, it, expect } from "vitest"
import { mkdtempSync, statSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { request as httpRequest, type IncomingMessage } from "node:http"
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createMcpPlugin } from "../mcp-plugin.ts"
import type { TribeClientApi } from "../../../tools/lib/tribe/plugin-api.ts"

// Stub TribeClientApi — the plugin doesn't touch the wire in this prototype.
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
 * Open a long-running streaming HTTP GET against `/healthz?stream=<ms>`
 * and hold the response open until the caller invokes `close()`. Used by
 * the lifecycle test to take and drop the lease deterministically.
 *
 * Why a streaming GET, not a raw keep-alive socket? The plugin tracks the
 * lease at the response level — a request is a lease while its response
 * is open. This matches both runtimes:
 *
 *   - Node and Bun both fire `res.on("close")` reliably when the response
 *     stream ends, whether by `res.end()` or by client cancellation.
 *   - Bun's http.Server (1.3.x) does NOT fire socket-level close events on
 *     keep-alive disconnect (oven-sh/bun#7716), so kernel-level connection
 *     tracking is unreliable there. Tracking at the response level avoids
 *     the broken signal entirely.
 *
 * Realistic mirror of production: an MCP client opens GET /mcp for the
 * SSE stream and that stream IS its lease for as long as it's open.
 * `/healthz?stream` is a lighter-weight probe that exercises the same
 * lease accounting without dragging the MCP SDK transport into the
 * lifecycle assertions.
 */
function holdStreamingRequest(socketPath: string): Promise<{ close: () => void }> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      {
        socketPath,
        method: "GET",
        // Big window — the test calls close() when it's done; the server
        // will release the lease either on close() or after this timeout.
        path: "/healthz?stream=60000",
        agent: false,
      },
      (res: IncomingMessage) => {
        // Headers received → response is open and registered as a lease.
        // Drain data into the void so the response stream stays live; we
        // just don't propagate it anywhere.
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

/**
 * Fetch shim that routes requests over a Unix socket. The MCP SDK's
 * StreamableHTTPClientTransport accepts a custom `fetch` impl, so we plug
 * this in and the SDK is unaware that the wire is a socket file.
 */
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
        // Stream the response body — SSE responses don't end until the
        // server says so, so collecting then resolving would deadlock.
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

describe("createMcpPlugin (Unix socket + MCP SDK transport)", () => {
  it("lifecycle: bind-publish, lease taken on connect, dropped on disconnect, idle-quit fires via EventEmitter", async () => {
    const reasons: string[] = []
    const socketPath = makeSocketPath()
    const plugin = createMcpPlugin({
      socketPath,
      idleTimeoutMs: 100, // tiny window for the test
      pollIntervalMs: 50,
    })
    plugin.events.on("request_quit", (reason) => reasons.push(reason))

    const stop = plugin.start(noopApi) ?? (() => {})
    try {
      await until(() => plugin.getAddress() !== null)
      expect(plugin.getAddress()).toEqual({ socketPath })

      // Bind-before-publish: socket file exists with mode 0600.
      expect(existsSync(socketPath)).toBe(true)
      const mode = statSync(socketPath).mode & 0o777
      expect(mode).toBe(0o600)

      // ---- Response-as-lease ----
      // Open a long-running streaming GET to hold the lease. The plugin
      // tracks active in-flight responses (see `activeResponses` doc in
      // mcp-plugin.ts); this mirrors the realistic MCP SSE long-poll
      // pattern without dragging the SDK transport into the lifecycle
      // assertions.
      const conn = await holdStreamingRequest(socketPath)
      await until(() => plugin.getConnectionCount() >= 1)
      // While the response is open, the idle predicate is held off — no
      // quit yet, even past the idle window.
      await new Promise((r) => setTimeout(r, 200)) // > idleTimeoutMs
      expect(reasons).toHaveLength(0)

      // ---- Drop the request → response closes → idle timer arms → request_quit fires ----
      conn.close()
      await until(() => plugin.getConnectionCount() === 0)
      await until(() => reasons.length > 0, 1_000)
      expect(reasons[0]).toBe("idle")
    } finally {
      stop()
    }

    // stop() unlinks the published socket.
    expect(existsSync(socketPath)).toBe(false)
  })

  it("MCP wire conformance: SDK Client → tools/list returns []", async () => {
    // This test validates that an actual @modelcontextprotocol/sdk Client
    // — using the canonical StreamableHTTPClientTransport — can talk to
    // the plugin and round-trip a tools/list request. The fetch shim
    // routes the SDK's HTTP calls over the Unix socket. tools/list is
    // skeleton-empty by design; real tools come in a follow-up bead.
    const socketPath = makeSocketPath()
    const plugin = createMcpPlugin({
      socketPath,
      // Big windows so idle-quit doesn't race the test.
      idleTimeoutMs: 60_000,
      pollIntervalMs: 60_000,
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

      // We don't test client.close()/teardown timing here — the SDK's
      // SSE-stream long-poll has subtle interactions with our fetch shim
      // that don't bear on wire conformance. The lifecycle test above
      // covers connect/disconnect using a raw connection.
    } finally {
      stop()
    }
  })

  it("custom predicate composes with built-ins (no kind field, just a thunk)", async () => {
    const reasons: string[] = []
    let trigger = false
    const socketPath = makeSocketPath()
    const plugin = createMcpPlugin({
      socketPath,
      idleTimeoutMs: 60_000, // big enough that idle won't fire
      pollIntervalMs: 25,
      initialPredicates: [() => trigger],
    })
    plugin.events.on("request_quit", (r) => reasons.push(r))

    const stop = plugin.start(noopApi) ?? (() => {})
    try {
      await until(() => plugin.getAddress() !== null)
      expect(reasons).toHaveLength(0)
      trigger = true
      await until(() => reasons.length > 0, 500)
      expect(reasons[0]).toBe("initial")
    } finally {
      stop()
    }
  })

  it("registerQuitPredicate works after start()", async () => {
    const reasons: string[] = []
    const socketPath = makeSocketPath()
    const plugin = createMcpPlugin({
      socketPath,
      idleTimeoutMs: 60_000,
      pollIntervalMs: 25,
    })
    plugin.events.on("request_quit", (r) => reasons.push(r))

    const stop = plugin.start(noopApi) ?? (() => {})
    try {
      await until(() => plugin.getAddress() !== null)
      let fire = false
      plugin.registerQuitPredicate(() => fire)
      await new Promise((r) => setTimeout(r, 75)) // a couple of polls
      expect(reasons).toHaveLength(0)
      fire = true
      await until(() => reasons.length > 0, 500)
      expect(reasons[0]).toBe("user")
    } finally {
      stop()
    }
  })

  it("multiple request_quit listeners both receive the event", async () => {
    // The motivation for swapping callback → EventEmitter: more than one
    // subscriber. This test pins that contract — both the supervisor's
    // shutdown handler AND a telemetry listener receive the same event.
    const supervisor: string[] = []
    const telemetry: string[] = []
    let trigger = false
    const socketPath = makeSocketPath()
    const plugin = createMcpPlugin({
      socketPath,
      idleTimeoutMs: 60_000,
      pollIntervalMs: 25,
      initialPredicates: [() => trigger],
    })
    plugin.events.on("request_quit", (r) => supervisor.push(r))
    plugin.events.on("request_quit", (r) => telemetry.push(r))

    const stop = plugin.start(noopApi) ?? (() => {})
    try {
      await until(() => plugin.getAddress() !== null)
      trigger = true
      await until(() => supervisor.length > 0 && telemetry.length > 0, 500)
      expect(supervisor).toEqual(["initial"])
      expect(telemetry).toEqual(["initial"])
    } finally {
      stop()
    }
  })
})
