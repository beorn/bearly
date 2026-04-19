/**
 * Tribe session identity — stable identity across Claude Code restarts.
 *
 * Phase 1.5 of km-tribe.plateau (km-tribe.session-identity).
 *
 * The proxy hashes (claude_session_id, project_path, role_hint) → 16-char hex
 * token and sends it on `register`. The daemon, on seeing that token match a
 * non-active prior session, adopts its sessionId + name + role + cursor.
 *
 * Each test spawns a real tribe-daemon.ts subprocess on a hermetic tmp socket
 * + DB and exercises the invariants via JSON-RPC. Cleanup is aggressive:
 * SIGKILL any straggler daemon, close every client, unlink every tmp path.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { connectToDaemon, type DaemonClient } from "../tools/lib/tribe/socket.ts"

// ---------------------------------------------------------------------------
// Constants & helpers
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

async function spawnDaemon(socketPath: string, dbPath: string, extra: string[] = []): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [DAEMON_SCRIPT, "--socket", socketPath, "--db", dbPath, "--quit-timeout", "-1", ...extra],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        TRIBE_DB: dbPath,
        TRIBE_NO_SUPPRESS: "1",
        TRIBE_NO_PLUGINS: "1",
      },
    },
  )
  await waitFor(() => existsSync(socketPath), 8000)
  return child
}

async function waitForDaemonExit(proc: ChildProcess, timeout = 5000): Promise<void> {
  await new Promise<void>((res) => {
    if (proc.exitCode !== null) return res()
    const to = setTimeout(() => res(), timeout)
    proc.once("exit", () => {
      clearTimeout(to)
      res()
    })
  })
}

async function killDaemon(proc: ChildProcess | null): Promise<void> {
  if (!proc) return
  if (proc.exitCode !== null) return
  try {
    proc.kill("SIGKILL")
  } catch {
    /* ignore */
  }
  await waitForDaemonExit(proc, 3000)
}

function unlinkIfExists(p: string): void {
  if (!existsSync(p)) return
  try {
    unlinkSync(p)
  } catch {
    /* ignore */
  }
}

type ParsedToolText = Record<string, unknown>

