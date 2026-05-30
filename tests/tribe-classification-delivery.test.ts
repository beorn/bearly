/**
 * km-tribe.event-classification — daemon-spawn delivery-filter integration.
 *
 * Spawns a real daemon and verifies wakeup delivery:
 *   - push recipients get a wakeup and drain content through `tribe.fetch`
 *   - tribe.filter mode='focus' suppresses broadcasts but still wakes for DMs
 *   - tribe.filter with mute + until silences broadcasts and bypasses mute
 *     for direct DMs
 *
 * tribe.filter unit-level coverage (validation, schema writes) lives in
 * tribe-filter.test.ts.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { randomUUID } from "node:crypto"
import { existsSync, unlinkSync } from "node:fs"
import { spawn, type ChildProcess } from "node:child_process"
import { resolve, dirname } from "node:path"
import { connectToDaemon, type DaemonClient } from "@bearly/tribe-client/lib/socket"

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

function parseToolText<T>(result: unknown): T {
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text
  if (typeof text !== "string") throw new Error("expected tool text response")
  return JSON.parse(text) as T
}

type FetchResult = {
  events: Array<{ from: string; content: string; topic: string | null; responseExpected?: unknown }>
}

describe("tribe.filter — daemon-spawn delivery integration", () => {
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

  it("wakeup recipients drain topic through fetch (no replyHint on fetched event)", async () => {
    daemon = await spawnDaemon(socketPath)
    const receiver = await connect()
    const notifs: Array<{ method: string; params?: Record<string, unknown> }> = []
    receiver.onNotification((method, params) => notifs.push({ method, params }))
    await receiver.call("register", { name: "alice", role: "chief" })

    const sender = await connect()
    await sender.call("register", { name: "bob", role: "member" })

    await sender.call("tribe.send", { to: "alice", message: "review please", type: "request" })

    await waitFor(() => notifs.some((n) => n.method === "wakeup" && n.params?.message_id), 5000)
    const fetched = parseToolText<FetchResult>(await receiver.call("tribe.fetch", { limit: 10 }))
    const event = fetched.events.find((e) => e.from === "bob" && e.content === "review please")
    expect(event).toBeDefined()
    expect(event!.responseExpected).toBeUndefined()
    expect(event!.topic).toBeNull()
  }, 15_000)

  it("tribe.filter mode=focus suppresses broadcasts but still delivers DMs", async () => {
    daemon = await spawnDaemon(socketPath)
    const focused = await connect()
    const focusedNotifs: Array<{ method: string; params?: Record<string, unknown> }> = []
    focused.onNotification((method, params) => {
      if (method === "wakeup") focusedNotifs.push({ method, params })
    })
    await focused.call("register", { name: "alice", role: "chief" })
    await focused.call("tribe.filter", { mode: "focus" })

    const sender = await connect()
    await sender.call("register", { name: "bob", role: "member" })

    // Broadcast — derived replyHint='optional' → suppressed under focus mode.
    await sender.call("tribe.send", { to: "*", message: "FYI", type: "status" })
    await new Promise((r) => setTimeout(r, 700)) // give time for fanout
    expect(focusedNotifs).toHaveLength(0)

    // Direct DM from a peer member — derived replyHint='yes' → delivered.
    await sender.call("tribe.send", { to: "alice", message: "blocker", type: "query" })
    await waitFor(() => focusedNotifs.length === 1, 3000)
    const fetched = parseToolText<FetchResult>(await focused.call("tribe.fetch", { limit: 10 }))
    expect(fetched.events.some((e) => e.content === "blocker")).toBe(true)
  }, 15_000)

  it("tribe.filter with mute + until suppresses matching broadcasts; DMs bypass", async () => {
    daemon = await spawnDaemon(socketPath)
    const reader = await connect()
    const readerNotifs: Array<{ method: string; params?: Record<string, unknown> }> = []
    reader.onNotification((method, params) => {
      if (method === "wakeup") readerNotifs.push({ method, params })
    })
    await reader.call("register", { name: "alice", role: "chief" })
    // Mute all broadcasts for 200ms.
    await reader.call("tribe.filter", { until: Date.now() + 200 })

    const sender = await connect()
    await sender.call("register", { name: "bob", role: "member" })

    // Broadcast during the mute window should be suppressed.
    await sender.call("tribe.send", { to: "*", message: "muted fyi", type: "notify" })
    await new Promise((r) => setTimeout(r, 700))
    expect(readerNotifs).toHaveLength(0)

    // Direct DM bypasses the mute/until dimensions — should arrive.
    await sender.call("tribe.send", { to: "alice", message: "direct", type: "notify" })
    await waitFor(() => readerNotifs.length === 1, 3000)

    // Wait past the mute window, then verify a fresh broadcast goes through.
    await new Promise((r) => setTimeout(r, 250))
    await sender.call("tribe.send", { to: "*", message: "post-filter fyi", type: "notify" })
    await waitFor(() => readerNotifs.length === 2, 3000)
    const fetched = parseToolText<FetchResult>(await reader.call("tribe.fetch", { limit: 10 }))
    expect(fetched.events.some((e) => e.content === "direct")).toBe(true)
    expect(fetched.events.some((e) => e.content === "post-filter fyi")).toBe(true)
  }, 15_000)

  it("tribe.filter empty args clears any active filter", async () => {
    daemon = await spawnDaemon(socketPath)
    const c = await connect()
    await c.call("register", { name: "alice", role: "chief" })
    // Set, then clear.
    await c.call("tribe.filter", { mode: "focus", mute: ["bead:*"] })
    const cleared = (await c.call("tribe.filter", {})) as { content: Array<{ type: string; text: string }> }
    const parsed = JSON.parse(cleared.content[0]!.text) as { mode: string; mute: unknown; until: unknown }
    expect(parsed.mode).toBe("normal")
    expect(parsed.mute).toBeNull()
    expect(parsed.until).toBeNull()
  }, 10_000)
})
