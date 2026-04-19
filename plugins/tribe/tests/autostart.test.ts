/**
 * Tests for the autostart helpers — config read/write, liveness probe, and
 * the ensureDaemonIfConfigured orchestration. All tests work against fixture
 * directories and injected dependencies; nothing spawns a real daemon.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server as NetServer } from "node:net"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import {
  DEFAULT_AUTOSTART,
  resolveAutostart,
  readTribeConfig,
  writeTribeConfig,
} from "../../../tools/lib/tribe/autostart-config.ts"
import {
  ensureAllDaemonsIfConfigured,
  ensureDaemonIfConfigured,
  ensureTribeDaemonIfConfigured,
  isDaemonAlive,
  resolveDaemonScriptPath,
  resolveTribeDaemonScriptPath,
  type SpawnResult,
} from "../../../tools/lib/tribe/autostart.ts"

function makeTmp(): string {
  return mkdtempSync(resolve(tmpdir(), "tribe-autostart-test-"))
}

// Clear TRIBE_NO_DAEMON in each test so env doesn't leak across them.
const originalEnv = process.env.TRIBE_NO_DAEMON
beforeEach(() => {
  delete process.env.TRIBE_NO_DAEMON
})
afterEach(() => {
  if (originalEnv === undefined) delete process.env.TRIBE_NO_DAEMON
  else process.env.TRIBE_NO_DAEMON = originalEnv
})

describe("readTribeConfig / writeTribeConfig", () => {
  let dir: string
  beforeEach(() => {
    dir = makeTmp()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("round-trips all three modes", () => {
    const path = resolve(dir, "cfg/config.json")
    for (const mode of ["daemon", "library", "never"] as const) {
      writeTribeConfig(path, { autostart: mode })
      expect(readTribeConfig(path).autostart).toBe(mode)
    }
  })

  test("missing file → default", () => {
    expect(readTribeConfig(resolve(dir, "missing.json")).autostart).toBe(DEFAULT_AUTOSTART)
  })

  test("writeTribeConfig rejects invalid mode", () => {
    expect(() => writeTribeConfig(resolve(dir, "x.json"), { autostart: "xxx" as never })).toThrow()
  })
})

describe("resolveAutostart", () => {
  let dir: string
  beforeEach(() => {
    dir = makeTmp()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("env override → library", () => {
    const path = resolve(dir, "config.json")
    writeTribeConfig(path, { autostart: "daemon" })
    process.env.TRIBE_NO_DAEMON = "1"
    expect(resolveAutostart(path)).toBe("library")
  })

  test("file > default", () => {
    const path = resolve(dir, "config.json")
    writeTribeConfig(path, { autostart: "never" })
    expect(resolveAutostart(path)).toBe("never")
  })

  test("no file → default", () => {
    expect(resolveAutostart(resolve(dir, "missing.json"))).toBe(DEFAULT_AUTOSTART)
  })
})

describe("isDaemonAlive", () => {
  let dir: string
  beforeEach(() => {
    dir = makeTmp()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("returns false for a non-existent socket", async () => {
    const alive = await isDaemonAlive(resolve(dir, "no-such.sock"), 100)
    expect(alive).toBe(false)
  })

  test("returns false for a stale socket file with no listener", async () => {
    const socketPath = resolve(dir, "stale.sock")
    writeFileSync(socketPath, "") // leftover file, nothing bound
    const alive = await isDaemonAlive(socketPath, 100)
    expect(alive).toBe(false)
  })

  test("returns true when a server is listening on the socket", async () => {
    const socketPath = resolve(dir, "alive.sock")
    const server: NetServer = createServer()
    await new Promise<void>((res) => server.listen(socketPath, res))
    try {
      const alive = await isDaemonAlive(socketPath, 500)
      expect(alive).toBe(true)
    } finally {
      await new Promise<void>((res) => server.close(() => res()))
    }
  })
})

describe("ensureDaemonIfConfigured", () => {
  test("library mode is a no-op", async () => {
    let spawned = 0
    const outcome = await ensureDaemonIfConfigured({
      resolveMode: () => "library",
      spawn: () => {
        spawned++
        return { ok: true, pid: 1 }
      },
    })
    expect(outcome.action).toBe("noop")
    expect(spawned).toBe(0)
  })

  test("never mode is a no-op even when daemon is dead", async () => {
    let spawned = 0
    const outcome = await ensureDaemonIfConfigured({
      resolveMode: () => "never",
      probe: async () => false,
      spawn: () => {
        spawned++
        return { ok: true, pid: 1 }
      },
    })
    expect(outcome.action).toBe("noop")
    if (outcome.action === "noop") expect(outcome.reason).toBe("never-mode")
    expect(spawned).toBe(0)
  })

  test("TRIBE_NO_DAEMON=1 short-circuits via resolveAutostart default", async () => {
    process.env.TRIBE_NO_DAEMON = "1"
    let spawned = 0
    // Use the real resolveAutostart (no resolveMode override) to prove the
    // env var is the authoritative gate.
    const outcome = await ensureDaemonIfConfigured({
      resolveSocketPath: () => "/tmp/nope.sock",
      probe: async () => false,
      spawn: () => {
        spawned++
        return { ok: true, pid: 1 }
      },
    })
    expect(outcome.action).toBe("noop")
    expect(spawned).toBe(0)
  })

  test("spawns daemon when mode=daemon and probe reports dead", async () => {
    let spawned = 0
    const outcome = await ensureDaemonIfConfigured({
      resolveMode: () => "daemon",
      resolveSocketPath: () => "/tmp/test-autostart.sock",
      probe: async () => false,
      spawn: ({ socketPath }) => {
        spawned++
        expect(socketPath).toBe("/tmp/test-autostart.sock")
        return { ok: true, pid: 12345 } satisfies SpawnResult
      },
    })
    expect(outcome.action).toBe("spawned")
    if (outcome.action === "spawned") expect(outcome.pid).toBe(12345)
    expect(spawned).toBe(1)
  })

  test("does not spawn when probe reports alive", async () => {
    let spawned = 0
    const outcome = await ensureDaemonIfConfigured({
      resolveMode: () => "daemon",
      resolveSocketPath: () => "/tmp/alive.sock",
      probe: async () => true,
      spawn: () => {
        spawned++
        return { ok: true, pid: 1 }
      },
    })
    expect(outcome.action).toBe("noop")
    if (outcome.action === "noop") expect(outcome.reason).toBe("already-alive")
    expect(spawned).toBe(0)
  })

  test("propagates spawn failure as structured outcome, never throws", async () => {
    const outcome = await ensureDaemonIfConfigured({
      resolveMode: () => "daemon",
      resolveSocketPath: () => "/tmp/dead.sock",
      probe: async () => false,
      spawn: () => ({ ok: false, error: "boom" }) satisfies SpawnResult,
    })
    expect(outcome.action).toBe("spawn-failed")
    if (outcome.action === "spawn-failed") expect(outcome.error).toBe("boom")
  })

  test("hook never crashes if probe throws", async () => {
    const outcome = await ensureDaemonIfConfigured({
      resolveMode: () => "daemon",
      resolveSocketPath: () => "/tmp/thrower.sock",
      probe: async () => {
        throw new Error("probe failure")
      },
      spawn: () => ({ ok: true, pid: 7 }),
    })
    // Treats thrown probe as "dead", proceeds to spawn
    expect(outcome.action).toBe("spawned")
  })
})

describe("ensureTribeDaemonIfConfigured", () => {
  test("spawns tribe daemon when dead", async () => {
    let spawned = 0
    const outcome = await ensureTribeDaemonIfConfigured({
      resolveMode: () => "daemon",
      resolveSocketPath: () => "/tmp/tribe-test.sock",
      probe: async () => false,
      spawn: ({ socketPath }) => {
        spawned++
        expect(socketPath).toBe("/tmp/tribe-test.sock")
        return { ok: true, pid: 54321 } satisfies SpawnResult
      },
    })
    expect(outcome.action).toBe("spawned")
    if (outcome.action === "spawned") expect(outcome.pid).toBe(54321)
    expect(spawned).toBe(1)
  })

  test("library mode is a no-op", async () => {
    let spawned = 0
    const outcome = await ensureTribeDaemonIfConfigured({
      resolveMode: () => "library",
      spawn: () => {
        spawned++
        return { ok: true, pid: 1 }
      },
    })
    expect(outcome.action).toBe("noop")
    expect(spawned).toBe(0)
  })
})

describe("resolveDaemonScriptPath variants", () => {
  // km-bear.unified-daemon Phase 5c: the standalone lore daemon was deleted.
  // Both names now resolve to tools/tribe-daemon.ts — the legacy alias is
  // kept only so external importers don't break.
  test("both names resolve to the unified tribe-daemon script", () => {
    const lore = resolveDaemonScriptPath()
    const tribe = resolveTribeDaemonScriptPath()
    expect(lore).toBe(tribe)
    expect(tribe.endsWith("tools/tribe-daemon.ts")).toBe(true)
  })
})

describe("ensureAllDaemonsIfConfigured", () => {
  // Phase 5c: there's only one daemon now. The "all" variant still returns
  // `{ lore, tribe }` for back-compat, but both fields carry the same
  // outcome — a single spawn call covers both surfaces.
  test("spawns the unified daemon once when dead; same outcome under both keys", async () => {
    const spawnedSockets: string[] = []
    const result = await ensureAllDaemonsIfConfigured({
      resolveMode: () => "daemon",
      probe: async () => false,
      spawn: ({ socketPath }) => {
        spawnedSockets.push(socketPath)
        return { ok: true, pid: spawnedSockets.length } satisfies SpawnResult
      },
    })
    expect(result.lore.action).toBe("spawned")
    expect(result.tribe.action).toBe("spawned")
    expect(spawnedSockets).toHaveLength(1)
    expect(result.lore).toStrictEqual(result.tribe)
  })

  test("library mode short-circuits both", async () => {
    let spawned = 0
    const result = await ensureAllDaemonsIfConfigured({
      resolveMode: () => "library",
      spawn: () => {
        spawned++
        return { ok: true, pid: 1 }
      },
    })
    expect(result.lore.action).toBe("noop")
    expect(result.tribe.action).toBe("noop")
    expect(spawned).toBe(0)
  })

  test("does not spawn when the unified daemon is alive", async () => {
    let spawned = 0
    const result = await ensureAllDaemonsIfConfigured({
      resolveMode: () => "daemon",
      probe: async () => true,
      spawn: () => {
        spawned++
        return { ok: true, pid: 1 }
      },
    })
    expect(result.lore.action).toBe("noop")
    expect(result.tribe.action).toBe("noop")
    if (result.lore.action === "noop") expect(result.lore.reason).toBe("already-alive")
    if (result.tribe.action === "noop") expect(result.tribe.reason).toBe("already-alive")
    expect(spawned).toBe(0)
  })
})
