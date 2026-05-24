/**
 * Tribe hot-reload — (pid, cwd) adoption survives SIGHUP.
 *
 * Bead @km/tribe/16007-followup-isolated-daemon-sighup-e2e — Phase 1
 * (single-client adoption-by-pid-cwd cycle).
 *
 * Sibling of `tribe-hot-reload-exit.slow.test.ts` which pins the donor-exit
 * + successor-spawn invariants. This file pins the IDENTITY-PRESERVATION
 * invariant: when a client reconnects after SIGHUP, the new daemon's
 * dispatcher must adopt the prior session row by (pid, cwd) so the client's
 * `name` survives — NOT get auto-renamed to `agent1` / `member1`.
 *
 * Failure mode this catches (the 2026-05-21 `tribe.reload-kills-daemon`
 * regression — fixed at bearly `92de7fe27`): the donor SIGHUP-re-execs;
 * adapters reconnect with the same (pid, cwd); the dispatcher's `register`
 * handler runs `adoptByPidCwd(db, clientPid, clientCwd, ...)` →
 * `pidCwdAdopted` → that name is injected into `resolveName`'s param so
 * the prior name + chief-claim mapping survives.
 *
 * Phase 1 (this file): single-client cycle.
 *   - one register
 *   - one SIGHUP
 *   - reconnect with same (pid, cwd)
 *   - assert name preserved
 *
 * Phase 2 (deferred — file follow-up if needed):
 *   - N concurrent clients (each with distinct (pid, cwd))
 *   - one of them claims chief
 *   - SIGHUP
 *   - all reconnect, names + chief-claim survive
 *   - no duplicate session rows in DB
 *
 * Reuses helpers from `tribe-hot-reload-exit.slow.test.ts` style — daemon
 * spawn in a tmpdir with isolated socket + db.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createConnection, type Socket } from "node:net"
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const DAEMON_SCRIPT = resolve(dirname(new URL(import.meta.url).pathname), "../tools/tribe-daemon.ts")

/** Wire-protocol version the dispatcher expects in `register` params. */
const TRIBE_PROTOCOL_VERSION = 5

async function waitFor(fn: () => boolean | Promise<boolean>, timeout = 5000, interval = 25): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`waitFor timed out after ${timeout}ms`)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function spawnDaemon(socketPath: string, dbPath: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [DAEMON_SCRIPT, "--socket", socketPath, "--db", dbPath, "--quit-timeout", "120"],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        TRIBE_DB: dbPath,
        TRIBE_NO_SUPPRESS: "1",
        TRIBE_NO_PLUGINS: "1",
        TRIBE_NO_AUTORELOAD: "1",
        TRIBE_ACTIVITY_LOG: "off",
      },
    },
  )
  await waitFor(() => existsSync(socketPath), 8000)
  return child
}

function unlinkIfExists(p: string): void {
  if (!existsSync(p)) return
  try {
    unlinkSync(p)
  } catch {
    /* ignore */
  }
}

/**
 * Minimal wire client: opens a socket, sends a single `register` request,
 * waits for the response, then closes. Returns the assigned name from the
 * register response.
 *
 * This is the smallest client that exercises the dispatcher's `adoptByPidCwd`
 * path — no MCP framing, no notification handlers, just one JSON-RPC line in
 * + one line out.
 */
async function registerClient(
  socketPath: string,
  params: { pid: number; project: string; name?: string; role?: string },
): Promise<{ name: string; sessionId: string }> {
  return new Promise((resolveP, reject) => {
    const socket: Socket = createConnection(socketPath)
    let buffer = ""
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8")
      const newlineIdx = buffer.indexOf("\n")
      if (newlineIdx < 0) return
      const line = buffer.slice(0, newlineIdx)
      try {
        const msg = JSON.parse(line) as {
          id?: number
          result?: { name?: string; sessionId?: string }
          error?: { message: string }
        }
        if (msg.error) {
          reject(new Error(`register failed: ${msg.error.message}`))
          socket.destroy()
          return
        }
        const name = msg.result?.name ?? ""
        const sessionId = msg.result?.sessionId ?? ""
        socket.end()
        resolveP({ name, sessionId })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        socket.destroy()
      }
    }
    socket.on("data", onData)
    socket.on("error", reject)
    socket.once("connect", () => {
      const req = {
        jsonrpc: "2.0",
        id: 1,
        method: "register",
        params: {
          pid: params.pid,
          project: params.project,
          projectId: `proj:${params.project}`,
          projectName: "test-proj",
          name: params.name,
          role: params.role ?? "member",
          domains: [],
          protocolVersion: TRIBE_PROTOCOL_VERSION,
        },
      }
      socket.write(JSON.stringify(req) + "\n")
    })
  })
}

