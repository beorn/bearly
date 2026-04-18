/**
 * Lore daemon — integration tests.
 *
 * Spawns a real daemon on a temp socket/db, exercises the RPC surface via
 * the canonical socket client, and cleans up. Slow (each spawn ~300ms) so
 * grouped into a single file with shared setup.
 */

import { describe, it, expect, afterEach } from "vitest"
import { randomUUID } from "node:crypto"
import { existsSync, unlinkSync } from "node:fs"
import { spawn, type ChildProcess } from "node:child_process"
import { resolve, dirname } from "node:path"
import { connectToDaemon, type LoreClient } from "../../plugins/tribe/lore/lib/socket.ts"
import {
  TRIBE_METHODS,
  LORE_PROTOCOL_VERSION,
  type HelloResult,
  type StatusResult,
  type SessionsListResult,
  type SessionRegisterResult,
  type SessionHeartbeatResult,
  type PlanOnlyResult,
  type InjectDeltaResult,
} from "../../plugins/tribe/lore/lib/rpc.ts"

const DAEMON_SCRIPT = resolve(dirname(new URL(import.meta.url).pathname), "../../plugins/tribe/lore/daemon.ts")

function tmpPath(suffix: string): string {
  return `/tmp/lore-test-${randomUUID().slice(0, 8)}.${suffix}`
}

async function waitFor(fn: () => boolean, timeoutMs = 5000, intervalMs = 30): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

type DaemonHarness = {
  child: ChildProcess
  socketPath: string
  dbPath: string
  client: LoreClient
  teardown: () => Promise<void>
}

async function spawnLoreDaemon(extraArgs: string[] = []): Promise<DaemonHarness> {
  const socketPath = tmpPath("sock")
  const dbPath = tmpPath("db")
  const child = spawn(
    process.execPath,
    [DAEMON_SCRIPT, "--socket", socketPath, "--db", dbPath, "--quit-timeout", "5", ...extraArgs],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, LORE_NO_DAEMON: "0" },
    },
  )
  child.stderr?.on("data", () => {
    /* swallow; enable if test debugging needed */
  })
  await waitFor(() => existsSync(socketPath))
  const client = await connectToDaemon(socketPath, { callTimeoutMs: 5000 })
  await client.call(TRIBE_METHODS.hello, {
    clientName: "test",
    clientVersion: "0.0.0",
    protocolVersion: LORE_PROTOCOL_VERSION,
  })
  return {
    child,
    socketPath,
    dbPath,
    client,
    async teardown() {
      client.close()
      if (!child.killed) {
        child.kill("SIGTERM")
        await new Promise<void>((r) => {
          child.once("exit", () => r())
          setTimeout(() => {
            child.kill("SIGKILL")
            r()
          }, 2000)
        })
      }
      for (const p of [socketPath, socketPath.replace(/\.sock$/, ".pid"), dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          if (existsSync(p)) unlinkSync(p)
        } catch {
          /* ignore */
        }
      }
    },
  }
}

// ---------------------------------------------------------------------------

describe("lore daemon — handshake", () => {
  let h: DaemonHarness | null = null
  afterEach(async () => {
    await h?.teardown()
    h = null
  })

  it("responds to hello with protocol + pid", async () => {
    h = await spawnLoreDaemon()
    const hello = (await h.client.call(TRIBE_METHODS.hello, {
      clientName: "t",
      clientVersion: "1",
      protocolVersion: LORE_PROTOCOL_VERSION,
    })) as HelloResult
    expect(hello.protocolVersion).toBe(LORE_PROTOCOL_VERSION)
    expect(hello.daemonPid).toBe(h.child.pid)
    expect(typeof hello.startedAt).toBe("number")
    expect(hello.daemonVersion).toMatch(/\d+\.\d+\.\d+/)
  })

  it("rejects unknown methods without crashing", async () => {
    h = await spawnLoreDaemon()
    await expect(h.client.call("lore.does_not_exist", {})).rejects.toThrow(/unknown method/i)
    // Daemon still alive
    const s = (await h.client.call(TRIBE_METHODS.status, {})) as StatusResult
    expect(s.daemonPid).toBe(h.child.pid)
  })
})

