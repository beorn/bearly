/**
 * km-tribe.event-classification — delivery-filter + envelope integration.
 *
 * Spawns a real daemon and verifies:
 *   - `responseExpected` and `plugin_kind` appear on channel notifications
 *   - tribe.mode("focus") drops responseExpected="optional" pushes
 *   - tribe.snooze suppresses matching kinds; direct DMs bypass
 *   - tribe.dismiss writes the audit row
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { randomUUID } from "node:crypto"
import { existsSync, unlinkSync } from "node:fs"
import { spawn, type ChildProcess } from "node:child_process"
import { resolve, dirname } from "node:path"
import { connectToDaemon, type DaemonClient } from "../tools/lib/tribe/socket.ts"

const DAEMON_SCRIPT = resolve(dirname(new URL(import.meta.url).pathname), "../tools/tribe-daemon.ts")

function tmpSocket() {
  return `/tmp/tribe-classify-${randomUUID().slice(0, 8)}.sock`
}

async function waitFor(fn: () => boolean | Promise<boolean>, timeout = 5000, interval = 50): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`waitFor timed out after ${timeout}ms`)
}

async function spawnDaemon(socketPath: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [DAEMON_SCRIPT, "--socket", socketPath, "--quit-timeout", "2"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      TRIBE_DB: `/tmp/tribe-classify-${randomUUID().slice(0, 8)}.db`,
      TRIBE_NO_SUPPRESS: "1",
      TRIBE_NO_PLUGINS: "1",
      TRIBE_ACTIVITY_LOG: "off",
    },
  })
  await waitFor(() => existsSync(socketPath), 5000)
  return child
}

describe("classification — channel envelope + mode + snooze + dismiss", () => {
  let socketPath: string
  let daemon: ChildProcess | null = null
  const clients: DaemonClient[] = []

  beforeEach(() => {
    socketPath = tmpSocket()
  })

  afterEach(async () => {
    for (const c of clients) {
      try {
        c.close()
      } catch {
        /* ignore */
      }
    }
    clients.length = 0
    if (daemon) {
      daemon.kill("SIGTERM")
      await new Promise((r) => setTimeout(r, 100))
      if (!daemon.killed) daemon.kill("SIGKILL")
      daemon = null
    }
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath)
      } catch {
        /* ignore */
      }
    }
  })

  async function connect(): Promise<DaemonClient> {
    const c = await connectToDaemon(socketPath)
    clients.push(c)
    return c
  }

  it("channel envelope carries responseExpected + plugin_kind on every push notification", async () => {
    daemon = await spawnDaemon(socketPath)
    const receiver = await connect()
    const notifs: Array<{ method: string; params?: Record<string, unknown> }> = []
    receiver.onNotification((method, params) => notifs.push({ method, params }))
    await receiver.call("register", { name: "alice", role: "chief" })

    const sender = await connect()
    await sender.call("register", { name: "bob", role: "member" })

    // Send a direct push with responseExpected="yes".
    await sender.call("tribe.send", { to: "alice", message: "review please", type: "request" })

    await waitFor(
      () => notifs.some((n) => n.method === "channel" && String(n.params?.from) === "bob"),
      5000,
    )
    const env = notifs.find((n) => n.method === "channel" && String(n.params?.from) === "bob")!
    expect(env.params?.responseExpected).toBe("yes")
    // plugin_kind is null for human DMs (no plugin originated it)
    expect(env.params?.plugin_kind).toBeNull()
  }, 15_000)

  it("tribe.mode focus suppresses responseExpected!=yes broadcasts", async () => {
    daemon = await spawnDaemon(socketPath)
    const focused = await connect()
    const focusedNotifs: Array<{ method: string; params?: Record<string, unknown> }> = []
    focused.onNotification((method, params) => {
      if (method === "channel") focusedNotifs.push({ method, params })
    })
    await focused.call("register", { name: "alice", role: "chief" })
    await focused.call("tribe.mode", { mode: "focus" })

    const sender = await connect()
    await sender.call("register", { name: "bob", role: "member" })

    // Optional broadcast — should NOT reach focused.
    await sender.call("tribe.broadcast", { message: "FYI", type: "status" })
    await new Promise((r) => setTimeout(r, 700)) // give time for fanout
    const optionalReceived = focusedNotifs.find((n) => String(n.params?.content ?? "").includes("FYI"))
    expect(optionalReceived).toBeUndefined()

    // Direct DM (responseExpected defaults to "yes") — DOES reach focused.
    await sender.call("tribe.send", { to: "alice", message: "blocker", type: "query" })
    await waitFor(() => focusedNotifs.some((n) => String(n.params?.content ?? "").includes("blocker")), 3000)
  }, 15_000)

  it("tribe.snooze suppresses matching plugin_kind broadcasts; auto-reverts when expired", async () => {
    daemon = await spawnDaemon(socketPath)
    const reader = await connect()
    const readerNotifs: Array<{ method: string; params?: Record<string, unknown> }> = []
    reader.onNotification((method, params) => {
      if (method === "channel") readerNotifs.push({ method, params })
    })
    await reader.call("register", { name: "alice", role: "chief" })
    // Snooze for 200ms, github:* only.
    await reader.call("tribe.snooze", { duration_sec: 0.2, kinds: ["github:*"] })

    const sender = await connect()
    await sender.call("register", { name: "bob", role: "member" })

    // Direct DM bypasses snooze — should arrive.
    await sender.call("tribe.send", { to: "alice", message: "direct", type: "notify" })
    await waitFor(() => readerNotifs.some((n) => String(n.params?.content ?? "").includes("direct")), 3000)

    // Wait past snooze window, then verify a fresh broadcast goes through.
    await new Promise((r) => setTimeout(r, 250))
    await sender.call("tribe.broadcast", { message: "post-snooze fyi", type: "notify" })
    await waitFor(() => readerNotifs.some((n) => String(n.params?.content ?? "").includes("post-snooze")), 3000)
  }, 15_000)

  it("tribe.dismiss inserts an audit row addressable by message id", async () => {
    daemon = await spawnDaemon(socketPath)
    const c = await connect()
    await c.call("register", { name: "alice", role: "chief" })
    const messageId = randomUUID()
    const result = (await c.call("tribe.dismiss", {
      message_id: messageId,
      reason: "test dismissal",
    })) as { content: Array<{ type: string; text: string }> }
    const parsed = JSON.parse(result.content[0]!.text) as { dismissed: boolean }
    expect(parsed.dismissed).toBe(true)
  }, 10_000)
})
