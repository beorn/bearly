/**
 * Tribe message durability — persistent per-session push cursor.
 *
 * Phase 1.6 of the plateau plan (km-tribe.message-durability). Closes the gap
 * that tribe-self-heal.slow.test.ts documented as out of scope: "in-flight
 * socket buffers at the moment of crash are NOT covered".
 *
 * Invariant under test: after the daemon crashes and a session reconnects via
 * its stable identity_token (Phase 1.5), the new daemon must NOT re-push
 * messages the old daemon already delivered, AND must deliver any messages
 * that were queued while the session was disconnected.
 *
 * Mechanism: the daemon now writes sessions.last_delivered_ts /
 * last_delivered_seq on every successful `pushToClient`. On register, the
 * in-memory push cursor is seeded from that row. The identity_token lookup
 * makes sure we adopt the right row across restart.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { connectToDaemon, type DaemonClient } from "../tools/lib/tribe/socket.ts"

// ---------------------------------------------------------------------------
// Harness — mirrors tribe-self-heal's conventions (same socket path style,
// same TRIBE_NO_SUPPRESS/TRIBE_NO_PLUGINS env, same SIGKILL end-of-life).
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
        TRIBE_NO_PLUGINS: "1",
      },
    },
  )
  await waitFor(() => existsSync(socketPath), 8000)
  return child
}

async function waitForDaemonExit(proc: ChildProcess, timeout = 5000): Promise<void> {
  if (proc.exitCode !== null) return
  await new Promise<void>((res) => {
    const to = setTimeout(() => res(), timeout)
    proc.once("exit", () => {
      clearTimeout(to)
      res()
    })
  })
}

async function killDaemon(proc: ChildProcess | null): Promise<void> {
  if (proc?.exitCode !== null) return
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

type ChannelEvent = { from: string; type: string; content: string; message_id?: string }

/**
 * Connect + register with an identity token. Records every `channel`
 * notification so tests can assert on exact delivery counts.
 */
async function joinWithToken(
  socketPath: string,
  name: string,
  identityToken: string,
): Promise<{ client: DaemonClient; received: ChannelEvent[] }> {
  const client = await connectToDaemon(socketPath)
  const received: ChannelEvent[] = []
  client.onNotification((method, params) => {
    if (method !== "channel") return
    received.push(params as unknown as ChannelEvent)
  })
  await client.call("register", {
    name,
    role: "member",
    identityToken,
    claudeSessionId: `csid-${name}`,
  })
  return { client, received }
}

/** Broadcast as this session and wait for the send to settle. */
async function broadcastFrom(client: DaemonClient, message: string): Promise<void> {
  const res = (await client.call("tribe.broadcast", { message })) as {
    content?: Array<{ text: string }>
  }
  const text = res.content?.[0]?.text
  if (!text) throw new Error(`broadcast returned no content: ${JSON.stringify(res)}`)
  const parsed = JSON.parse(text) as { sent?: boolean }
  if (!parsed.sent) throw new Error(`broadcast did not report sent=true: ${text}`)
}

