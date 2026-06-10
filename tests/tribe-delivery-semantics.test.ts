/**
 * Delivery-semantics regression suite — pins tribe-wire send/fetch/drain/
 * cursor/presence behavior AS IT IS TODAY, before any refactor touches it
 * (km 19783; system-simplification plan §9.5 — the Phase-5a net for the
 * eventual bearly trim campaign).
 *
 * Every test carries a DELIBERATE or ACCIDENTAL verdict. DELIBERATE = the
 * semantic is the contract; a refactor that breaks the test broke the
 * product. ACCIDENTAL = the semantic is real and consumers cope with it
 * today; changing it needs its own bead + a deliberate migration, never a
 * drive-by — the test failing is the tripwire that a drive-by happened.
 *
 * Evidence: the 2026-06-10 live incidents — verdict-miss (default drain's
 * cursor already past a peer's verdict; `from:` snapshot is the recovery),
 * idle-pull stall (a queued assignment sat undrained — nothing external
 * advances a session's inbox), stale-presence false-idle (working session
 * read as idle because only join/non-empty-drain refresh `updated_at`).
 *
 * Ball-tracker open/reply lifecycle + fanout first/all are pinned separately
 * in tools/lib/tribe/ball-tracker-phase2a.test.ts and
 * tools/lib/tribe/ball-tracker-schema.test.ts — not duplicated here.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"

import { openDatabase, createStatements } from "../tools/lib/tribe/database.ts"
import { createTribeContext } from "../tools/lib/tribe/context.ts"
import { handleToolCall } from "../tools/lib/tribe/handlers.ts"
import type { ActiveSessionInfo, HandlerOpts } from "../tools/lib/tribe/handlers.ts"

// ---------------------------------------------------------------------------
// Harness (same shape as tribe-filter.test.ts)
// ---------------------------------------------------------------------------

let dir: string
let db: ReturnType<typeof openDatabase>
let stmts: ReturnType<typeof createStatements>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tribe-delivery-"))
  db = openDatabase(join(dir, "tribe.db"))
  stmts = createStatements(db)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeOpts(): HandlerOpts {
  return {
    cleanup: () => {},
    userRenamed: false,
    setUserRenamed: () => {},
    getActiveSessionIds: () => new Set<string>(),
    getActiveSessionInfo: () => [] as ActiveSessionInfo[],
  }
}

function ctxFor(name: string) {
  const sessionId = randomUUID()
  const now = Date.now()
  db.prepare(
    `INSERT INTO sessions (id, name, role, domains, pid, started_at, updated_at)
     VALUES ($id, $name, 'member', '[]', 0, $now, $now)`,
  ).run({ $id: sessionId, $name: name, $now: now })
  return createTribeContext({
    db,
    stmts,
    sessionId,
    sessionRole: "member",
    initialName: name,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
}

interface FetchEvent {
  id: string
  rowid: number
  from: string
  to: string
  content: string
  delivery: string | null
  topic: string | null
}

async function call(
  ctx: ReturnType<typeof ctxFor>,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await handleToolCall(ctx, tool, args, makeOpts())
  const payload = (res as { content: Array<{ type: string; text: string }> }).content[0]
  if (!payload) throw new Error(`no payload from ${tool}`)
  return JSON.parse(payload.text) as Record<string, unknown>
}

async function fetchEvents(ctx: ReturnType<typeof ctxFor>, args: Record<string, unknown> = {}): Promise<FetchEvent[]> {
  const out = await call(ctx, "tribe.fetch", args)
  return out.events as FetchEvent[]
}

function updatedAt(ctx: ReturnType<typeof ctxFor>): number {
  const row = db.prepare("SELECT updated_at FROM sessions WHERE id = ?").get(ctx.sessionId) as {
    updated_at: number
  }
  return row.updated_at
}

// ---------------------------------------------------------------------------
// 1. Default drain — the cursor IS the inbox
// ---------------------------------------------------------------------------

describe("default drain (no filters)", () => {
  it("returns queued rows and advances the cursor — a second drain is empty [DELIBERATE]", async () => {
    const alice = ctxFor("alice")
    const bob = ctxFor("bob")
    await call(alice, "tribe.send", { to: "bob", message: "one" })
    await call(alice, "tribe.send", { to: "bob", message: "two" })

    const first = await fetchEvents(bob)
    expect(first.map((e) => e.content)).toEqual(["one", "two"])
    expect(await fetchEvents(bob)).toEqual([])
  })

  it("advance:false is a peek — rows come back again on the next drain [DELIBERATE]", async () => {
    const alice = ctxFor("alice")
    const bob = ctxFor("bob")
    await call(alice, "tribe.send", { to: "bob", message: "peek-me" })

    const peeked = await fetchEvents(bob, { advance: false })
    expect(peeked.map((e) => e.content)).toEqual(["peek-me"])
    const drained = await fetchEvents(bob)
    expect(drained.map((e) => e.content)).toEqual(["peek-me"])
    expect(await fetchEvents(bob)).toEqual([])
  })

  it("includes push-delivered rows — delivery mode never excludes from drain [DELIBERATE]", async () => {
    // The 2026-06-10 verdict-miss was NOT push rows being excluded — it was
    // the cursor already being past them (drained once = gone from default
    // drain). This pins the actual mechanism so nobody "fixes" the wrong leg.
    const alice = ctxFor("alice")
    const bob = ctxFor("bob")
    db.prepare("UPDATE sessions SET delivery = 'push' WHERE id = ?").run(bob.sessionId)
    await call(alice, "tribe.send", { to: "bob", message: "verdict: ship it", type: "verdict" })

    const events = await fetchEvents(bob)
    expect(events.map((e) => e.content)).toEqual(["verdict: ship it"])
  })

  it("broadcasts ('*') reach every member's drain; own sends never come back [DELIBERATE]", async () => {
    const alice = ctxFor("alice")
    const bob = ctxFor("bob")
    const carol = ctxFor("carol")
    await call(alice, "tribe.send", { to: "*", message: "all hands" })

    expect((await fetchEvents(bob)).map((e) => e.content)).toEqual(["all hands"])
    expect((await fetchEvents(carol)).map((e) => e.content)).toEqual(["all hands"])
    expect(await fetchEvents(alice)).toEqual([]) // sender != $name excludes own rows
  })
})

// ---------------------------------------------------------------------------
// 2. Snapshot reads — the verdict-miss recovery path
// ---------------------------------------------------------------------------

describe("snapshot reads (from / with / ids / since)", () => {
  it("`from:` re-reads rows the default drain already consumed — the verdict recovery [DELIBERATE]", async () => {
    const chief = ctxFor("@chief")
    const agent = ctxFor("@agent/9")
    await call(chief, "tribe.send", { to: "@agent/9", message: "verdict: approved", type: "verdict" })

    // The incident shape: something drains the inbox (hook, earlier tool
    // call), the verdict scrolls past unnoticed...
    const drained = await fetchEvents(agent)
    expect(drained).toHaveLength(1)
    expect(await fetchEvents(agent)).toEqual([])

    // ...and the from-snapshot still sees it, without moving the cursor.
    const snapshot = await fetchEvents(agent, { from: "@chief" })
    expect(snapshot.map((e) => e.content)).toEqual(["verdict: approved"])
    expect(await fetchEvents(agent)).toEqual([]) // cursor untouched by snapshot
  })

  it("`with:` is a bilateral snapshot and never advances the cursor [DELIBERATE]", async () => {
    const alice = ctxFor("alice")
    const bob = ctxFor("bob")
    await call(alice, "tribe.send", { to: "bob", message: "ping" })
    await call(bob, "tribe.send", { to: "alice", message: "pong" })

    const history = await fetchEvents(bob, { with: "alice" })
    expect(history.map((e) => e.content)).toEqual(["ping", "pong"])
    // Default drain still has the undrained row — snapshot did not consume it.
    expect((await fetchEvents(bob)).map((e) => e.content)).toEqual(["ping"])
  })

  it("`ids:` fetch never advances the cursor [DELIBERATE]", async () => {
    const alice = ctxFor("alice")
    const bob = ctxFor("bob")
    const sent = await call(alice, "tribe.send", { to: "bob", message: "by-id" })

    const byId = await fetchEvents(bob, { ids: [sent.id as string] })
    expect(byId.map((e) => e.content)).toEqual(["by-id"])
    expect((await fetchEvents(bob)).map((e) => e.content)).toEqual(["by-id"])
  })

  it("`since` scans without advancing unless advance:true [DELIBERATE]", async () => {
    const alice = ctxFor("alice")
    const bob = ctxFor("bob")
    await call(alice, "tribe.send", { to: "bob", message: "scan-me" })

    const scanned = await fetchEvents(bob, { since: 0 })
    expect(scanned.map((e) => e.content)).toEqual(["scan-me"])
    expect((await fetchEvents(bob, { since: 0 })).map((e) => e.content)).toEqual(["scan-me"])

    await fetchEvents(bob, { since: 0, advance: true })
    expect(await fetchEvents(bob)).toEqual([]) // since+advance moved the cursor
  })
})

// ---------------------------------------------------------------------------
// 3. Topic-filtered drain — the skip-forever edge
// ---------------------------------------------------------------------------

describe("topic-filtered drain", () => {
  it("advances to the last MATCHING row — earlier non-matching rows are skipped forever [ACCIDENTAL]", async () => {
    // Real shape: drain with topics:['git:*'] while a plain DM sits between
    // two topic rows. The cursor lands on the last matching row, silently
    // consuming the DM in the gap. Consumers today avoid this by never
    // mixing topic drains with their primary inbox. Changing it (e.g.
    // per-topic cursors) is a follow-up bead, not a drive-by.
    const alice = ctxFor("alice")
    const bob = ctxFor("bob")
    // topic isn't a tribe.send arg — set it directly to control the rows
    await call(alice, "tribe.send", { to: "bob", message: "t1" })
    db.prepare("UPDATE messages SET topic = 'git:commit' WHERE content = 't1'").run()
    await call(alice, "tribe.send", { to: "bob", message: "plain DM in the gap" })
    await call(alice, "tribe.send", { to: "bob", message: "t2" })
    db.prepare("UPDATE messages SET topic = 'git:commit' WHERE content = 't2'").run()

    const topicRows = await fetchEvents(bob, { topics: ["git:*"] })
    expect(topicRows.map((e) => e.content)).toEqual(["t1", "t2"])

    // The DM between t1 and t2 is gone from the default drain — pinned.
    expect(await fetchEvents(bob)).toEqual([])
  })

  it("non-matching rows AFTER the last match survive for the next drain [DELIBERATE]", async () => {
    const alice = ctxFor("alice")
    const bob = ctxFor("bob")
    await call(alice, "tribe.send", { to: "bob", message: "t1" })
    db.prepare("UPDATE messages SET topic = 'git:commit' WHERE content = 't1'").run()
    await call(alice, "tribe.send", { to: "bob", message: "DM after last match" })

    expect((await fetchEvents(bob, { topics: ["git:*"] })).map((e) => e.content)).toEqual(["t1"])
    expect((await fetchEvents(bob)).map((e) => e.content)).toEqual(["DM after last match"])
  })
})

// ---------------------------------------------------------------------------
// 4. Presence — the false-idle pin
// ---------------------------------------------------------------------------

describe("presence (sessions.updated_at drives members' last_seen)", () => {
  it("tribe.join refreshes updated_at — the heartbeat [DELIBERATE]", async () => {
    const agent = ctxFor("@agent/9")
    db.prepare("UPDATE sessions SET updated_at = 1000 WHERE id = ?").run(agent.sessionId)
    await call(agent, "tribe.join", { name: "@agent/9" })
    expect(updatedAt(agent)).toBeGreaterThan(1000)
  })

  it("EVERY authenticated tool call refreshes the caller's updated_at [DELIBERATE since 19784]", async () => {
    // Flipped from ACCIDENTAL (b35ae2e pins) by @km/tribe/19784: the
    // 2026-06-10 false-idle class came from send + empty-drain NOT refreshing
    // presence — an actively-working session read as idle on tribe.members.
    // New contract: presence means "process spoke to the daemon recently";
    // handleToolCall touches the caller's row before dispatch, so every
    // call type refreshes, including empty drains and pure reads.
    ctxFor("bob")
    const alice = ctxFor("alice")
    const callsToPin: Array<[string, Record<string, unknown>]> = [
      ["tribe.send", { to: "bob", message: "working!" }],
      ["tribe.fetch", {}], // EMPTY drain — the worst false-idle leg
      ["tribe.pending", {}],
      ["tribe.members", {}],
      ["tribe.filter", {}],
    ]
    for (const [tool, args] of callsToPin) {
      db.prepare("UPDATE sessions SET updated_at = 1000 WHERE id = ?").run(alice.sessionId)
      await call(alice, tool, args)
      expect(updatedAt(alice), `${tool} must refresh presence`).toBeGreaterThan(1000)
    }
  })
})

// ---------------------------------------------------------------------------
// 5. The idle-pull stall — queued work waits for a drain, full stop
// ---------------------------------------------------------------------------

describe("idle-pull stall (queued request sits until the recipient drains)", () => {
  it("a tracked request stays in tribe.pending until the recipient replies — fetch alone does not release the ball [DELIBERATE]", async () => {
    const chief = ctxFor("@chief")
    const agent = ctxFor("@agent/9")
    const sent = await call(chief, "tribe.send", {
      to: "@agent/9",
      message: "please integrate",
      type: "request",
      request: true,
    })

    // Queued + tracked, regardless of whether the recipient ever looks.
    const before = await call(agent, "tribe.pending", {})
    expect(before.count).toBe(1)

    // Draining delivers the message but the ball stays open...
    expect((await fetchEvents(agent)).map((e) => e.content)).toEqual(["please integrate"])
    expect((await call(agent, "tribe.pending", {})).count).toBe(1)

    // ...until an explicit reply closes it.
    await call(agent, "tribe.send", { to: "@chief", message: "done", reply: sent.id as string })
    expect((await call(agent, "tribe.pending", {})).count).toBe(0)
  })

  it("nothing external ever advances a session's cursor — undrained work waits indefinitely [DELIBERATE]", async () => {
    // The stall class is structural: the daemon queues, it never pushes the
    // cursor. The fix for stalls lives in ops (heartbeat /loop drains,
    // chief pings), not in the wire — this pin keeps the wire honest.
    const chief = ctxFor("@chief")
    const agent = ctxFor("@agent/9")
    await call(chief, "tribe.send", { to: "@agent/9", message: "assignment", type: "assign" })
    await call(chief, "tribe.send", { to: "@agent/9", message: "still there?", type: "query" })

    const cursor = db.prepare("SELECT last_inbox_pull_seq FROM sessions WHERE id = ?").get(agent.sessionId) as {
      last_inbox_pull_seq: number
    }
    expect(cursor.last_inbox_pull_seq).toBe(0)
    expect(await fetchEvents(agent)).toHaveLength(2) // both still queued
  })
})
