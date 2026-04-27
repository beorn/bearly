/**
 * tribe-daemon-boot — pipe(...) composition end-to-end test.
 *
 * Asserts that bootTribeDaemon() assembles a fully-wired daemon value with
 * the messaging + lore tool registry, observer plugin handles, and a Scope
 * that cascades cleanup of every resource on dispose.
 *
 * This is the "factory IS the architecture" test: read the boot file
 * top-to-bottom, run this test, and the assertions match the reading.
 */

import { afterEach, describe, expect, it } from "vitest"
import { existsSync, unlinkSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { bootTribeDaemon } from "../tools/tribe-daemon-boot.ts"
import { MESSAGING_TOOL_NAMES } from "../tools/lib/tribe/compose/index.ts"
import type { TribeClientApi } from "../tools/lib/tribe/plugin-api.ts"

const cleanupPaths: string[] = []
function tmpDb(): string {
  const path = `/tmp/tribe-boot-test-${randomUUID().slice(0, 8)}.db`
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

describe("bootTribeDaemon", () => {
  it("composes a fully-wired daemon value via pipe(...)", async () => {
    const tribe = bootTribeDaemon({
      pluginApi: noopApi,
      noPlugins: true,
      configOverride: {
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
    })

    // Top-down reads as architecture: every layer is present and well-typed.
    expect(tribe.scope).toBeDefined()
    expect(tribe.daemonSessionId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(tribe.config.socketPath).toBe("/tmp/x.sock")
    expect(tribe.projectRoot).toBe(process.cwd())
    expect(tribe.db).toBeDefined()
    expect(tribe.daemonCtx.getRole()).toBe("daemon")
    expect(tribe.lore).toBeNull() // loreEnabled=false
    expect(tribe.tools).toBeInstanceOf(Map)
    expect(tribe.tools.size).toBe(MESSAGING_TOOL_NAMES.length)
    expect(tribe.pluginApi).toBe(noopApi)
    expect(tribe.pluginHandles).toEqual([]) // noPlugins=true

    // Scope cascade: closing the root closes the db.
    await tribe.scope[Symbol.asyncDispose]()
    expect(() => tribe.db.prepare("SELECT 1")).toThrow()
  })

  it("registers lore tools when lore is enabled", async () => {
    const tribe = bootTribeDaemon({
      pluginApi: noopApi,
      noPlugins: true,
      configOverride: {
        socketPath: "/tmp/x.sock",
        dbPath: tmpDb(),
        loreDbPath: tmpDb(),
        quitTimeoutSec: 60,
        inheritFd: null,
        focusPollMs: 60_000,
        summaryPollMs: 120_000,
        summarizerMode: "off",
        loreEnabled: true,
      },
    })

    expect(tribe.lore).not.toBeNull()
    // Lore methods are registered alongside messaging methods.
    expect(tribe.tools.has("tribe.send")).toBe(true) // messaging
    expect(tribe.tools.has("tribe.ask")).toBe(true) // lore
    expect(tribe.tools.has("tribe.brief")).toBe(true) // lore
    expect(tribe.tools.size).toBeGreaterThan(MESSAGING_TOOL_NAMES.length)

    await tribe.scope[Symbol.asyncDispose]()
  })

  it("messaging + lore tool names share the tribe.* prefix", async () => {
    const tribe = bootTribeDaemon({
      pluginApi: noopApi,
      noPlugins: true,
      configOverride: {
        socketPath: "/tmp/x.sock",
        dbPath: tmpDb(),
        loreDbPath: tmpDb(),
        quitTimeoutSec: 60,
        inheritFd: null,
        focusPollMs: 60_000,
        summaryPollMs: 120_000,
        summarizerMode: "off",
        loreEnabled: true,
      },
    })

    for (const name of tribe.tools.keys()) {
      expect(name.startsWith("tribe.")).toBe(true)
    }

    await tribe.scope[Symbol.asyncDispose]()
  })
})