describe("lore daemon — session registration", () => {
  let h: DaemonHarness | null = null
  afterEach(async () => {
    await h?.teardown()
    h = null
  })

  it("registers, heartbeats, and lists sessions", async () => {
    h = await spawnLoreDaemon()
    const pid = 91234
    const sessionId = "deadbeef-1234-4567-8901-abcdef012345"
    const reg = (await h.client.call(TRIBE_METHODS.sessionRegister, {
      claudePid: pid,
      sessionId,
      transcriptPath: "/tmp/t.jsonl",
      cwd: "/tmp/work",
      project: "km",
    })) as SessionRegisterResult
    expect(reg.ok).toBe(true)
    expect(typeof reg.registeredAt).toBe("number")

    const hb = (await h.client.call(TRIBE_METHODS.sessionHeartbeat, {
      claudePid: pid,
    })) as SessionHeartbeatResult
    expect(hb.ok).toBe(true)
    expect(hb.lastSeen).toBeGreaterThanOrEqual(reg.registeredAt)

    const list = (await h.client.call(TRIBE_METHODS.sessionsList, {})) as SessionsListResult
    expect(list.sessions).toHaveLength(1)
    const row = list.sessions[0]!
    expect(row.claudePid).toBe(pid)
    expect(row.sessionId).toBe(sessionId)
    expect(row.cwd).toBe("/tmp/work")
    expect(row.project).toBe("km")
    expect(row.status).toBe("alive")
  })

  it("re-registration updates the existing row (no duplicates)", async () => {
    h = await spawnLoreDaemon()
    const pid = 99999
    await h.client.call(TRIBE_METHODS.sessionRegister, { claudePid: pid, sessionId: "sess-one", cwd: "/tmp/a" })
    await h.client.call(TRIBE_METHODS.sessionRegister, {
      claudePid: pid,
      sessionId: "sess-two",
      cwd: "/tmp/b",
      project: "other",
    })
    const list = (await h.client.call(TRIBE_METHODS.sessionsList, {})) as SessionsListResult
    expect(list.sessions).toHaveLength(1)
    const row = list.sessions[0]!
    expect(row.sessionId).toBe("sess-two")
    expect(row.cwd).toBe("/tmp/b")
    expect(row.project).toBe("other")
  })

  it("heartbeat for unknown pid returns ok=true (no crash, no fresh row)", async () => {
    h = await spawnLoreDaemon()
    const hb = (await h.client.call(TRIBE_METHODS.sessionHeartbeat, {
      claudePid: 77777,
    })) as SessionHeartbeatResult
    expect(hb.ok).toBe(true)
    const list = (await h.client.call(TRIBE_METHODS.sessionsList, {})) as SessionsListResult
    expect(list.sessions).toHaveLength(0)
  })
})

describe("lore daemon — status", () => {
  let h: DaemonHarness | null = null
  afterEach(async () => {
    await h?.teardown()
    h = null
  })

  it("reports socket, db, and alive session count", async () => {
    h = await spawnLoreDaemon()
    const s0 = (await h.client.call(TRIBE_METHODS.status, {})) as StatusResult
    expect(s0.sessionCount).toBe(0)
    expect(s0.socketPath).toBe(h.socketPath)
    expect(s0.dbPath).toBe(h.dbPath)

    await h.client.call(TRIBE_METHODS.sessionRegister, { claudePid: 1, sessionId: "s" })
    await h.client.call(TRIBE_METHODS.sessionRegister, { claudePid: 2, sessionId: "t" })
    const s1 = (await h.client.call(TRIBE_METHODS.status, {})) as StatusResult
    expect(s1.sessionCount).toBe(2)
  })
})

