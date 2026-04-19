/**
 * Tribe plugin boundary — unit + integration coverage for the
 * TribePluginApi / TribeClientApi contract (km-tribe.plugin-extraction).
 *
 * Two layers of verification:
 *
 *   1. loadPlugins happy path — available plugins start, unavailable plugins
 *      are silently skipped, the returned { active, stop } shape is correct,
 *      stop() actually disposes each plugin's cleanup.
 *
 *   2. Plugin → wire integration — a fake plugin that calls api.broadcast
 *      on startup, hooked up to a minimal TribeClientApi that dispatches to
 *      a fresh tribe daemon subprocess. The broadcast must land in
 *      tribe.history exactly as if a regular session had sent it.
 *
 * Side-effect guard: every test runs the daemon with TRIBE_NO_PLUGINS=1 so
 * the built-in git/beads/github/health/accountly plugins stay out of the
 * way. Only the fake plugin under test emits messages.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { connectToDaemon, type DaemonClient } from "../tools/lib/tribe/socket.ts"
import { loadPlugins } from "../tools/lib/tribe/plugin-loader.ts"
import type { TribeClientApi, TribePluginApi } from "../tools/lib/tribe/plugin-api.ts"

// ---------------------------------------------------------------------------
// Layer 1 — loadPlugins unit test (no daemon, no socket)
// ---------------------------------------------------------------------------

describe("loadPlugins", () => {
  function makeSpyApi(): { api: TribeClientApi; broadcasts: Array<{ content: string; type: string }> } {
    const broadcasts: Array<{ content: string; type: string }> = []
    const api: TribeClientApi = {
      send() {
        /* not used in this test */
      },
      broadcast(content, type) {
        broadcasts.push({ content, type })
      },
      claimDedup: () => true,
      hasRecentMessage: () => false,
      getActiveSessions: () => [],
      getSessionNames: () => [],
      hasChief: () => false,
    }
    return { api, broadcasts }
  }

  it("starts only plugins that report available() === true", () => {
    const started: string[] = []
    const ok: TribePluginApi = {
      name: "ok",
      available: () => true,
      start() {
        started.push("ok")
        return () => {}
      },
    }
    const skip: TribePluginApi = {
      name: "skip",
      available: () => false,
      start() {
        started.push("skip")
        return () => {}
      },
    }
    const { api } = makeSpyApi()
    const loaded = loadPlugins([ok, skip], api)
    expect(started).toEqual(["ok"])
    expect(loaded.active).toEqual([
      { name: "ok", active: true },
      { name: "skip", active: false },
    ])
    loaded.stop()
  })

  it("stop() invokes every cleanup returned from start()", () => {
    const stopped: string[] = []
    const a: TribePluginApi = {
      name: "a",
      available: () => true,
      start: () => () => stopped.push("a"),
    }
    const b: TribePluginApi = {
      name: "b",
      available: () => true,
      start: () => () => stopped.push("b"),
    }
    const { api } = makeSpyApi()
    const loaded = loadPlugins([a, b], api)
    loaded.stop()
    expect(stopped.sort()).toEqual(["a", "b"])
  })

  it("a plugin that calls api.broadcast on startup reaches the spy", () => {
    const plugin: TribePluginApi = {
      name: "noisy",
      available: () => true,
      start(api) {
        api.broadcast("hello from plugin", "test:hello")
        return () => {}
      },
    }
    const { api, broadcasts } = makeSpyApi()
    const loaded = loadPlugins([plugin], api)
    expect(broadcasts).toEqual([{ content: "hello from plugin", type: "test:hello" }])
    loaded.stop()
  })
})

// ---------------------------------------------------------------------------
// Layer 2 — fake plugin against a real daemon subprocess
// ---------------------------------------------------------------------------

const DAEMON_SCRIPT = resolve(dirname(new URL(import.meta.url).pathname), "../tools/tribe-daemon.ts")

async function waitFor(fn: () => boolean | Promise<boolean>, timeout = 5000, interval = 50): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`waitFor timed out after ${timeout}ms`)
}

