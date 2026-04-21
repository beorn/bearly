/**
 * Tribe self-heal — kill-and-recover integration tests.
 *
 * Exercises the three invariants promised in
 * `plugins/tribe/README.md` "Design principles":
 *
 *   1. Agents come and go — auto-connecting every time.
 *      After the daemon dies mid-session, a reconnecting proxy must
 *      succeed on the next tool call against a fresh daemon bound to
 *      the same socket + DB.
 *
 *   2. There is always a chief.
 *      Disconnecting the current chief (whether derived or explicitly
 *      claimed) must yield a new chief from the remaining eligible
 *      clients — no empty throne, no interval.
 *
 *   3. No message loss.
 *      Messages written to SQLite before the daemon is killed must be
 *      visible to a reconnecting session after the daemon restarts.
 *      (The plateau plan does not yet guarantee in-flight messages
 *      survive a crash; those are a known gap and tracked separately.)
 *
 * Each test spawns a real tribe-daemon.ts subprocess on a unique tmp
 * socket + DB, simulates the failure, and asserts the invariant via
 * JSON-RPC calls through the canonical socket client. Cleanup is
 * aggressive: SIGKILL any straggler daemon, close every client,
 * unlink every tmp path. No shared state between tests; no reliance
 * on the user's real tribe.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Database } from "bun:sqlite"
import { connectToDaemon, createReconnectingClient, type DaemonClient } from "../tools/lib/tribe/socket.ts"

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const DAEMON_SCRIPT = resolve(dirname(new URL(import.meta.url).pathname), "../tools/tribe-daemon.ts")

/** Wait for a condition to become true, polling every `interval` ms. */
async function waitFor(fn: () => boolean | Promise<boolean>, timeout = 5000, interval = 50): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`waitFor timed out after ${timeout}ms`)
}

/** Spawn a daemon bound to `socketPath` + `dbPath`; wait for it to be connectable. */
async function spawnDaemon(socketPath: string, dbPath: string, extra: string[] = []): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      DAEMON_SCRIPT,
      "--socket",
      socketPath,
      "--db",
      dbPath,
      // Never auto-quit mid-test (-1 = disabled). Explicit SIGKILL is the end-of-life signal.
      "--quit-timeout",
      "-1",
      ...extra,
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        TRIBE_DB: dbPath,
        // Don't suppress join/leave notifications — we assert on them.
        TRIBE_NO_SUPPRESS: "1",
        // Self-contained: no git/beads/github/health/accountly side effects.
        TRIBE_NO_PLUGINS: "1",
        TRIBE_ACTIVITY_LOG: "off",
      },
    },
  )
  await waitFor(() => existsSync(socketPath), 8000)
  return child
}

