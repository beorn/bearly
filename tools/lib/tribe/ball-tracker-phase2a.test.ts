/**
 * @km/tribe/message-ball-tracker — Phase 2a wire-up test.
 *
 * Verifies the end-to-end ball-tracker semantics for the 1:1 (single-recipient)
 * case:
 *
 *  (1) `sendMessage(..., { request: "<id>" })` writes both the messages row
 *      (with `request` column populated) AND a pending_request row for the
 *      recipient.
 *  (2) `sendMessage(..., { reply: "<id>" })` writes the messages row AND
 *      deletes the matching pending_request row (sender=>recipient swapped
 *      since the reply flows back).
 *  (3) Event rows (kind='event' via logEvent) never participate — no
 *      pending_request row is created even if request were set.
 *  (4) `selectPendingForRecipient` returns open requests sorted oldest-first.
 *
 * Phase 2b will cover broadcast + multi-target fanout (recipient snapshot from
 * room_members for `to: "*"`, explicit list for `to: [...]`).
 */

import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { createTribeContext, type TribeContext } from "./context.ts"
import { sendMessage } from "./messaging.ts"

function makeContext(db: Database, stmts: TribeStatements, name: string): TribeContext {
  return createTribeContext({
    db,
    stmts,
    sessionId: `sess-${name}`,
    sessionRole: "member",
    initialName: name,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
}

describe("ball-tracker Phase 2a — 1:1 wire-up", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ball-tracker-phase2a-"))
    const dbPath = join(tmpDir, "tribe.db")
    db = openDatabase(dbPath)
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("request: opens a pending_request row for the recipient", () => {
    const chief = makeContext(db, stmts, "@chief")
    const result = sendMessage(
      chief,
      "@agent/8",
      "verdict needed",
      "query",
      undefined,
      undefined,
      "direct",
      {},
      { request: "req-abc-123" },
    )

    // Message row carries the request column.
    const msgRow = db
      .prepare("SELECT request, reply FROM messages WHERE id = ?")
      .get(result.id) as { request: string | null; reply: string | null }
    expect(msgRow.request).toBe("req-abc-123")
    expect(msgRow.reply).toBeNull()

    // Pending row exists for the recipient.
    const pendingRows = db
      .prepare("SELECT request_id, recipient, sender, message_id, fanout FROM pending_request WHERE request_id = ?")
      .all("req-abc-123") as Array<{
      request_id: string
      recipient: string
      sender: string
      message_id: string
      fanout: string
    }>
    expect(pendingRows).toHaveLength(1)
    expect(pendingRows[0]).toMatchObject({
      request_id: "req-abc-123",
      recipient: "@agent/8",
      sender: "@chief",
      message_id: result.id,
      fanout: "first",
    })
  })

  it("reply: closes the matching pending_request row", () => {
    const chief = makeContext(db, stmts, "@chief")
    const agent = makeContext(db, stmts, "@agent/8")

    // Open: chief → agent/8
    sendMessage(chief, "@agent/8", "verdict needed", "query", undefined, undefined, "direct", {}, {
      request: "req-xyz-789",
    })
    expect(
      (db.prepare("SELECT COUNT(*) as c FROM pending_request WHERE request_id = ?").get("req-xyz-789") as { c: number })
        .c,
    ).toBe(1)

    // Close: agent/8 → chief with reply
    sendMessage(agent, "@chief", "yes, ship it", "response", undefined, undefined, "direct", {}, {
      reply: "req-xyz-789",
    })

    // Pending row gone.
    expect(
      (db.prepare("SELECT COUNT(*) as c FROM pending_request WHERE request_id = ?").get("req-xyz-789") as { c: number })
        .c,
    ).toBe(0)

    // But the messages rows are both still there.
    const msgs = db
      .prepare("SELECT type, sender, request, reply FROM messages WHERE request = ? OR reply = ?")
      .all("req-xyz-789", "req-xyz-789") as Array<{
      type: string
      sender: string
      request: string | null
      reply: string | null
    }>
    expect(msgs).toHaveLength(2)
    const open = msgs.find((m) => m.request === "req-xyz-789")
    const close = msgs.find((m) => m.reply === "req-xyz-789")
    expect(open?.sender).toBe("@chief")
    expect(open?.type).toBe("query")
    expect(close?.sender).toBe("@agent/8")
    expect(close?.type).toBe("response")
  })

  it("fanout='all' is recorded but Phase 2a still uses per-recipient close semantics", () => {
    const chief = makeContext(db, stmts, "@chief")
    sendMessage(chief, "@agent/8", "individual ack please", "request", undefined, undefined, "direct", {}, {
      request: "req-fanout-all",
      fanout: "all",
    })
    const row = db
      .prepare("SELECT fanout FROM pending_request WHERE request_id = ?")
      .get("req-fanout-all") as { fanout: string } | null
    expect(row?.fanout).toBe("all")
  })

  it("event-kind rows never write pending_request even with request set", () => {
    const chief = makeContext(db, stmts, "@chief")
    sendMessage(chief, "@agent/8", "shouldn't track", "notify", undefined, undefined, "event", {}, {
      request: "req-event-should-be-skipped",
    })
    const rows = db
      .prepare("SELECT COUNT(*) as c FROM pending_request WHERE request_id = ?")
      .get("req-event-should-be-skipped") as { c: number }
    expect(rows.c).toBe(0)
  })

  it("broadcast (`*`) skips pending_request — Phase 2b will resolve recipient snapshot", () => {
    const chief = makeContext(db, stmts, "@chief")
    sendMessage(chief, "*", "all-hands", "notify", undefined, undefined, "direct", {}, {
      request: "req-broadcast-deferred",
    })
    // Phase 2a: broadcast doesn't open a tracker (requires room_members snapshot).
    const rows = db
      .prepare("SELECT COUNT(*) as c FROM pending_request WHERE request_id = ?")
      .get("req-broadcast-deferred") as { c: number }
    expect(rows.c).toBe(0)
    // But the message row itself records the request id — Phase 2b can backfill
    // pending_request from the broadcast message + room_members.
    const msg = db
      .prepare("SELECT request, kind FROM messages WHERE request = ?")
      .get("req-broadcast-deferred") as { request: string; kind: string } | null
    expect(msg?.request).toBe("req-broadcast-deferred")
    expect(msg?.kind).toBe("broadcast")
  })

  it("messages without request/reply leave pending_request untouched", () => {
    const chief = makeContext(db, stmts, "@chief")
    sendMessage(chief, "@agent/8", "plain notify", "notify")
    const count = (db.prepare("SELECT COUNT(*) as c FROM pending_request").get() as { c: number }).c
    expect(count).toBe(0)
  })

  it("selectPendingForRecipient returns rows oldest-first", () => {
    const chief = makeContext(db, stmts, "@chief")
    sendMessage(chief, "@agent/8", "first", "request", undefined, undefined, "direct", {}, { request: "req-1" })
    // Force a 2ms gap so opened_at differs deterministically.
    const start = Date.now()
    while (Date.now() - start < 2) {
      // spin
    }
    sendMessage(chief, "@agent/8", "second", "request", undefined, undefined, "direct", {}, { request: "req-2" })

    const pending = stmts.selectPendingForRecipient.all({ $recipient: "@agent/8" }) as Array<{
      request_id: string
    }>
    expect(pending.map((p) => p.request_id)).toEqual(["req-1", "req-2"])
  })

  it("idempotent: re-opening same (request_id, recipient) is a no-op (ON CONFLICT DO NOTHING)", () => {
    const chief = makeContext(db, stmts, "@chief")
    sendMessage(chief, "@agent/8", "first send", "request", undefined, undefined, "direct", {}, {
      request: "req-dedup",
    })
    sendMessage(chief, "@agent/8", "second send", "request", undefined, undefined, "direct", {}, {
      request: "req-dedup",
    })
    const rows = (db.prepare("SELECT COUNT(*) as c FROM pending_request WHERE request_id = ?").get("req-dedup") as {
      c: number
    }).c
    expect(rows).toBe(1)
  })
})
