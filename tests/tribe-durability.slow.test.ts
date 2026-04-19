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
import { Database } from "bun:sqlite"
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

  it("Test G — delivery latency < 100ms (event-driven fanout, not 1s polling)", async () => {
    // km-tribe.event-bus — the 1s push tick is gone; sendMessage fans out
    // synchronously to connected sockets. A broadcast-to-notification round
    // trip must complete well under the old 1000ms polling floor.
    daemon = await spawnDaemon(socketPath, dbPath)

    const alice = await joinWithToken(socketPath, "alice", "token-A")
    clients.push(alice.client)
    const bob = await joinWithToken(socketPath, "bob", "token-B")
    clients.push(bob.client)

    // Timestamp just before the broadcast reaches the daemon. The RPC call
    // completes only after sendMessage has written to SQLite; alice's socket
    // receives the channel notification synchronously from that same call.
    const sendAt = Date.now()
    await broadcastFrom(bob.client, "G1-sync")

    await waitFor(() => countUserChannels(alice.received, "bob") >= 1, 2000)
    const receivedAt = Date.now()
    const latency = receivedAt - sendAt

    expect(latency, `fanout latency was ${latency}ms — expected < 100ms (event-driven)`).toBeLessThan(100)

    const contents = alice.received.filter((e) => e.type === "notify" && e.from === "bob").map((e) => e.content)
    expect(contents).toEqual(["G1-sync"])
  }, 20_000)

  it("Test H — replay on reconnect uses persisted cursor, not per-connection Map state", async () => {
    // km-tribe.event-bus — per-connection `lastDelivered` Map is gone. The
    // only durable cursor source is sessions.last_delivered_seq. Verify that
    // (a) a crash across a live connection doesn't re-deliver, and (b) new
    // post-restart messages arrive synchronously.
    daemon = await spawnDaemon(socketPath, dbPath)

    const alice1 = await joinWithToken(socketPath, "alice-h", "token-H")
    clients.push(alice1.client)
    const bob1 = await joinWithToken(socketPath, "bob-h", "token-HB")
    clients.push(bob1.client)

    // Bob broadcasts 5 messages; alice receives all 5.
    for (let i = 1; i <= 5; i++) {
      await broadcastFrom(bob1.client, `H${i}`)
    }
    await waitFor(() => countUserChannels(alice1.received, "bob-h") >= 5, 5000)
    expect(countUserChannels(alice1.received, "bob-h")).toBe(5)

    // SIGKILL daemon with alice still connected — no graceful cursor flush,
    // so the test only passes if every push during normal operation already
    // persisted the cursor via persistDeliveredCursor.
    alice1.client.close()
    bob1.client.close()
    clients.splice(0)
    await killDaemon(daemon)
    daemon = null
    unlinkIfExists(socketPath)

    // Fresh daemon, same DB.
    daemon = await spawnDaemon(socketPath, dbPath)

    const alice2 = await joinWithToken(socketPath, "alice-h", "token-H")
    clients.push(alice2.client)

    // Give any spurious replay a full second to arrive — it MUST NOT.
    await new Promise((r) => setTimeout(r, 1000))
    const replayed = alice2.received.filter((e) => e.type === "notify" && e.from === "bob-h")
    expect(
      replayed,
      `alice re-received ${replayed.length} of the 5 prior messages (cursor not persisted from push path)`,
    ).toHaveLength(0)

    // Bob reconnects and broadcasts H6 — alice must receive it within 100ms.
    const bob2 = await joinWithToken(socketPath, "bob-h", "token-HB")
    clients.push(bob2.client)
    const sendAt = Date.now()
    await broadcastFrom(bob2.client, "H6")
    await waitFor(() => countUserChannels(alice2.received, "bob-h") >= 1, 2000)
    const latency = Date.now() - sendAt
    expect(latency).toBeLessThan(100)
    const post = alice2.received.filter((e) => e.type === "notify" && e.from === "bob-h").map((e) => e.content)
    expect(post).toEqual(["H6"])
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

  it("Test I — replay drains >200 backlog on reconnect (no silent truncation)", async () => {
    // km-tribe.delivery-correctness P0.5 + P1.7: replayOrBootstrap used LIMIT
    // 200 once. If >200 broadcasts accumulated while alice was disconnected,
    // only the first 200 were delivered AND the cursor advanced past them via
    // subsequent fanout — the middle 201..N-1 were dropped silently.
    daemon = await spawnDaemon(socketPath, dbPath)

    // Alice joins to establish her identity row, then leaves offline.
    const alice1 = await joinWithToken(socketPath, "alice-i", "token-I")
    clients.push(alice1.client)
    await new Promise((r) => setTimeout(r, 100))
    alice1.client.close()
    clients.splice(clients.indexOf(alice1.client), 1)
    await new Promise((r) => setTimeout(r, 200))

    // Bob floods 250 broadcasts while alice is offline. Each is written
    // synchronously before broadcastFrom resolves.
    const bob1 = await joinWithToken(socketPath, "bob-i", "token-IB")
    clients.push(bob1.client)
    const FLOOD = 250
    for (let i = 1; i <= FLOOD; i++) {
      await broadcastFrom(bob1.client, `I${i}`)
    }

    // Alice reconnects. ALL 250 must be delivered — not just the first 200.
    const alice2 = await joinWithToken(socketPath, "alice-i", "token-I")
    clients.push(alice2.client)

    await waitFor(() => countUserChannels(alice2.received, "bob-i") >= FLOOD, 10_000)
    const contents = alice2.received.filter((e) => e.type === "notify" && e.from === "bob-i").map((e) => e.content)
    expect(
      contents.length,
      `alice received ${contents.length} / ${FLOOD} broadcasts (replay truncated?)`,
    ).toBe(FLOOD)
    // And they come in order.
    expect(contents[0]).toBe("I1")
    expect(contents[FLOOD - 1]).toBe(`I${FLOOD}`)

    // Bob broadcasts one more. Alice must receive it exactly once, not
    // duplicated, not dropped.
    await broadcastFrom(bob1.client, "I-after")
    await waitFor(() => countUserChannels(alice2.received, "bob-i") >= FLOOD + 1, 5000)
    const post = alice2.received.filter((e) => e.type === "notify" && e.from === "bob-i").map((e) => e.content)
    expect(post).toHaveLength(FLOOD + 1)
    expect(post[FLOOD]).toBe("I-after")
  }, 60_000)

  it("Test J — disconnect does not mutate the journal (durability invariant)", async () => {
    // km-tribe.delivery-correctness P0.6: the daemon used to DELETE FROM
    // messages WHERE recipient=<name> on socket close. That violates the
    // journal's durability contract — delivered-or-not, the history stays
    // until retention prunes it. Consequences if disconnect deletes:
    //   (a) a direct sent mid-disconnect (fanout write failed silently) is
    //       wiped before the recipient's next reconnect can replay it;
    //   (b) history queries lose resolved conversation context the moment a
    //       participant leaves.
    //
    // This test asserts the invariant at the SQLite level: after alice
    // disconnects with N directs addressed to her, the journal still has
    // those N rows.
    daemon = await spawnDaemon(socketPath, dbPath)

    const alice = await joinWithToken(socketPath, "alice-j", "token-J")
    clients.push(alice.client)
    const bob = await joinWithToken(socketPath, "bob-j", "token-JB")
    clients.push(bob.client)

    // Bob sends 3 directs to alice. Fanout delivers each synchronously.
    const send = async (msg: string) => {
      const res = (await bob.client.call("tribe.send", { to: "alice-j", message: msg })) as {
        content?: Array<{ text: string }>
      }
      const text = res.content?.[0]?.text
      if (!text) throw new Error(`send returned no content: ${JSON.stringify(res)}`)
      const parsed = JSON.parse(text) as { sent?: boolean }
      if (!parsed.sent) throw new Error(`send did not report sent=true: ${text}`)
    }
    await send("J1-direct")
    await send("J2-direct")
    await send("J3-direct")

    // Wait for alice to receive them all, so the fanout path has completed.
    await waitFor(() => countUserChannels(alice.received, "bob-j") >= 3, 5000)

    // Pre-disconnect baseline: 3 directs for alice in the journal.
    const peek = (): number => {
      const peekDb = new Database(dbPath, { readonly: true })
      try {
        const row = peekDb
          .prepare("SELECT COUNT(*) as n FROM messages WHERE recipient = 'alice-j'")
          .get() as { n: number } | null
        return row?.n ?? 0
      } finally {
        peekDb.close()
      }
    }
    expect(peek(), "pre-disconnect: 3 directs in journal").toBe(3)

    // Alice disconnects. Give the daemon a beat to process the close event
    // (where the bogus DELETE used to fire).
    alice.client.close()
    clients.splice(clients.indexOf(alice.client), 1)
    await new Promise((r) => setTimeout(r, 300))

    // Invariant: journal still has all 3 directs. The daemon must not have
    // deleted them on disconnect.
    expect(peek(), "post-disconnect: journal must still have all 3 directs").toBe(3)
  }, 30_000)
})
