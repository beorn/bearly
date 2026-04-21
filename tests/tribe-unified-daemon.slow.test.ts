/**
 * Unified daemon — km-bear.unified-daemon Phase 5a smoke tests.
 *
 * The tribe daemon absorbs the former standalone lore daemon's RPC surface
 * (tribe.ask / tribe.brief / tribe.plan / tribe.session* / tribe.workspace /
 * tribe.inject_delta / tribe.status). These tests spawn a real tribe-daemon
 * subprocess on a tmp socket + dbs and assert the lore wire protocol is
 * reachable via the same socket as the coordination protocol.
 *
 * Intentionally narrow: no LLM calls (would be slow + non-deterministic).
 * We exercise the handlers that don't depend on external services:
 *   - tribe.hello (handshake)
 *   - tribe.status
 *   - tribe.sessions_list / tribe.workspace (empty + after register)
 *   - tribe.session_register / tribe.session_heartbeat / tribe.session
 *   - tribe.inject_delta (short prompt → skipped)
 *
 * tribe.ask / tribe.plan / tribe.brief run the recall agent / planner /
 * session-context functions — those are covered by the existing lore
 * suites and the plugins/tribe/tests/lore-server integration. The goal
 * here is only to prove that the unified socket speaks both dialects.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { connectToDaemon, type DaemonClient } from "../tools/lib/tribe/socket.ts"
import {
  TRIBE_METHODS,
  LORE_PROTOCOL_VERSION,
  type HelloResult,
  type InjectDeltaResult,
  type SessionHeartbeatResult,
  type SessionRegisterResult,
  type SessionsListResult,
  type StatusResult,
  type WorkspaceStateResult,
} from "../plugins/tribe/lore/lib/rpc.ts"

const DAEMON_SCRIPT = resolve(dirname(new URL(import.meta.url).pathname), "../tools/tribe-daemon.ts")

async function waitFor(fn: () => boolean | Promise<boolean>, timeout = 8000, interval = 50): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`waitFor timed out after ${timeout}ms`)
}

async function spawnDaemon(socketPath: string, dbPath: string, loreDbPath: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [DAEMON_SCRIPT, "--socket", socketPath, "--db", dbPath, "--lore-db", loreDbPath, "--quit-timeout", "-1"],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        TRIBE_DB: dbPath,
        TRIBE_NO_SUPPRESS: "1",
        TRIBE_NO_PLUGINS: "1",
        TRIBE_ACTIVITY_LOG: "off",
        // No summarizer — tests must not call LLMs.
        TRIBE_SUMMARIZER_MODEL: "off",
      },
    },
  )
  await waitFor(() => existsSync(socketPath), 8000)
  return child
}

async function killDaemon(proc: ChildProcess | null): Promise<void> {
  if (proc?.exitCode !== null) return
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

function unlinkIfExists(p: string): void {
  if (!existsSync(p)) return
  try {
    unlinkSync(p)
  } catch {
    /* ignore */
  }
}

