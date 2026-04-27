/**
 * Tribe composition factories — proves the `pipe + with*` layer assembles a
 * tribe-daemon value with type-driven prerequisites and Scope-cascade cleanup.
 *
 * These factories are the structural foundation for migrating tribe-daemon.ts
 * to a `pipe(...)` boot. Tests here verify each factory in isolation; the
 * fully-piped daemon is verified by `tribe-daemon.test.ts`.
 */

import { describe, expect, it, afterEach } from "vitest"
import { existsSync, unlinkSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { createScope, pipe, withTool, withTools } from "../packages/daemon-spine/src/index.ts"
import {
  createBaseTribe,
  loreTools,
  MESSAGING_TOOL_NAMES,
  messagingTools,
  withConfig,
  withDaemonContext,
  withDatabase,
  withLore,
  withPlugin,
  withPluginApi,
  withProjectRoot,
} from "../tools/lib/tribe/compose/index.ts"
import type { TribeClientApi, TribePluginApi } from "../tools/lib/tribe/plugin-api.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cleanupPaths: string[] = []
function tmpDb(): string {
  const path = `/tmp/tribe-compose-test-${randomUUID().slice(0, 8)}.db`
  cleanupPaths.push(path)
  return path
}

afterEach(() => {
  for (const p of cleanupPaths.splice(0)) {
    try {
      if (existsSync(p)) unlinkSync(p)
    } catch {
      /* ignore */
    }
  }
})

const noopApi: TribeClientApi = {
  send() {},
  broadcast() {},
  claimDedup: () => true,
  hasRecentMessage: () => false,
  getActiveSessions: () => [],
  getSessionNames: () => [],
  hasChief: () => false,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createBaseTribe", () => {
  it("returns a value with scope, daemonSessionId, startedAt, daemonVersion, daemonPid", () => {
    const t = createBaseTribe()
    expect(t.scope).toBeDefined()
    expect(t.daemonSessionId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(t.startedAt).toBeGreaterThan(0)
    expect(t.daemonVersion).toBe("0.10.0")
    expect(t.daemonPid).toBe(process.pid)
  })

  it("accepts an override scope and version", () => {
    const scope = createScope("custom")
    const t = createBaseTribe({ scope, daemonVersion: "9.9.9" })
    expect(t.scope).toBe(scope)
    expect(t.daemonVersion).toBe("9.9.9")
  })
})

describe("withConfig", () => {
  it("accepts an override config to bypass argv parsing", () => {
    const override = {
      socketPath: "/tmp/test.sock",
      dbPath: "/tmp/test.db",
      loreDbPath: "/tmp/lore.db",
      quitTimeoutSec: 60,
      inheritFd: null,
      focusPollMs: 1000,
      summaryPollMs: 2000,
      summarizerMode: "off" as const,
      loreEnabled: false,
    }
    const t = pipe(createBaseTribe(), withConfig({ override }))
    expect(t.config).toEqual(override)
  })
})

describe("withProjectRoot", () => {
  it("defaults to process.cwd()", () => {
    const t = pipe(createBaseTribe(), withProjectRoot())
    expect(t.projectRoot).toBe(process.cwd())
  })

  it("accepts an explicit root", () => {
    const t = pipe(createBaseTribe(), withProjectRoot("/some/path"))
    expect(t.projectRoot).toBe("/some/path")
  })
})

describe("withDatabase", () => {
  it("opens the db, exposes prepared statements, registers close on scope", async () => {
    const dbPath = tmpDb()
    const t = pipe(
      createBaseTribe(),
      withConfig({
        override: {
          socketPath: "/tmp/x.sock",
          dbPath,
          loreDbPath: tmpDb(),
          quitTimeoutSec: 60,
          inheritFd: null,
          focusPollMs: 1000,
          summaryPollMs: 2000,
          summarizerMode: "off",
          loreEnabled: false,
        },
      }),
      withDatabase(),
    )
    expect(t.db).toBeDefined()
    expect(t.stmts.claimDedup).toBeDefined()
    // Sanity: a statement runs.
    const row = t.db.prepare("SELECT 1 as one").get() as { one: number }
    expect(row.one).toBe(1)

    // Closing the scope closes the db (closed db throws on prepare).
    await t.scope[Symbol.asyncDispose]()
    expect(() => t.db.prepare("SELECT 1")).toThrow()
  })
})

describe("withDaemonContext", () => {
  it("creates a daemon-role TribeContext bound to the daemon's sessionId", async () => {
    const t = pipe(
      createBaseTribe(),
      withConfig({
        override: {
          socketPath: "/tmp/x.sock",
          dbPath: tmpDb(),
          loreDbPath: tmpDb(),
          quitTimeoutSec: 60,
          inheritFd: null,
          focusPollMs: 1000,
          summaryPollMs: 2000,
          summarizerMode: "off",
          loreEnabled: false,
        },
      }),
      withDatabase(),
      withDaemonContext(),
    )
    expect(t.daemonCtx).toBeDefined()
    expect(t.daemonCtx.sessionId).toBe(t.daemonSessionId)
    expect(t.daemonCtx.getRole()).toBe("daemon")
    expect(t.daemonCtx.getName()).toBe("daemon")
    await t.scope[Symbol.asyncDispose]()
  })
})

describe("withLore", () => {
  it("returns lore=null when loreEnabled=false", async () => {
    const t = pipe(
      createBaseTribe(),
      withConfig({
        override: {
          socketPath: "/tmp/x.sock",
          dbPath: tmpDb(),
          loreDbPath: tmpDb(),
          quitTimeoutSec: 60,
          inheritFd: null,
          focusPollMs: 1000,
          summaryPollMs: 2000,
          summarizerMode: "off",
          loreEnabled: false,
        },
      }),
      withLore(),
    )
    expect(t.lore).toBeNull()
    await t.scope[Symbol.asyncDispose]()
  })
})

describe("messagingTools()", () => {
  it("returns one tool per TRIBE_COORD method", () => {
    const tools = messagingTools()
    expect(tools.length).toBe(MESSAGING_TOOL_NAMES.length)
    const names = new Set(tools.map((t) => t.name))
    for (const expected of MESSAGING_TOOL_NAMES) {
      expect(names.has(expected)).toBe(true)
    }
    // Every tool name uses the tribe.* prefix.
    for (const t of tools) {
      expect(t.name.startsWith("tribe.")).toBe(true)
    }
  })

  it("populates the registry without duplicates", () => {
    const t = pipe(createBaseTribe(), withTools<ReturnType<typeof createBaseTribe>>(), withTool(messagingTools()))
    expect(t.tools.size).toBe(MESSAGING_TOOL_NAMES.length)
  })
})

describe("loreTools()", () => {
  it("produces tools that delegate to LoreHandlers.dispatch", async () => {
    const dispatched: Array<{ method: string; params: Record<string, unknown> }> = []
    const fakeLore = {
      isLoreMethod: () => true,
      dispatch: async (_conn: unknown, method: string, params: Record<string, unknown>) => {
        dispatched.push({ method, params })
        return { ok: true, method }
      },
      dropConn: () => {},
      close: async () => {},
      dbPath: "/tmp/x.db",
      startedAt: Date.now(),
      daemonVersion: "test",
    }
    const tools = loreTools(fakeLore)
    expect(tools.length).toBeGreaterThan(0)
    const ask = tools.find((t) => t.name === "tribe.ask")
    expect(ask).toBeDefined()
    const result = await ask!.handler({ query: "hi" }, { extra: { conn: { sessionId: null, claudePid: null } } })
    expect(result).toEqual({ ok: true, method: "tribe.ask" })
    expect(dispatched[0]?.method).toBe("tribe.ask")
  })
})

describe("withPluginApi + withPlugin", () => {
  it("starts available plugins and registers cleanup on scope", async () => {
    const events: string[] = []
    const plugin: TribePluginApi = {
      name: "test-plugin",
      available: () => true,
      start: () => {
        events.push("start")
        return () => events.push("stop")
      },
    }
    const t = pipe(createBaseTribe(), withPluginApi(noopApi), withPlugin(plugin))
    expect(events).toEqual(["start"])
    expect(t.pluginHandles).toEqual([{ name: "test-plugin", active: true }])
    await t.scope[Symbol.asyncDispose]()
    expect(events).toEqual(["start", "stop"])
  })

  it("skips plugins that report !available()", () => {
    const plugin: TribePluginApi = {
      name: "absent-plugin",
      available: () => false,
      start: () => {
        throw new Error("should not start")
      },
    }
    const t = pipe(createBaseTribe(), withPluginApi(noopApi), withPlugin(plugin))
    expect(t.pluginHandles).toEqual([{ name: "absent-plugin", active: false }])
  })

  it("preserves registration order across multiple withPlugin calls", () => {
    const order: string[] = []
    const make = (name: string): TribePluginApi => ({
      name,
      available: () => true,
      start: () => {
        order.push(name)
      },
    })
    const t = pipe(
      createBaseTribe(),
      withPluginApi(noopApi),
      withPlugin(make("a")),
      withPlugin(make("b")),
      withPlugin(make("c")),
    )
    expect(order).toEqual(["a", "b", "c"])
    expect(t.pluginHandles.map((p) => p.name)).toEqual(["a", "b", "c"])
  })
})

describe("end-to-end pipe — boot order", () => {
  it("composes base → config → projectRoot → db → ctx → lore (off) → tools → tools[messaging] → pluginApi", async () => {
    const tribe = pipe(
      createBaseTribe({ daemonVersion: "test" }),
      withConfig({
        override: {
          socketPath: "/tmp/x.sock",
          dbPath: tmpDb(),
          loreDbPath: tmpDb(),
          quitTimeoutSec: 60,
          inheritFd: null,
          focusPollMs: 1000,
          summaryPollMs: 2000,
          summarizerMode: "off",
          loreEnabled: false,
        },
      }),
      withProjectRoot("/test/root"),
      withDatabase(),
      withDaemonContext(),
      withLore(),
      withTools(),
      withTool(messagingTools()),
      withPluginApi(noopApi),
    )

    // Type-driven layout — each capability is present and well-typed.
    expect(tribe.daemonVersion).toBe("test")
    expect(tribe.projectRoot).toBe("/test/root")
    expect(tribe.db).toBeDefined()
    expect(tribe.daemonCtx.getRole()).toBe("daemon")
    expect(tribe.lore).toBeNull()
    expect(tribe.tools.size).toBe(MESSAGING_TOOL_NAMES.length)
    expect(tribe.pluginApi).toBe(noopApi)

    // Disposal cascades — db closes on scope dispose.
    await tribe.scope[Symbol.asyncDispose]()
    expect(() => tribe.db.prepare("SELECT 1")).toThrow()
  })
})
