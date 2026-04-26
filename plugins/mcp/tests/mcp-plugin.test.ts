/**
 * Happy-path lifecycle test for createMcpPlugin.
 *
 * Validates the full design ruling:
 *   1. Plugin starts, binds an ephemeral HTTP port.
 *   2. SSE client connects → connection count goes 0 → 1, idle timer cancels.
 *   3. POST /rpc with `tools/list` → `{ result: { tools: [] } }`.
 *   4. SSE client disconnects → count back to 0, idle timer arms.
 *   5. After idle window elapses, the registered onRequestQuit fires.
 *   6. stop() cleans up — second start() is allowed.
 */

import { describe, it, expect } from "vitest"
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

async function fetchJson(url: string, body: unknown): Promise<unknown> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return r.json()
}

async function until(pred: () => boolean, timeoutMs = 1_000, stepMs = 10): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting after ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

describe("createMcpPlugin", () => {
  it("connection-as-lease lifecycle: connect → tools/list → disconnect → idle-quit", async () => {
    const quitReasons: string[] = []
    const plugin = createMcpPlugin({
      onRequestQuit: (reason) => quitReasons.push(reason),
      idleTimeoutMs: 100, // tiny window for the test
      pollIntervalMs: 50,
    })

    const stop = plugin.start(noopApi) ?? (() => {})
    try {
      // Wait for HTTP server to be listening.
      await until(() => plugin.getAddress() !== null)
      const addr = plugin.getAddress()!
      const base = `http://${addr.host}:${addr.port}`

      // ---- 1. Health check ----
      const health = await fetch(`${base}/healthz`)
      expect(health.status).toBe(200)

      // ---- 2. Connect SSE client ----
      // node fetch streams the SSE body — we hold a reader to keep the
      // connection alive, then release it to disconnect.
      const ac = new AbortController()
      const sseResp = await fetch(`${base}/sse`, { signal: ac.signal })
      expect(sseResp.status).toBe(200)
      expect(sseResp.headers.get("content-type")).toContain("text/event-stream")
      // Eagerly consume the preamble so the server flush completes — this
      // is what bumps connections.size from 0 → 1.
      const reader = sseResp.body!.getReader()
      const { value } = await reader.read()
      expect(new TextDecoder().decode(value)).toContain("connected")

      await until(() => plugin.getConnectionCount() === 1)

      // ---- 3. tools/list returns [] ----
      const toolsList = (await fetchJson(`${base}/rpc`, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      })) as { jsonrpc: string; id: number; result: { tools: unknown[] } }
      expect(toolsList.jsonrpc).toBe("2.0")
      expect(toolsList.id).toBe(1)
      expect(toolsList.result.tools).toEqual([])

      // ---- 4. Disconnect → idle timer arms ----
      // Cancel the SSE fetch — server's res.on("close") fires, drops the
      // connection, sees count==0, arms idle timer.
      await reader.cancel().catch(() => {})
      ac.abort()
      await until(() => plugin.getConnectionCount() === 0)

      // No quit yet — timer just armed.
      expect(quitReasons).toHaveLength(0)

      // ---- 5. After idle window → onRequestQuit fires ----
      await until(() => quitReasons.length > 0, 1_000)
      expect(quitReasons[0]).toBe("idle")
    } finally {
      stop()
    }
  })

  it("custom predicate composes with built-ins (no kind field, just a thunk)", async () => {
    const reasons: string[] = []
    let trigger = false
    const plugin = createMcpPlugin({
      onRequestQuit: (r) => reasons.push(r),
      idleTimeoutMs: 60_000, // big enough that idle won't fire
      pollIntervalMs: 25,
      initialPredicates: [() => trigger],
    })
    const stop = plugin.start(noopApi) ?? (() => {})
    try {
      await until(() => plugin.getAddress() !== null)
      // Predicate registry includes the initial one.
      expect(reasons).toHaveLength(0)
      // Flip the trigger; the slow tick should pick it up.
      trigger = true
      await until(() => reasons.length > 0, 500)
      expect(reasons[0]).toBe("initial")
    } finally {
      stop()
    }
  })

  it("registerQuitPredicate works after start()", async () => {
    const reasons: string[] = []
    const plugin = createMcpPlugin({
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