describe("lore daemon — inject_delta (Phase 5)", () => {
  let h: DaemonHarness | null = null
  afterEach(async () => {
    await h?.teardown()
    h = null
  })

  it("short-circuits short + slash-command + empty prompts", async () => {
    h = await spawnLoreDaemon()
    const shortPrompt = (await h.client.call(TRIBE_METHODS.injectDelta, {
      prompt: "ok",
      sessionId: "sess-a",
    })) as InjectDeltaResult
    expect(shortPrompt.skipped).toBe(true)
    expect(shortPrompt.reason).toBe("short")

    const slash = (await h.client.call(TRIBE_METHODS.injectDelta, {
      prompt: "/some-command with args",
      sessionId: "sess-a",
    })) as InjectDeltaResult
    expect(slash.skipped).toBe(true)
    expect(slash.reason).toBe("slash_command")

    const empty = (await h.client.call(TRIBE_METHODS.injectDelta, {
      prompt: "",
      sessionId: "sess-a",
    })) as InjectDeltaResult
    expect(empty.skipped).toBe(true)
    expect(empty.reason).toBe("empty")
  })

  it("keeps independent dedup state per sessionId", async () => {
    h = await spawnLoreDaemon()
    // Fire a substantive prompt against two different sessionIds. We don't
    // assert anything about returned snippets (depends on the recall index
    // in this test environment); we only check that the daemon stays alive
    // and keeps per-session turn counters separate.
    const r1 = (await h.client.call(TRIBE_METHODS.injectDelta, {
      prompt: "tell me about the lore workspace daemon plan",
      sessionId: "sess-A",
    })) as InjectDeltaResult
    const r2 = (await h.client.call(TRIBE_METHODS.injectDelta, {
      prompt: "tell me about the lore workspace daemon plan",
      sessionId: "sess-B",
    })) as InjectDeltaResult
    expect(r1.turnNumber).toBe(1)
    expect(r2.turnNumber).toBe(1)

    const r1b = (await h.client.call(TRIBE_METHODS.injectDelta, {
      prompt: "another substantive prompt for sess A only",
      sessionId: "sess-A",
    })) as InjectDeltaResult
    expect(r1b.turnNumber).toBe(2)

    const s = (await h.client.call(TRIBE_METHODS.status, {})) as StatusResult
    expect(s.daemonPid).toBe(h.child.pid)
  })

  it("advances the turn counter on every non-short-circuit call", async () => {
    h = await spawnLoreDaemon()
    const sessionId = "sess-ttl-" + Math.random().toString(36).slice(2, 8)
    // Fire 5 substantive prompts with a small ttlTurns so we exercise the
    // counter increments. We don't assert on seenCount contents — depends on
    // the recall corpus in this test env — only on turnNumber semantics.
    let lastTurn = 0
    for (let i = 1; i <= 5; i++) {
      const r = (await h.client.call(TRIBE_METHODS.injectDelta, {
        prompt: `substantive prompt number ${i} for ttl turn counter verification`,
        sessionId,
        ttlTurns: 3,
      })) as InjectDeltaResult
      expect(r.turnNumber).toBe(i)
      expect(r.turnNumber).toBeGreaterThan(lastTurn)
      lastTurn = r.turnNumber ?? 0
    }

    // Short-circuited prompts (empty, short, slash) do NOT advance the counter —
    // they fail-fast before the turn increment in the daemon handler.
    const shortPrompt = (await h.client.call(TRIBE_METHODS.injectDelta, {
      prompt: "y",
      sessionId,
    })) as InjectDeltaResult
    expect(shortPrompt.skipped).toBe(true)
    expect(shortPrompt.turnNumber).toBe(5) // unchanged from last non-short call
  })
})

describe("lore daemon — plan_only (no LLM)", () => {
  let h: DaemonHarness | null = null
  afterEach(async () => {
    await h?.teardown()
    h = null
  })

  it("returns ok:false with graceful error when no LLM provider is available", async () => {
    h = await spawnLoreDaemon()
    // With no ANTHROPIC_API_KEY or OPENAI_API_KEY etc. in the test env, the
    // planner should fall through cleanly. We just care that it doesn't crash
    // the daemon. Either ok:false or a library fallthrough is acceptable —
    // the contract is: the daemon stays alive and returns a structured result.
    const env = process.env
    const hadKeys = !!(
      env.ANTHROPIC_API_KEY ||
      env.OPENAI_API_KEY ||
      env.GEMINI_API_KEY ||
      env.XAI_API_KEY ||
      env.GROK_API_KEY
    )
    const result = (await h.client.call(TRIBE_METHODS.planOnly, { query: "some vague query" })) as PlanOnlyResult
    expect(typeof result.elapsedMs).toBe("number")
    if (!hadKeys) {
      expect(result.ok).toBe(false)
    } else {
      // With keys, either ok or structured error is fine — assert the shape
      expect(typeof result.ok).toBe("boolean")
    }
    // Daemon still alive
    const s = (await h.client.call(TRIBE_METHODS.status, {})) as StatusResult
    expect(s.daemonPid).toBe(h.child.pid)
  })
})
