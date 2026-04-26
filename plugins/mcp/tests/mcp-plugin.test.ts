/**
 * Happy-path lifecycle test for createMcpPlugin.
 *
 * Validates the full design ruling, now over a Unix socket transport:
 *   1. Plugin starts, bind-and-publishes a socket file at the expected path.
 *   2. Socket file exists with mode 0600.
 *   3. SSE client connects → connection count goes 0 → 1, idle timer cancels.
 *   4. POST /rpc with `tools/list` → `{ result: { tools: [] } }`.
 *   5. SSE client disconnects → count back to 0, idle timer arms.
 *   6. After idle window elapses, the registered onRequestQuit fires.
 *   7. stop() cleans up — published socket file is unlinked.
 */

import { describe, it, expect } from "vitest"
import { mkdtempSync, statSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http"
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

/** Send a JSON-RPC POST over a Unix socket and return the parsed JSON body. */
function unixPostJson(socketPath: string, path: string, body: unknown): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      {
        socketPath,
        path,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer) => chunks.push(c))
        res.on("end", () => {
          try {
            resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")))
          } catch (err) {
            reject(err as Error)
          }
        })
        res.on("error", reject)
      },
    )
    req.on("error", reject)
    req.end(JSON.stringify(body))
  })
}

/** GET over a Unix socket, returning the (status, body) pair. */
function unixGet(socketPath: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest({ socketPath, path, method: "GET" }, (res: IncomingMessage) => {
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () => {
        resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })
      })
      res.on("error", reject)
    })
    req.on("error", reject)
    req.end()
  })
}

/**
 * Open an SSE connection over a Unix socket. Returns the underlying request
 * (so the test can abort it) plus the first decoded chunk (the preamble),
 * confirming the server has flushed headers and the connection is in the
 * active set.
 */
function unixSse(socketPath: string): Promise<{ req: ClientRequest; preamble: string; close: () => void }> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest({ socketPath, path: "/sse", method: "GET" }, (res: IncomingMessage) => {
      res.once("data", (c: Buffer) => {
        resolvePromise({
          req,
          preamble: c.toString("utf8"),
          close: () => {
            // destroy() severs the socket — the server's res.on("close")
            // listener fires and drops the connection from the active set.
            req.destroy()
            res.destroy()
          },
        })
      })
      res.on("error", () => {
        /* swallowed — close()/destroy() trips this on shutdown */
      })
    })
    req.on("error", reject)
    req.end()
  })
}

async function until(pred: () => boolean, timeoutMs = 1_000, stepMs = 10): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting after ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

describe("createMcpPlugin (Unix socket wire)", () => {
  it("connection-as-lease lifecycle: bind-publish → tools/list → disconnect → idle-quit", async () => {
    const quitReasons: string[] = []
    const socketPath = makeSocketPath()
    const plugin = createMcpPlugin({
      socketPath,
      onRequestQuit: (reason) => quitReasons.push(reason),
      idleTimeoutMs: 100, // tiny window for the test
      pollIntervalMs: 50,
    })

    const stop = plugin.start(noopApi) ?? (() => {})
    try {
      // Wait for bind-and-publish to finish.
      await until(() => plugin.getAddress() !== null)
      expect(plugin.getAddress()).toEqual({ socketPath })

      // Socket file is present with mode 0600 (owner rw, no group/other).
      expect(existsSync(socketPath)).toBe(true)
      const mode = statSync(socketPath).mode & 0o777
      expect(mode).toBe(0o600)

      // ---- 1. Health check over Unix socket ----
      const health = await unixGet(socketPath, "/healthz")
      expect(health.status).toBe(200)
      expect(health.body).toBe("ok\n")

      // ---- 2. Connect SSE client ----
      const sse = await unixSse(socketPath)
      expect(sse.preamble).toContain("connected")
      await until(() => plugin.getConnectionCount() === 1)

      // ---- 3. tools/list returns [] ----
      const toolsList = (await unixPostJson(socketPath, "/rpc", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      })) as { jsonrpc: string; id: number; result: { tools: unknown[] } }
      expect(toolsList.jsonrpc).toBe("2.0")
      expect(toolsList.id).toBe(1)
      expect(toolsList.result.tools).toEqual([])

      // ---- 4. Disconnect → idle timer arms ----
      sse.close()
      await until(() => plugin.getConnectionCount() === 0)
      expect(quitReasons).toHaveLength(0)

      // ---- 5. After idle window → onRequestQuit fires ----
      await until(() => quitReasons.length > 0, 1_000)
      expect(quitReasons[0]).toBe("idle")
    } finally {
      stop()
    }

    // ---- 6. stop() unlinks the published socket ----
    expect(existsSync(socketPath)).toBe(false)
  })

  it("custom predicate composes with built-ins (no kind field, just a thunk)", async () => {
    const reasons: string[] = []
    let trigger = false
    const socketPath = makeSocketPath()
    const plugin = createMcpPlugin({
      socketPath,
      onRequestQuit: (r) => reasons.push(r),
      idleTimeoutMs: 60_000, // big enough that idle won't fire
      pollIntervalMs: 25,
      initialPredicates: [() => trigger],
    })
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
      onRequestQuit: (r) => reasons.push(r),
      idleTimeoutMs: 60_000,
      pollIntervalMs: 25,
    })
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
})