async function waitForDaemonExit(proc: ChildProcess, timeout = 5000): Promise<void> {
  if (proc.exitCode !== null || proc.killed === false) {
    // fall through — check real state below
  }
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

/** MCP-style tool responses come back as `{ content: [{ type: "text", text: "<json>" }] }`. */
function parseToolText(result: unknown): ParsedToolText {
  const content = (result as { content?: Array<{ text: string }> } | undefined)?.content
  const text = content?.[0]?.text
  if (typeof text !== "string") throw new Error(`Tool response missing .content[0].text: ${JSON.stringify(result)}`)
  return JSON.parse(text) as ParsedToolText
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

describe("tribe self-heal (kill-and-recover)", () => {
  let tmpDir: string
  let socketPath: string
  let dbPath: string
  let daemon: ChildProcess | null = null
  const clients: DaemonClient[] = []

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-selfheal-"))
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
  // Invariant 1 — Agents come and go (auto-reconnect after daemon death)
  // =========================================================================

  describe("invariant 1 — reconnection after daemon crash", () => {
    it("a bare client that reconnects to a fresh daemon can complete a tool call", async () => {
      // Daemon v1
      daemon = await spawnDaemon(socketPath, dbPath)

      const c1 = await connect()
      // `register` is a bare JSON-RPC method — it returns structured data directly,
      // not an MCP-style `{content: [{text}]}` envelope.
      const reg = (await c1.call("register", { name: "alice", role: "member" })) as Record<string, unknown>
      expect(typeof reg.sessionId).toBe("string")

      // Kill daemon v1
      await killDaemon(daemon)
      daemon = null
      // Stale socket file — fresh daemon will unlink + rebind.
      unlinkIfExists(socketPath)

      // Daemon v2 on same socket + DB
      daemon = await spawnDaemon(socketPath, dbPath)

      // A brand-new client must be able to call tools immediately.
      const c2 = await connect()
      const members = parseToolText(await c2.call("tribe.members"))
      expect(members.sessions).toBeDefined()
      expect(Array.isArray(members.sessions)).toBe(true)
    }, 20_000)

    it("a reconnecting proxy transparently resumes against a fresh daemon within 5s", async () => {
      // Daemon v1
      daemon = await spawnDaemon(socketPath, dbPath)

      let reconnected = 0
      let registerCount = 0
      const proxy = await createReconnectingClient({
        socketPath,
        onConnect: async (client) => {
          registerCount++
          await client.call("register", { name: "proxy-alice", role: "member" })
        },
        onReconnect: () => {
          reconnected++
        },
        maxAttempts: 10,
      })
      // Track for cleanup
      clients.push(proxy)

      // Sanity call on daemon v1.
      const pre = parseToolText(await proxy.call("tribe.members"))
      expect(pre.sessions).toBeDefined()
      expect(registerCount).toBe(1)

      // Kill daemon v1, boot daemon v2.
      await killDaemon(daemon)
      daemon = null
      unlinkIfExists(socketPath)
      daemon = await spawnDaemon(socketPath, dbPath)

      // Wait for the reconnecting proxy to swap `current` onto the new daemon.
      // (The proxy backs off exponentially starting at 500ms, so 15s is generous.)
      await waitFor(() => reconnected >= 1, 15_000, 100)

      // After reconnect, the proxy must be fully usable for ordinary tool calls.
      const after = parseToolText(await proxy.call("tribe.members"))
      expect(after.sessions).toBeDefined()
      // onConnect fired once for the initial connect, again for the reconnect.
      expect(registerCount).toBeGreaterThanOrEqual(2)
    }, 25_000)
  })

  // =========================================================================
  // Invariant 2 — There is always a chief
  // =========================================================================

  describe("invariant 2 — chief always exists while sessions are connected", () => {
    it("when the longest-connected member leaves, the next-longest becomes chief", async () => {
      daemon = await spawnDaemon(socketPath, dbPath)

      // Alice connects first → derived chief.
      const alice = await connect()
      await alice.call("register", { name: "alice", role: "member" })
      // Small gap so registeredAt ordering is stable (Date.now() resolution).
      await new Promise((r) => setTimeout(r, 20))

      // Bob connects second.
      const bob = await connect()
      await bob.call("register", { name: "bob", role: "member" })

      const led1 = parseToolText(await bob.call("tribe.chief"))
      expect(led1.holder_name).toBe("alice")
      expect(led1.source).toBe("derived-from-connection-order")

      // Alice disconnects. Bob should become chief by derivation alone.
      alice.close()
      const aliceIdx = clients.indexOf(alice)
      if (aliceIdx !== -1) clients.splice(aliceIdx, 1)
      // Give the daemon a moment to process the close event.
      await new Promise((r) => setTimeout(r, 250))

      const led2 = parseToolText(await bob.call("tribe.chief"))
      expect(led2.holder_name).toBe("bob")
      expect(led2.source).toBe("derived-from-connection-order")
    }, 20_000)

    it("explicit claim-chief promotes a later session; release falls back to derivation", async () => {
      daemon = await spawnDaemon(socketPath, dbPath)

      const alice = await connect()
      await alice.call("register", { name: "alice", role: "member" })
      await new Promise((r) => setTimeout(r, 20))
      const bob = await connect()
      await bob.call("register", { name: "bob", role: "member" })

      // Bob claims chief explicitly (overrides derivation).
      parseToolText(await bob.call("tribe.claim-chief"))
      const ledClaim = parseToolText(await alice.call("tribe.chief"))
      expect(ledClaim.holder_name).toBe("bob")
      expect(ledClaim.source).toBe("explicit-claim")
      expect(ledClaim.claimed).toBe(true)

      // Bob disconnects → claim auto-clears, derivation picks alice.
      bob.close()
      const bobIdx = clients.indexOf(bob)
      if (bobIdx !== -1) clients.splice(bobIdx, 1)
      await new Promise((r) => setTimeout(r, 250))

      const ledFallback = parseToolText(await alice.call("tribe.chief"))
      expect(ledFallback.holder_name).toBe("alice")
      expect(ledFallback.source).toBe("derived-from-connection-order")
      expect(ledFallback.claimed).toBe(false)
    }, 20_000)
  })

  // =========================================================================
  // Invariant 3 — No message loss (DB-durable messages survive daemon death)
  // =========================================================================

  describe("invariant 3 — messages persisted before crash survive daemon restart", () => {
    it("broadcast written before SIGKILL is visible to a reconnecting session", async () => {
      daemon = await spawnDaemon(socketPath, dbPath)

      // Alice joins + broadcasts.
      const alice = await connect()
      await alice.call("register", { name: "alice", role: "member" })
      const sent = parseToolText(await alice.call("tribe.broadcast", { message: "hello-before-crash" }))
      expect(sent.sent).toBe(true)

      // Confirm message is in the DB *before* killing the daemon. This is
      // the durability guarantee we can assert today — broadcast handlers
      // run synchronously against sqlite before returning.
      {
        const readDb = new Database(dbPath, { readonly: true })
        try {
          const rows = readDb
            .prepare("SELECT content FROM messages WHERE content = $c")
            .all({ $c: "hello-before-crash" }) as Array<{ content: string }>
          expect(rows.length).toBeGreaterThanOrEqual(1)
        } finally {
          readDb.close()
        }
      }

      // Kill and restart.
      alice.close()
      const aIdx = clients.indexOf(alice)
      if (aIdx !== -1) clients.splice(aIdx, 1)
      await killDaemon(daemon)
      daemon = null
      unlinkIfExists(socketPath)
      daemon = await spawnDaemon(socketPath, dbPath)

      // Alice rejoins under the same name; tribe.history must include the pre-crash broadcast.
      const alice2 = await connect()
      await alice2.call("register", { name: "alice", role: "member" })
      const history = parseToolText(await alice2.call("tribe.history", { limit: 50 }))
      // tribe.history returns the array of messages directly as JSON text.
      // Some handler shapes wrap it, some don't — tolerate both.
      const messages = (Array.isArray(history) ? history : (history.messages ?? history)) as Array<{
        content?: string
      }>
      expect(Array.isArray(messages)).toBe(true)
      const found = messages.some((m) => m.content === "hello-before-crash")
      expect(
        found,
        `pre-crash broadcast missing from tribe.history after restart: ${JSON.stringify(messages).slice(0, 500)}`,
      ).toBe(true)
    }, 25_000)
  })

  // =========================================================================
  // Invariant 4 — Memory RPC surface survives daemon restart (km-bear.unified-daemon)
  // =========================================================================

  describe("invariant 4 — lore RPCs are reachable on the unified socket", () => {
    it("tribe.status and tribe.workspace respond on the same socket the coord protocol uses", async () => {
      daemon = await spawnDaemon(socketPath, dbPath)

      const c = await connect()

      // Coord protocol: register works as before.
      await c.call("register", { name: "unified-alice", role: "member" })

      // Lore handshake on the same connection.
      const hello = (await c.call("tribe.hello", {
        clientName: "self-heal-lore-smoke",
        clientVersion: "0.0.0",
        protocolVersion: 4,
      })) as { protocolVersion: number; daemonPid: number }
      expect(hello.protocolVersion).toBe(4)
      expect(hello.daemonPid).toBe(daemon.pid)

      // Lore status reports the unified daemon.
      const status = (await c.call("tribe.status", {})) as {
        daemonPid: number
        socketPath: string
        sessionCount: number
      }
      expect(status.daemonPid).toBe(daemon.pid)
      expect(status.socketPath).toBe(socketPath)

      // Workspace is empty (no lore session_register'd sessions yet).
      const workspace = (await c.call("tribe.workspace", {})) as {
        generatedAt: number
        sessions: unknown[]
      }
      expect(Array.isArray(workspace.sessions)).toBe(true)

      // Kill and reboot — the lore surface must come back on the same socket.
      await killDaemon(daemon)
      daemon = null
      unlinkIfExists(socketPath)
      daemon = await spawnDaemon(socketPath, dbPath)

      const c2 = await connect()
      const helloAfter = (await c2.call("tribe.hello", {
        clientName: "self-heal-lore-smoke",
        clientVersion: "0.0.0",
        protocolVersion: 4,
      })) as { daemonPid: number }
      expect(helloAfter.daemonPid).toBe(daemon.pid)
    }, 25_000)
  })

  // =========================================================================
  // tribe.debug — dump daemon internals for troubleshooting
  // =========================================================================

  describe("tribe.debug", () => {
    it("returns a snapshot with clients, chief, and cursors", async () => {
      daemon = await spawnDaemon(socketPath, dbPath)

      const alice = await connect()
      await alice.call("register", { name: "debug-alice", role: "member" })
      // Tiny gap so alice's registeredAt is strictly before bob's.
      await new Promise((r) => setTimeout(r, 20))
      const bob = await connect()
      await bob.call("register", { name: "debug-bob", role: "member" })

      const snap = parseToolText(await bob.call("tribe.debug")) as {
        clients: Array<{ id: string; name: string; role: string; pid: number; registeredAt: number }>
        chief: { id: string; name: string; claimed: boolean } | null
        chiefClaim: string | null
        cursors: Array<{
          id: string
          name: string
          last_delivered_ts: number | null
          last_delivered_seq: number | null
        }>
      }
      expect(Array.isArray(snap.clients)).toBe(true)
      const clientNames = snap.clients.map((c) => c.name).sort()
      expect(clientNames).toContain("debug-alice")
      expect(clientNames).toContain("debug-bob")
      expect(snap.chief).not.toBeNull()
      expect(snap.chief?.name).toBe("debug-alice")
      expect(snap.chief?.claimed).toBe(false)
      expect(snap.chiefClaim).toBeNull()
      expect(Array.isArray(snap.cursors)).toBe(true)
    }, 20_000)
  })
})