async function spawnDaemon(socketPath: string, dbPath: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [DAEMON_SCRIPT, "--socket", socketPath, "--db", dbPath, "--quit-timeout", "-1"],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        TRIBE_DB: dbPath,
        TRIBE_NO_SUPPRESS: "1",
        // Built-in plugins must stay silent so the only messages on the wire
        // come from the fake plugin under test.
        TRIBE_NO_PLUGINS: "1",
      },
    },
  )
  await waitFor(() => existsSync(socketPath), 8000)
  return child
}

async function killDaemon(proc: ChildProcess | null): Promise<void> {
  if (!proc || proc.exitCode !== null) return
  try {
    proc.kill("SIGKILL")
  } catch {
    /* ignore */
  }
  await new Promise<void>((res) => {
    if (proc.exitCode !== null) return res()
    const to = setTimeout(() => res(), 3000)
    proc.once("exit", () => {
      clearTimeout(to)
      res()
    })
  })
}

/** Build a TribeClientApi that dispatches to a real daemon via a DaemonClient
 *  registered under `pluginName`. This mirrors what an out-of-process plugin
 *  would do: connect as a client, then call tribe.send / tribe.broadcast. */
async function attachPlugin(
  socketPath: string,
  pluginName: string,
): Promise<{ api: TribeClientApi; close: () => void }> {
  const client = await connectToDaemon(socketPath)
  await client.call("register", { name: pluginName, role: "member" })
  const api: TribeClientApi = {
    send(recipient, content, type, beadId) {
      void client.call("tribe.send", { to: recipient, message: content, type, bead_id: beadId })
    },
    broadcast(content, type, beadId) {
      void client.call("tribe.send", { to: "*", message: content, type, bead_id: beadId })
    },
    claimDedup: () => true,
    hasRecentMessage: () => false,
    getActiveSessions: () => [],
    getSessionNames: () => [],
    hasChief: () => true,
  }
  return { api, close: () => client.close() }
}

function parseToolText(result: unknown): unknown {
  const content = (result as { content?: Array<{ text: string }> } | undefined)?.content
  const text = content?.[0]?.text
  if (typeof text !== "string") throw new Error(`Tool response missing .content[0].text: ${JSON.stringify(result)}`)
  return JSON.parse(text)
}

describe("plugin → tribe.history (integration)", () => {
  let tmpDir: string
  let socketPath: string
  let dbPath: string
  let daemon: ChildProcess | null = null
  let pluginClose: (() => void) | null = null
  const observers: DaemonClient[] = []

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-plugin-boundary-"))
    socketPath = join(tmpDir, "tribe.sock")
    dbPath = join(tmpDir, "tribe.db")
    daemon = null
    pluginClose = null
  })

  afterEach(async () => {
    for (const c of observers.splice(0)) {
      try {
        c.close()
      } catch {
        /* ignore */
      }
    }
    if (pluginClose) {
      try {
        pluginClose()
      } catch {
        /* ignore */
      }
    }
    await killDaemon(daemon)
    daemon = null
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath)
      } catch {
        /* ignore */
      }
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("a fake plugin calling api.broadcast on startup lands in tribe.history", async () => {
    daemon = await spawnDaemon(socketPath, dbPath)

    // A second client will observe the wire.
    const observer = await connectToDaemon(socketPath)
    observers.push(observer)
    await observer.call("register", { name: "observer", role: "member" })

    // Wire the fake plugin to the daemon via a standard tribe client.
    const plugin: TribePluginApi = {
      name: "fake-observer",
      available: () => true,
      start(api) {
        api.broadcast("hello from plugin", "test:plugin-boundary")
        return () => {}
      },
    }
    const { api, close } = await attachPlugin(socketPath, plugin.name)
    pluginClose = close

    // loadPlugins runs start() synchronously; the broadcast fire-and-forgets
    // the JSON-RPC call, so give the daemon a beat to commit + fan out.
    const loaded = loadPlugins([plugin], api)
    await new Promise((r) => setTimeout(r, 250))

    const messages = parseToolText(await observer.call("tribe.history", { limit: 20 })) as Array<{
      from: string
      content: string
      type: string
    }>
    const match = messages.find((m) => m.content === "hello from plugin" && m.type === "test:plugin-boundary")
    expect(match).toBeDefined()
    expect(match!.from).toBe("fake-observer")

    loaded.stop()
  }, 20_000)
})