function parseToolText(result: unknown): ParsedToolText {
  const content = (result as { content?: Array<{ text: string }> } | undefined)?.content
  const text = content?.[0]?.text
  if (typeof text !== "string") throw new Error(`Tool response missing .content[0].text: ${JSON.stringify(result)}`)
  return JSON.parse(text) as ParsedToolText
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

describe("tribe session identity (identity token adoption)", () => {
  let tmpDir: string
  let socketPath: string
  let dbPath: string
  let daemon: ChildProcess | null = null
  const clients: DaemonClient[] = []

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-identity-"))
    socketPath = join(tmpDir, "tribe.sock")
    dbPath = join(tmpDir, "tribe.db")
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

  // =========================================================================
  // Test A — adoption across restart: same token → same sessionId/name/role
  // =========================================================================

  it(
    "A: reconnecting proxy with same identity token adopts prior sessionId, name, and role",
    async () => {
      daemon = await spawnDaemon(socketPath, dbPath)

      const token = "abc123def4567890"

      // Client 1 registers explicitly; captures sessionId.
      const c1 = await connect()
      const reg1 = (await c1.call("register", {
        identityToken: token,
        name: "alice",
        role: "member",
      })) as Record<string, unknown>
      const s1 = String(reg1.sessionId)
      expect(typeof s1).toBe("string")
      expect(reg1.name).toBe("alice")
      expect(reg1.role).toBe("member")

      // Disconnect client 1 and let the daemon process the close.
      c1.close()
      const idx = clients.indexOf(c1)
      if (idx !== -1) clients.splice(idx, 1)
      await new Promise((r) => setTimeout(r, 250))

      // Client 2 registers with only the token (no name, no role).
      // The daemon should adopt the prior row: same sessionId, name=alice, role=member.
      const c2 = await connect()
      const reg2 = (await c2.call("register", { identityToken: token })) as Record<string, unknown>
      expect(reg2.sessionId).toBe(s1)
      expect(reg2.name).toBe("alice")
      expect(reg2.role).toBe("member")
    },
    20_000,
  )

  // =========================================================================
  // Test B — active session blocks adoption
  // =========================================================================

  it(
    "B: when a session with the same identity token is still connected, a new proxy gets a fresh sessionId",
    async () => {
      daemon = await spawnDaemon(socketPath, dbPath)

      const token = "activeblockxxxxx"

      const c1 = await connect()
      const reg1 = (await c1.call("register", {
        identityToken: token,
        name: "alice",
        role: "member",
      })) as Record<string, unknown>
      const s1 = String(reg1.sessionId)

      // c1 stays connected.
      const c2 = await connect()
      const reg2 = (await c2.call("register", { identityToken: token })) as Record<string, unknown>
      expect(reg2.sessionId).not.toBe(s1)
      // The name should still be derived (project / deduplicated) — not silently
      // the same as c1's "alice". The daemon's deduplicateName gives it a suffix.
      expect(reg2.name).not.toBe("alice")
    },
    20_000,
  )

  // =========================================================================
  // Test C — cursor recovery via identity token
  // =========================================================================

  it(
    "C: identity-token reconnect recovers the message cursor so history is preserved",
    async () => {
      daemon = await spawnDaemon(socketPath, dbPath)

      const tokenBob = "cursortokenbobxx"

      // Alice joins (no token — she's just a message source).
      const alice = await connect()
      await alice.call("register", { name: "alice", role: "member" })

      // Bob joins with token, then disconnects.
      const bob1 = await connect()
      const regBob1 = (await bob1.call("register", {
        identityToken: tokenBob,
        name: "bob",
        role: "member",
      })) as Record<string, unknown>
      const sBob = String(regBob1.sessionId)

      // Alice broadcasts 5 messages.
      for (let i = 0; i < 5; i++) {
        await alice.call("tribe.broadcast", { message: `msg-${i}` })
      }

      // Bob disconnects.
      bob1.close()
      const bIdx = clients.indexOf(bob1)
      if (bIdx !== -1) clients.splice(bIdx, 1)
      await new Promise((r) => setTimeout(r, 250))

      // Bob reconnects with the same token — sessionId adopted, cursor recovered.
      const bob2 = await connect()
      const regBob2 = (await bob2.call("register", { identityToken: tokenBob })) as Record<string, unknown>
      expect(regBob2.sessionId).toBe(sBob)
      expect(regBob2.name).toBe("bob")

      // tribe.history for "bob" should include all 5 broadcasts (recipient='*').
      const history = parseToolText(await bob2.call("tribe.history", { limit: 50 }))
      const messages = (Array.isArray(history) ? history : (history.messages ?? history)) as Array<{
        content?: string
      }>
      expect(Array.isArray(messages)).toBe(true)
      const found = (n: number) => messages.some((m) => m.content === `msg-${n}`)
      for (let i = 0; i < 5; i++) {
        expect(found(i), `msg-${i} missing from history: ${JSON.stringify(messages).slice(0, 500)}`).toBe(true)
      }
    },
    25_000,
  )

  // =========================================================================
  // Test D — no token = today's behavior (fresh sessionId)
  // =========================================================================

  it(
    "D: without an identity token, each register gets a fresh sessionId",
    async () => {
      daemon = await spawnDaemon(socketPath, dbPath)

      const c1 = await connect()
      const reg1 = (await c1.call("register", { name: "alice", role: "member" })) as Record<string, unknown>
      const s1 = String(reg1.sessionId)

      c1.close()
      const idx = clients.indexOf(c1)
      if (idx !== -1) clients.splice(idx, 1)
      await new Promise((r) => setTimeout(r, 250))

      const c2 = await connect()
      const reg2 = (await c2.call("register", { name: "alice2", role: "member" })) as Record<string, unknown>
      expect(reg2.sessionId).not.toBe(s1)
    },
    20_000,
  )
})
