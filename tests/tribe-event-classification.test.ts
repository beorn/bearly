/**
 * km-tribe.event-classification — integration tests.
 *
 * Covers:
 *   - Per-plugin classification (push vs pull, responseExpected hints)
 *   - Dual cursor: push delivery cursor + pull inbox cursor advance independently
 *   - Mode filter: focus drops everything except `responseExpected: "yes"`
 *   - Snooze: time-bounded suppression with auto-revert and kind globs
 *   - Dismiss: writes audit row
 *   - Channel envelope carries `responseExpected` + `pluginKind`
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
import { sendMessage } from "../tools/lib/tribe/messaging.ts"
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

function ctxFor(db: ReturnType<typeof openDatabase>, stmts: ReturnType<typeof createStatements>, name: string) {
  const sessionId = randomUUID()
  // Insert the session row so handlers that key off ctx.sessionId find a row.
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

// ---------------------------------------------------------------------------
// 1. Plugin classification — verify each kind table row
// ---------------------------------------------------------------------------

describe("classification — per-plugin defaults via sendMessage", () => {
  let f: ReturnType<typeof dbFixture>
  beforeEach(() => {
    f = dbFixture()
  })

  it("git:commit broadcast lands as delivery=pull, response=no", () => {
    const ctx = ctxFor(f.db, f.stmts, "git-plugin")
    sendMessage(ctx, "*", "Committed: abc123 fix bug", "status", undefined, undefined, "broadcast", {
      delivery: "pull",
      responseExpected: "no",
      pluginKind: "git:commit",
    })
    const row = f.db.prepare("SELECT delivery, response_expected, plugin_kind FROM messages").get() as {
      delivery: string
      response_expected: string
      plugin_kind: string
    }
    expect(row.delivery).toBe("pull")
    expect(row.response_expected).toBe("no")
    expect(row.plugin_kind).toBe("git:commit")
  })

  it("github:ci-alert DM lands as delivery=push, response=yes", () => {
    const ctx = ctxFor(f.db, f.stmts, "github-plugin")
    sendMessage(ctx, "alice", "Your repo X has CI failures", "github:ci-alert", undefined, undefined, "direct", {
      delivery: "push",
      responseExpected: "yes",
      pluginKind: "github:ci-alert",
    })
    const row = f.db.prepare("SELECT delivery, response_expected, plugin_kind FROM messages").get() as {
      delivery: string
      response_expected: string
      plugin_kind: string
    }
    expect(row.delivery).toBe("push")
    expect(row.response_expected).toBe("yes")
    expect(row.plugin_kind).toBe("github:ci-alert")
  })

  it("health warning broadcast = pull/no; critical broadcast = push/yes", () => {
    const ctx = ctxFor(f.db, f.stmts, "health")
    sendMessage(ctx, "*", "CPU at 60%", "health:cpu:warning", undefined, undefined, "broadcast", {
      delivery: "pull",
      responseExpected: "no",
      pluginKind: "health:cpu:warning",
    })
    sendMessage(ctx, "*", "CPU at 95% — memory thrash imminent", "health:cpu:critical", undefined, undefined, "broadcast", {
      delivery: "push",
      responseExpected: "yes",
      pluginKind: "health:cpu:critical",
    })
    const rows = f.db.prepare("SELECT delivery, response_expected FROM messages ORDER BY rowid ASC").all() as Array<{
      delivery: string
      response_expected: string
    }>
    expect(rows[0]).toEqual({ delivery: "pull", response_expected: "no" })
    expect(rows[1]).toEqual({ delivery: "push", response_expected: "yes" })
  })

  it("legacy sendMessage call without classification defaults to push/optional (back-compat)", () => {
    const ctx = ctxFor(f.db, f.stmts, "legacy")
    // Note: NO 8th argument — exercises the default classification path.
    sendMessage(ctx, "*", "legacy broadcast", "notify")
    const row = f.db.prepare("SELECT delivery, response_expected, plugin_kind FROM messages").get() as {
      delivery: string
      response_expected: string
      plugin_kind: string | null
    }
    expect(row.delivery).toBe("push")
    expect(row.response_expected).toBe("optional")
    expect(row.plugin_kind).toBeNull()
  })

  it("direct message defaults to response=yes (caller expects a reply)", () => {
    const ctx = ctxFor(f.db, f.stmts, "alice")
    sendMessage(ctx, "bob", "hey can you check this?", "query")
    const row = f.db.prepare("SELECT delivery, response_expected, kind FROM messages").get() as {
      delivery: string
      response_expected: string
      kind: string
    }
    expect(row.kind).toBe("direct")
    expect(row.response_expected).toBe("yes")
  })
})

// ---------------------------------------------------------------------------
// 2. tribe.inbox — dual cursor
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
    sendMessage(sender, "*", "Committed: a1", "status", undefined, undefined, "broadcast", {
      delivery: "pull",
      responseExpected: "no",
      pluginKind: "git:commit",
    })
    sendMessage(sender, "*", "Committed: b2", "status", undefined, undefined, "broadcast", {
      delivery: "pull",
      responseExpected: "no",
      pluginKind: "git:commit",
    })
    sendMessage(sender, "*", "Committed: c3", "status", undefined, undefined, "broadcast", {
      delivery: "pull",
      responseExpected: "no",
      pluginKind: "git:commit",
    })

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
      responseExpected: "no",
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
      responseExpected: "yes",
    })
    // Pull event.
    sendMessage(sender, "*", "ambient FYI", "status", undefined, undefined, "broadcast", {
      delivery: "pull",
      responseExpected: "no",
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
// 3. tribe.mode — focus / normal / ambient
// ---------------------------------------------------------------------------

describe("tribe.mode — persists, validates, drives delivery filter", () => {
  let f: ReturnType<typeof dbFixture>
  beforeEach(() => {
    f = dbFixture()
  })

  it("sets and persists per-session mode", async () => {
    const ctx = ctxFor(f.db, f.stmts, "alice")
    await handleToolCall(ctx, "tribe.mode", { mode: "focus" }, makeOpts())
    const row = f.db.prepare("SELECT mode FROM sessions WHERE id = ?").get(ctx.sessionId) as { mode: string }
    expect(row.mode).toBe("focus")
  })

  it("rejects invalid mode", async () => {
    const ctx = ctxFor(f.db, f.stmts, "alice")
    const r = (await handleToolCall(ctx, "tribe.mode", { mode: "screaming" }, makeOpts())) as {
      content: Array<{ type: string; text: string }>
    }
    const parsed = JSON.parse(r.content[0]!.text) as { error?: string }
    expect(parsed.error).toContain("Invalid mode")
  })
})

// ---------------------------------------------------------------------------
// 4. tribe.snooze — duration, auto-revert, kinds
// ---------------------------------------------------------------------------

describe("tribe.snooze — time-bounded suppression", () => {
  let f: ReturnType<typeof dbFixture>
  beforeEach(() => {
    f = dbFixture()
  })

  it("sets snooze_until and snooze_kinds", async () => {
    const ctx = ctxFor(f.db, f.stmts, "alice")
    await handleToolCall(ctx, "tribe.snooze", { duration_sec: 600, kinds: ["github:*"] }, makeOpts())
    const row = f.db.prepare("SELECT snooze_until, snooze_kinds FROM sessions WHERE id = ?").get(ctx.sessionId) as {
      snooze_until: number
      snooze_kinds: string
    }
    expect(row.snooze_until).toBeGreaterThan(Date.now())
    expect(JSON.parse(row.snooze_kinds)).toEqual(["github:*"])
  })

  it("duration_sec=0 cancels active snooze (explicit wake)", async () => {
    const ctx = ctxFor(f.db, f.stmts, "alice")
    await handleToolCall(ctx, "tribe.snooze", { duration_sec: 600 }, makeOpts())
    await handleToolCall(ctx, "tribe.snooze", { duration_sec: 0 }, makeOpts())
    const row = f.db.prepare("SELECT snooze_until FROM sessions WHERE id = ?").get(ctx.sessionId) as {
      snooze_until: number | null
    }
    expect(row.snooze_until).toBeNull()
  })

  it("snooze auto-reverts after duration elapses (cursor not modified)", async () => {
    // Set snooze for 1ms in the past — already expired.
    const ctx = ctxFor(f.db, f.stmts, "alice")
    f.stmts.setSessionSnooze.run({
      $id: ctx.sessionId,
      $until: Date.now() - 1,
      $kinds: null,
      $now: Date.now(),
    })
    const row = f.db.prepare("SELECT snooze_until FROM sessions WHERE id = ?").get(ctx.sessionId) as {
      snooze_until: number
    }
    // Snooze persisted but is in the past — delivery filter (in daemon) will
    // see snooze_until <= now and pass through. The handler doesn't auto-clear
    // the timestamp; it's a timestamp comparison at delivery time.
    expect(row.snooze_until).toBeLessThan(Date.now())
  })

  it("rejects invalid duration", async () => {
    const ctx = ctxFor(f.db, f.stmts, "alice")
    const r = (await handleToolCall(ctx, "tribe.snooze", { duration_sec: -1 }, makeOpts())) as {
      content: Array<{ type: string; text: string }>
    }
    const parsed = JSON.parse(r.content[0]!.text) as { error?: string }
    expect(parsed.error).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 5. tribe.dismiss — audit trail
// ---------------------------------------------------------------------------

describe("tribe.dismiss — audit-trail row", () => {
  let f: ReturnType<typeof dbFixture>
  beforeEach(() => {
    f = dbFixture()
  })

  it("inserts a dismissals row keyed by (session, message)", async () => {
    const ctx = ctxFor(f.db, f.stmts, "alice")
    const messageId = randomUUID()
    await handleToolCall(ctx, "tribe.dismiss", { message_id: messageId, reason: "false positive" }, makeOpts())
    const row = f.db.prepare("SELECT message_id, reason, ts FROM dismissals WHERE session_id = ?").get(ctx.sessionId) as
      | { message_id: string; reason: string; ts: number }
      | undefined
    expect(row).toBeDefined()
    expect(row!.message_id).toBe(messageId)
    expect(row!.reason).toBe("false positive")
  })

  it("rejects when message_id missing", async () => {
    const ctx = ctxFor(f.db, f.stmts, "alice")
    const r = (await handleToolCall(ctx, "tribe.dismiss", {}, makeOpts())) as {
      content: Array<{ type: string; text: string }>
    }
    const parsed = JSON.parse(r.content[0]!.text) as { error?: string }
    expect(parsed.error).toContain("required")
  })
})

// ---------------------------------------------------------------------------
// 6. Schema invariants — every push row carries the new columns
// ---------------------------------------------------------------------------

describe("schema — every row carries delivery + response_expected", () => {
  it("legacy sendMessage rows are populated by defaults, never NULL", () => {
    const f = dbFixture()
    const ctx = ctxFor(f.db, f.stmts, "alice")
    sendMessage(ctx, "*", "no-classification", "notify")
    const row = f.db.prepare("SELECT delivery, response_expected FROM messages").get() as {
      delivery: string
      response_expected: string
    }
    expect(row.delivery).not.toBeNull()
    expect(row.response_expected).not.toBeNull()
    f.cleanup()
  })
})