/** Count broadcast-style channel events (filters out system/session/health noise). */
function countUserChannels(events: ChannelEvent[], from?: string): number {
  return events.filter((e) => e.type === "notify" && (!from || e.from === from)).length
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tribe message durability (km-tribe.message-durability)", () => {
  let tmpDir: string
  let socketPath: string
  let dbPath: string
  let daemon: ChildProcess | null = null
  const clients: DaemonClient[] = []

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-durability-"))
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

  it("Test E — no duplicate delivery after daemon restart", async () => {
    // Daemon v1
    daemon = await spawnDaemon(socketPath, dbPath)

    const alice1 = await joinWithToken(socketPath, "alice", "token-A")
    clients.push(alice1.client)
    const bob1 = await joinWithToken(socketPath, "bob", "token-B")
    clients.push(bob1.client)

    // Bob broadcasts three messages. Alice must receive all three.
    await broadcastFrom(bob1.client, "M1")
    await broadcastFrom(bob1.client, "M2")
    await broadcastFrom(bob1.client, "M3")

    await waitFor(() => countUserChannels(alice1.received, "bob") >= 3, 5000)
    expect(countUserChannels(alice1.received, "bob")).toBe(3)
    const deliveredContents = alice1.received.filter((e) => e.type === "notify").map((e) => e.content)
    expect(deliveredContents).toEqual(expect.arrayContaining(["M1", "M2", "M3"]))

    // SIGKILL the daemon with both sessions in "happy place" — their cursors
    // must have been persisted to the DB by the push path.
    alice1.client.close()
    bob1.client.close()
    clients.splice(0) // we just closed them
    await killDaemon(daemon)
    daemon = null
    unlinkIfExists(socketPath)

    // Daemon v2 on same socket + DB
    daemon = await spawnDaemon(socketPath, dbPath)

    // Reconnect both sessions with the SAME identity tokens. Phase 1.5 adopts
    // the prior sessionId + name; Phase 1.6 seeds the push cursor from the
    // adopted session row.
    const alice2 = await joinWithToken(socketPath, "alice", "token-A")
    clients.push(alice2.client)
    const bob2 = await joinWithToken(socketPath, "bob", "token-B")
    clients.push(bob2.client)

    // Give the 1s push tick a full cycle + some slack. Alice MUST NOT receive
    // M1/M2/M3 again — the cursor is at-or-past them.
    await new Promise((r) => setTimeout(r, 1500))
    const replayedBob = alice2.received.filter((e) => e.type === "notify" && e.from === "bob")
    expect(
      replayedBob,
      `alice replayed ${replayedBob.length} bob messages after restart: ${JSON.stringify(replayedBob)}`,
    ).toHaveLength(0)

    // New message after restart is still delivered exactly once.
    await broadcastFrom(bob2.client, "M4")
    await waitFor(() => countUserChannels(alice2.received, "bob") >= 1, 5000)
    const bobSinceRestart = alice2.received.filter((e) => e.type === "notify" && e.from === "bob")
    expect(bobSinceRestart.map((e) => e.content)).toEqual(["M4"])
  }, 40_000)

  it("Test F — messages queued while alice is disconnected are delivered after daemon restart", async () => {
    // Daemon v1
    daemon = await spawnDaemon(socketPath, dbPath)

    // Alice joins to establish the identity_token row, then leaves.
    const alice1 = await joinWithToken(socketPath, "alice", "token-A")
    clients.push(alice1.client)
    // Give the register round-trip time to complete before closing.
    await new Promise((r) => setTimeout(r, 100))
    alice1.client.close()
    const aliceIdx = clients.indexOf(alice1.client)
    if (aliceIdx !== -1) clients.splice(aliceIdx, 1)
    // Let the daemon process the disconnect.
    await new Promise((r) => setTimeout(r, 200))

    // Bob joins and broadcasts M5/M6 while alice is offline. These are
    // written to SQLite synchronously before broadcastFrom resolves.
    const bob1 = await joinWithToken(socketPath, "bob", "token-B")
    clients.push(bob1.client)
    await broadcastFrom(bob1.client, "M5")
    await broadcastFrom(bob1.client, "M6")

    // Kill daemon v1, start daemon v2.
    bob1.client.close()
    clients.splice(clients.indexOf(bob1.client), 1)
    await killDaemon(daemon)
    daemon = null
    unlinkIfExists(socketPath)
    daemon = await spawnDaemon(socketPath, dbPath)

    // Alice reconnects. Her cursor is at 0 (she never received anything),
    // so M5 and M6 must be delivered now — they survived both her
    // disconnection and the daemon crash.
    const alice2 = await joinWithToken(socketPath, "alice", "token-A")
    clients.push(alice2.client)

    await waitFor(() => countUserChannels(alice2.received, "bob") >= 2, 8000)
    const contents = alice2.received.filter((e) => e.type === "notify" && e.from === "bob").map((e) => e.content)
    expect(contents).toEqual(expect.arrayContaining(["M5", "M6"]))
    // And no duplicates.
    expect(contents).toHaveLength(2)
  }, 40_000)
})