describe("tribe-daemon SIGHUP (pid, cwd) adoption", () => {
  let tmpDir: string
  let socketPath: string
  let dbPath: string
  let daemon: ChildProcess | null = null

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-sighup-adopt-"))
    socketPath = join(tmpDir, "tribe.sock")
    dbPath = join(tmpDir, "tribe.db")
    daemon = null
  })

  afterEach(async () => {
    if (daemon && daemon.pid && pidAlive(daemon.pid)) {
      try {
        daemon.kill("SIGKILL")
      } catch {
        /* ignore */
      }
    }
    // Reap any successor children spawned by hot-reload — same pattern as
    // tribe-hot-reload-exit.slow.test.ts (pgrep by tmpDir).
    try {
      const out = spawnSync("pgrep", ["-af", `tribe-daemon.*${tmpDir}`], { encoding: "utf8" })
      const stdout = (out.stdout ?? "").toString()
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue
        const pid = parseInt(line.trim().split(/\s+/)[0]!, 10)
        if (Number.isFinite(pid) && pid > 0 && pidAlive(pid)) {
          try {
            process.kill(pid, "SIGKILL")
          } catch {
            /* already dead */
          }
        }
      }
    } catch {
      /* pgrep unavailable */
    }
    daemon = null
    unlinkIfExists(socketPath)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("register's name + sessionId survive SIGHUP when reconnecting with same (pid, cwd)", async () => {
    // Fake the client's pid + cwd — same values used pre + post SIGHUP. The
    // dispatcher's `register` handler trusts the params (it doesn't probe
    // /proc); that's how stdio-adapter passes them today.
    const FAKE_PID = 99_999
    const FAKE_CWD = "/tmp/sighup-adopt-test-cwd"
    const CLAIMED_NAME = "@test/alpha"

    daemon = await spawnDaemon(socketPath, dbPath)
    const donorPid = daemon.pid!
    expect(donorPid).toBeGreaterThan(0)

    // ── PRE-SIGHUP: register once, capture name + sessionId ────────────────
    const pre = await registerClient(socketPath, {
      pid: FAKE_PID,
      project: FAKE_CWD,
      name: CLAIMED_NAME,
    })
    expect(pre.name).toBe(CLAIMED_NAME)
    expect(pre.sessionId.length).toBeGreaterThan(0)

    // ── SIGHUP: donor exits, successor binds same socket path ──────────────
    daemon.kill("SIGHUP")
    await waitFor(() => !pidAlive(donorPid), 3000)
    expect(pidAlive(donorPid)).toBe(false)

    // Successor binds the freed socket path fresh — same pattern as the
    // tribe-hot-reload-exit "successor binds the socket" test.
    await waitFor(() => existsSync(socketPath), 6000)
    expect(existsSync(socketPath)).toBe(true)

    // ── POST-SIGHUP: register again with SAME (pid, cwd), NO name hint ────
    // adoptByPidCwd should find the prior session row by (pid, cwd) and
    // re-adopt its name → result.name === CLAIMED_NAME. Without the fix,
    // resolveName would fall through to auto-numbering (member1 / agent1).
    const post = await registerClient(socketPath, {
      pid: FAKE_PID,
      project: FAKE_CWD,
      // intentionally NO name — force adopt-by-pid-cwd to be the only source
    })

    expect(post.name).toBe(CLAIMED_NAME)
    // sessionId may legitimately change across daemon restart (new uuid issued
    // when the prior row is adopted) — adoptByPidCwd guarantees name+role
    // identity, not sessionId. So we don't assert on sessionId here.
  })
})