describe("unified daemon — lore RPC surface on the tribe socket", () => {
  let tmpDir: string
  let socketPath: string
  let dbPath: string
  let loreDbPath: string
  let daemon: ChildProcess | null = null
  const clients: DaemonClient[] = []

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-unified-"))
    socketPath = join(tmpDir, "tribe.sock")
    dbPath = join(tmpDir, "tribe.db")
    loreDbPath = join(tmpDir, "lore.db")
    daemon = null
  })

  afterEach(async () => {
    for (const c of clients.splice(0)) {
      try {
        c.close()
      } catch {
        /* ignore */
      }
    }
    await killDaemon(daemon)
    daemon = null
    unlinkIfExists(socketPath)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  async function connect(): Promise<DaemonClient> {
    const c = await connectToDaemon(socketPath)
    clients.push(c)
    return c
  }

  it("handshake — tribe.hello returns protocol version + daemon pid", async () => {
    daemon = await spawnDaemon(socketPath, dbPath, loreDbPath)
    const c = await connect()
    const hello = (await c.call(TRIBE_METHODS.hello, {
      clientName: "unified-daemon-smoke",
      clientVersion: "0.0.0",
      protocolVersion: LORE_PROTOCOL_VERSION,
    })) as HelloResult
    expect(hello.protocolVersion).toBe(LORE_PROTOCOL_VERSION)
    expect(typeof hello.daemonPid).toBe("number")
    expect(hello.daemonPid).toBe(daemon.pid)
  }, 20_000)

  it("tribe.status reports the lore db path we passed via --lore-db", async () => {
    daemon = await spawnDaemon(socketPath, dbPath, loreDbPath)
    const c = await connect()
    await c.call(TRIBE_METHODS.hello, {
      clientName: "unified-daemon-smoke",
      clientVersion: "0.0.0",
      protocolVersion: LORE_PROTOCOL_VERSION,
    })
    const status = (await c.call(TRIBE_METHODS.status, {})) as StatusResult
    expect(status.dbPath).toBe(loreDbPath)
    expect(status.socketPath).toBe(socketPath)
    expect(status.sessionCount).toBe(0)
  }, 20_000)

  it("session_register → sessions_list → workspace all agree on one alive session", async () => {
    daemon = await spawnDaemon(socketPath, dbPath, loreDbPath)
    const c = await connect()
    await c.call(TRIBE_METHODS.hello, {
      clientName: "unified-daemon-smoke",
      clientVersion: "0.0.0",
      protocolVersion: LORE_PROTOCOL_VERSION,
    })

    const sid = "11111111-2222-3333-4444-555555555555"
    const reg = (await c.call(TRIBE_METHODS.sessionRegister, {
      claudePid: 99999,
      sessionId: sid,
      transcriptPath: "/nonexistent/transcript.jsonl",
      cwd: "/tmp",
      project: "unified-smoke",
    })) as SessionRegisterResult
    expect(reg.ok).toBe(true)

    const hb = (await c.call(TRIBE_METHODS.sessionHeartbeat, {
      claudePid: 99999,
      sessionId: sid,
    })) as SessionHeartbeatResult
    expect(hb.ok).toBe(true)

    const list = (await c.call(TRIBE_METHODS.sessionsList, {})) as SessionsListResult
    expect(list.sessions).toHaveLength(1)
    expect(list.sessions[0]?.sessionId).toBe(sid)

    const workspace = (await c.call(TRIBE_METHODS.workspaceState, {})) as WorkspaceStateResult
    expect(workspace.sessions).toHaveLength(1)
    expect(workspace.sessions[0]?.sessionId).toBe(sid)
  }, 20_000)

  it("inject_delta on an empty prompt is reported as skipped (not errored)", async () => {
    daemon = await spawnDaemon(socketPath, dbPath, loreDbPath)
    const c = await connect()
    await c.call(TRIBE_METHODS.hello, {
      clientName: "unified-daemon-smoke",
      clientVersion: "0.0.0",
      protocolVersion: LORE_PROTOCOL_VERSION,
    })

    const out = (await c.call(TRIBE_METHODS.injectDelta, {
      prompt: "",
      sessionId: "smoke-session",
    })) as InjectDeltaResult
    expect(out.skipped).toBe(true)
    // Reason is one of the documented InjectSkipReason values — don't pin to
    // the exact string here, just that the daemon didn't throw.
    expect(typeof out.reason).toBe("string")
  }, 20_000)

  it("tribe coord + lore RPCs share one socket — both succeed in the same session", async () => {
    daemon = await spawnDaemon(socketPath, dbPath, loreDbPath)
    const c = await connect()

    // Tribe coord register (different from lore's session_register)
    const reg = (await c.call("register", { name: "unified-smoke-alice", role: "member" })) as Record<string, unknown>
    expect(typeof reg.sessionId).toBe("string")

    // Lore hello on the same connection
    const hello = (await c.call(TRIBE_METHODS.hello, {
      clientName: "unified-daemon-smoke",
      clientVersion: "0.0.0",
      protocolVersion: LORE_PROTOCOL_VERSION,
    })) as HelloResult
    expect(hello.protocolVersion).toBe(LORE_PROTOCOL_VERSION)

    // Tribe coord status and lore status both reachable
    const daemonInfo = (await c.call("cli_daemon")) as Record<string, unknown>
    expect(typeof daemonInfo.pid).toBe("number")

    const loreStatus = (await c.call(TRIBE_METHODS.status, {})) as StatusResult
    expect(loreStatus.daemonPid).toBe(daemon.pid)
  }, 20_000)
})
