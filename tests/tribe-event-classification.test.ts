/**
 * km-tribe.event-classification — integration tests (post-filter-collapse v11).
 *
 * Covers:
 *   - Per-plugin classification (push vs pull) at sendMessage boundary
 *   - tribe.inbox dual cursor + glob filter
 *   - replyHint derivation at delivery time (kind + sender role + recipient)
 *   - Schema invariant: every row carries delivery / pluginKind / no-NULL
 *
 * tribe.filter (mode + kinds + until) coverage lives in tribe-filter.test.ts.
 *
 * These are unit tests over the in-process daemon helpers (database, messaging,
 * handlers) — no socket, no spawn. Faster + deterministic vs spawning a daemon
 * per case. The daemon-spawn integration coverage lives in tribe-daemon.test.ts.
 */

import { describe, it, expect, beforeEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"

import { openDatabase, createStatements } from "../tools/lib/tribe/database.ts"
import { createTribeContext } from "../tools/lib/tribe/context.ts"
import { sendMessage, deriveReplyHint } from "../tools/lib/tribe/messaging.ts"
import { handleToolCall } from "../tools/lib/tribe/handlers.ts"
import type { ActiveSessionInfo, HandlerOpts } from "../tools/lib/tribe/handlers.ts"

function dbFixture() {
  const dir = mkdtempSync(join(tmpdir(), "tribe-classify-"))
  const path = join(dir, "tribe.db")
  const db = openDatabase(path)
  const stmts = createStatements(db)
  return { db, stmts, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function makeOpts(): HandlerOpts {
  return {
    cleanup: () => {},
    userRenamed: false,
    setUserRenamed: () => {},
    getChiefId: () => null,
    getChiefInfo: () => null,
    claimChief: () => {},
    releaseChief: () => {},
    getActiveSessionIds: () => new Set<string>(),
    getActiveSessionInfo: () => [] as ActiveSessionInfo[],
  }
}

function ctxFor(
  db: ReturnType<typeof openDatabase>,
  stmts: ReturnType<typeof createStatements>,
  name: string,
  role: "member" | "daemon" = "member",
) {
  const sessionId = randomUUID()
  // Insert the session row so handlers that key off ctx.sessionId find a row.
  const now = Date.now()
  db.prepare(
    `INSERT INTO sessions (id, name, role, domains, pid, started_at, updated_at)
     VALUES ($id, $name, $role, '[]', 0, $now, $now)`,
  ).run({ $id: sessionId, $name: name, $role: role, $now: now })
  return createTribeContext({
    db,
    stmts,
    sessionId,
    sessionRole: role,
    initialName: name,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
}

// ---------------------------------------------------------------------------
// 1. Plugin classification — verify each kind table row
// ---------------------------------------------------------------------------

describe("classification — per-plugin defaults via sendMessage", () => {
  let f: ReturnType<typeof dbFixture>
  beforeEach(() => {
    f = dbFixture()
  })

  it("git:commit broadcast lands as delivery=pull with the right pluginKind", () => {
    const ctx = ctxFor(f.db, f.stmts, "git-plugin")
    sendMessage(ctx, "*", "Committed: abc123 fix bug", "status", undefined, undefined, "broadcast", {
      delivery: "pull",
      pluginKind: "git:commit",
    })
    const row = f.db.prepare("SELECT delivery, plugin_kind FROM messages").get() as {
      delivery: string
      plugin_kind: string
    }
    expect(row.delivery).toBe("pull")
    expect(row.plugin_kind).toBe("git:commit")
  })

  it("github:ci-alert DM lands as delivery=push with the right pluginKind", () => {
    const ctx = ctxFor(f.db, f.stmts, "github-plugin")
    sendMessage(ctx, "alice", "Your repo X has CI failures", "github:ci-alert", undefined, undefined, "direct", {
      delivery: "push",
      pluginKind: "github:ci-alert",
    })
    const row = f.db.prepare("SELECT delivery, plugin_kind FROM messages").get() as {
      delivery: string
      plugin_kind: string
    }
    expect(row.delivery).toBe("push")
    expect(row.plugin_kind).toBe("github:ci-alert")
  })

  it("legacy sendMessage call without classification defaults to push delivery", () => {
    const ctx = ctxFor(f.db, f.stmts, "legacy")
    // Note: NO 8th argument — exercises the default classification path.
    sendMessage(ctx, "*", "legacy broadcast", "notify")
    const row = f.db.prepare("SELECT delivery, plugin_kind FROM messages").get() as {
      delivery: string
      plugin_kind: string | null
    }
    expect(row.delivery).toBe("push")
    expect(row.plugin_kind).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. deriveReplyHint — replaces the persisted column
// ---------------------------------------------------------------------------

describe("deriveReplyHint — derived from kind + recipient + senderRole", () => {
  it("event rows are journal-only → 'no'", () => {
    expect(deriveReplyHint({ kind: "event", recipient: "*", senderRole: "daemon" })).toBe("no")
    expect(deriveReplyHint({ kind: "event", recipient: "alice", senderRole: "member" })).toBe("no")
  })

  it("broadcast '*' → 'optional' regardless of sender", () => {
    expect(deriveReplyHint({ kind: "broadcast", recipient: "*", senderRole: "member" })).toBe("optional")
    expect(deriveReplyHint({ kind: "broadcast", recipient: "*", senderRole: "daemon" })).toBe("optional")
    expect(deriveReplyHint({ kind: "broadcast", recipient: "*", senderRole: "system" })).toBe("optional")
  })

  it("daemon / system DM → 'optional'", () => {
    expect(deriveReplyHint({ kind: "direct", recipient: "alice", senderRole: "daemon" })).toBe("optional")
    expect(deriveReplyHint({ kind: "direct", recipient: "alice", senderRole: "system" })).toBe("optional")
  })

  it("member-to-member DM → 'yes'", () => {
    expect(deriveReplyHint({ kind: "direct", recipient: "alice", senderRole: "member" })).toBe("yes")
    expect(deriveReplyHint({ kind: "direct", recipient: "bob", senderRole: "chief" })).toBe("yes")
  })
})

// ---------------------------------------------------------------------------
// 3. tribe.inbox — dual cursor
// ---------------------------------------------------------------------------

describe("tribe.inbox — pull cursor advances independently of push cursor", () => {
  let f: ReturnType<typeof dbFixture>
  beforeEach(() => {
    f = dbFixture()
  })

  it("returns pending events newer than per-session pull cursor and advances it", async () => {
    const sender = ctxFor(f.db, f.stmts, "git")
    const reader = ctxFor(f.db, f.stmts, "alice")

    // Three ambient events.
    for (const tag of ["a1", "b2", "c3"]) {
      sendMessage(sender, "*", `Committed: ${tag}`, "status", undefined, undefined, "broadcast", {
        delivery: "pull",
        pluginKind: "git:commit",
      })
    }

    // First pull — all three.
    const r1 = (await handleToolCall(reader, "tribe.inbox", { limit: 50 }, makeOpts())) as {
      content: Array<{ type: string; text: string }>
    }
    const p1 = JSON.parse(r1.content[0]!.text) as { events: Array<{ content: string }>; cursor: number }
    expect(p1.events).toHaveLength(3)
    expect(p1.events.map((e) => e.content)).toEqual(["Committed: a1", "Committed: b2", "Committed: c3"])

    // Second pull — empty (cursor advanced).
    const r2 = (await handleToolCall(reader, "tribe.inbox", { limit: 50 }, makeOpts())) as {
      content: Array<{ type: string; text: string }>
    }
    const p2 = JSON.parse(r2.content[0]!.text) as { events: Array<unknown> }
    expect(p2.events).toHaveLength(0)

    // New event after cursor — visible on next pull.
    sendMessage(sender, "*", "Committed: d4", "status", undefined, undefined, "broadcast", {
      delivery: "pull",
      pluginKind: "git:commit",
    })
    const r3 = (await handleToolCall(reader, "tribe.inbox", { limit: 50 }, makeOpts())) as {
      content: Array<{ type: string; text: string }>
    }
    const p3 = JSON.parse(r3.content[0]!.text) as { events: Array<{ content: string }> }
    expect(p3.events.map((e) => e.content)).toEqual(["Committed: d4"])
  })

  it("since=N does NOT advance the persistent cursor (caller controls iteration)", async () => {
    const sender = ctxFor(f.db, f.stmts, "git")
    const reader = ctxFor(f.db, f.stmts, "alice")

    sendMessage(sender, "*", "Committed: a1", "status", undefined, undefined, "broadcast", {
      delivery: "pull",
      pluginKind: "git:commit",
    })
    sendMessage(sender, "*", "Committed: b2", "status", undefined, undefined, "broadcast", {
      delivery: "pull",
      pluginKind: "git:commit",
    })

    // Snapshot read with since=0 — should not bump cursor.
    await handleToolCall(reader, "tribe.inbox", { since: 0, limit: 50 }, makeOpts())
    const cursor = f.stmts.getInboxCursor.get({ $id: reader.sessionId }) as { last_inbox_pull_seq: number }
    expect(cursor.last_inbox_pull_seq).toBe(0)

    // Now do a real pull — cursor advances.
    await handleToolCall(reader, "tribe.inbox", { limit: 50 }, makeOpts())
    const cursor2 = f.stmts.getInboxCursor.get({ $id: reader.sessionId }) as { last_inbox_pull_seq: number }
    expect(cursor2.last_inbox_pull_seq).toBeGreaterThan(0)
  })

  it("pull cursor is independent of push cursor (last_delivered_seq)", async () => {
    const sender = ctxFor(f.db, f.stmts, "alice")
    const reader = ctxFor(f.db, f.stmts, "bob")

    // Push event.
    sendMessage(sender, "*", "important DM", "notify", undefined, undefined, "broadcast", {
      delivery: "push",
    })
    // Pull event.
    sendMessage(sender, "*", "ambient FYI", "status", undefined, undefined, "broadcast", {
      delivery: "pull",
    })

    // Pull-side cursor empty before tribe.inbox call.
    const before = f.stmts.getInboxCursor.get({ $id: reader.sessionId }) as { last_inbox_pull_seq: number }
    expect(before.last_inbox_pull_seq).toBe(0)

    // tribe.inbox sees BOTH (push events also appear in inbox per design — pull
    // is a superset; the channel just additionally fans them out for push).
    const r = (await handleToolCall(reader, "tribe.inbox", { limit: 50 }, makeOpts())) as {
      content: Array<{ type: string; text: string }>
    }
    const events = (JSON.parse(r.content[0]!.text) as { events: Array<{ delivery: string }> }).events
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.delivery)).toEqual(["push", "pull"])

    // last_delivered_seq is unaffected by pull (push fanout is the daemon's job;
    // this in-process test never triggers fanout, so it stays at 0).
    const sess = f.db.prepare("SELECT last_delivered_seq FROM sessions WHERE id = ?").get(reader.sessionId) as {
      last_delivered_seq: number
    }
    expect(sess.last_delivered_seq).toBe(0)
  })

  it("kinds glob filter narrows results", async () => {
    const sender = ctxFor(f.db, f.stmts, "plugins")
    const reader = ctxFor(f.db, f.stmts, "alice")

    sendMessage(sender, "*", "Committed: a", "status", undefined, undefined, "broadcast", {
      delivery: "pull",
      pluginKind: "git:commit",
    })
    sendMessage(sender, "*", "[push] x", "github:push", undefined, undefined, "broadcast", {
      delivery: "pull",
      pluginKind: "github:push",
    })
    sendMessage(sender, "*", "[pr] y", "github:pull_request", undefined, undefined, "broadcast", {
      delivery: "pull",
      pluginKind: "github:pull_request",
    })

    const r = (await handleToolCall(reader, "tribe.inbox", { kinds: ["github:*"], limit: 50 }, makeOpts())) as {
      content: Array<{ type: string; text: string }>
    }
    const events = (JSON.parse(r.content[0]!.text) as { events: Array<{ plugin_kind: string }> }).events
    expect(events).toHaveLength(2)
    expect(events.every((e) => e.plugin_kind.startsWith("github:"))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. Schema invariants — every row carries delivery; v11 dropped the
//    response_expected column entirely.
// ---------------------------------------------------------------------------

describe("schema v11 — every row carries delivery; replyHint is derived not stored", () => {
  it("legacy sendMessage rows are populated by defaults, never NULL on delivery", () => {
    const f = dbFixture()
    const ctx = ctxFor(f.db, f.stmts, "alice")
    sendMessage(ctx, "*", "no-classification", "notify")
    const row = f.db.prepare("SELECT delivery FROM messages").get() as { delivery: string }
    expect(row.delivery).not.toBeNull()
    f.cleanup()
  })

  it("messages table has no response_expected column (v11)", () => {
    const f = dbFixture()
    const cols = (f.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((r) => r.name)
    expect(cols).not.toContain("response_expected")
    f.cleanup()
  })

  it("sessions table uses filter_* columns (renamed from mode/snooze_*)", () => {
    const f = dbFixture()
    const cols = (f.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((r) => r.name)
    expect(cols).toContain("filter_mode")
    expect(cols).toContain("filter_until")
    expect(cols).toContain("filter_kinds")
    expect(cols).not.toContain("mode")
    expect(cols).not.toContain("snooze_until")
    expect(cols).not.toContain("snooze_kinds")
    f.cleanup()
  })

  it("dismissals table is gone (v11)", () => {
    const f = dbFixture()
    const t = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dismissals'").get() as
      | { name: string }
      | null
    expect(t).toBeNull()
    f.cleanup()
  })
})
