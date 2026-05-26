/**
 * `@km/bearly/tribe-daemon-production-hardening` — name-claim replay regression.
 *
 * Push delivery is session-id-bound. When session A holds name X, receives a
 * direct, then disconnects; further directs addressed to X journal but don't
 * fan out (no socket holds X). When a fresh session B subsequently claims X
 * via `tribe.join({name:X})` or `tribe.rename({new_name:X})`, B's pull cursor
 * is reset to the log tail at register time, so even a default `tribe.fetch`
 * steps over the gap directs.
 *
 * Fix: on name-claim, find the oldest direct addressed to the claimed name
 * that no current or prior holder of that name has had delivered, and rewind
 * the claiming session's `last_inbox_pull_seq` to surface them on the next
 * `tribe.fetch`. See `replayUnreadForClaimedName` in `messaging.ts`.
 *
 * The concrete impact this guards against: chief sends `verdict` /
 * `assign` / `query` messages to a freshly-rekeyed agent's hat name and the
 * agent never sees them — the relay-pattern that triggered the 2026-05-26
 * tribe-broken-as-business-as-usual session.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"

import { openDatabase, createStatements, type TribeStatements } from "../tools/lib/tribe/database.ts"
import { createTribeContext, type TribeContext } from "../tools/lib/tribe/context.ts"
import { sendMessage, replayUnreadForClaimedName } from "../tools/lib/tribe/messaging.ts"
import { handleToolCall } from "../tools/lib/tribe/handlers.ts"
import type { ActiveSessionInfo, HandlerOpts } from "../tools/lib/tribe/handlers.ts"

function makeOpts(overrides: Partial<HandlerOpts> = {}): HandlerOpts {
  return {
    cleanup: () => {},
    userRenamed: false,
    setUserRenamed: () => {},
    getActiveSessionIds: () => new Set<string>(),
    getActiveSessionInfo: () => [] as ActiveSessionInfo[],
    ...overrides,
  }
}

function insertSessionRow(
  db: ReturnType<typeof openDatabase>,
  sessionId: string,
  name: string,
  role: "member" | "daemon" = "member",
): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO sessions (id, name, role, domains, pid, started_at, updated_at)
     VALUES ($id, $name, $role, '[]', 0, $now, $now)`,
  ).run({ $id: sessionId, $name: name, $role: role, $now: now })
}

function makeCtx(
  db: ReturnType<typeof openDatabase>,
  stmts: TribeStatements,
  sessionId: string,
  name: string,
  role: "member" | "daemon" = "member",
): TribeContext {
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

describe("name-claim replay — gap directs surface for the new holder", () => {
  let tmpDir: string
  let db: ReturnType<typeof openDatabase>
  let stmts: TribeStatements

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-name-claim-replay-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // Core scenario — the one that breaks today
  // -------------------------------------------------------------------------

  it("session B claiming a name via rename receives directs sent to that name while it was unheld", async () => {
    // Session A registers as "adhoc1", chief sends one direct, A reads it
    // (cursor advances), then A disconnects.
    const aId = randomUUID()
    insertSessionRow(db, aId, "adhoc1")
    const aCtx = makeCtx(db, stmts, aId, "adhoc1")

    const chiefId = randomUUID()
    insertSessionRow(db, chiefId, "chief")
    const chiefCtx = makeCtx(db, stmts, chiefId, "chief")

    // chief → adhoc1 (M1) while A was online.
    const m1 = sendMessage(chiefCtx, "adhoc1", "M1: live ping", "request", undefined, undefined, "direct")
    // Simulate A draining its inbox up to M1.
    stmts.advanceInboxCursor.run({ $id: aId, $seq: m1.rowid, $now: Date.now() })
    // A disconnects — tombstone simulates the post-rekey state where the row
    // still exists with the dead-suffix name (mirrors handleJoin tombstoning).
    db.prepare("UPDATE sessions SET name = $tomb WHERE id = $id").run({
      $tomb: `adhoc1-dead-${aId.slice(0, 8)}`,
      $id: aId,
    })

    // chief → adhoc1 (M2 and M3) while NO session holds "adhoc1".
    // These journal but no fanout target exists.
    const m2 = sendMessage(chiefCtx, "adhoc1", "M2: gap direct", "verdict", undefined, undefined, "direct")
    const m3 = sendMessage(chiefCtx, "adhoc1", "M3: gap direct", "assign", undefined, undefined, "direct")

    // Session B registers — fresh sessionId, default name (say "claude1") —
    // cursor reset to tail (mimicking dispatcher's resetOffsetsToTail).
    const bId = randomUUID()
    insertSessionRow(db, bId, "claude1")
    const tail = (stmts.getMessageTailSeq.get() as { seq: number }).seq
    stmts.resetSessionDeliveryOffsets.run({ $id: bId, $ts: Date.now(), $seq: tail })

    // B renames to "adhoc1" — this is the trigger that should replay gap
    // directs. Without the fix, B's cursor stays at tail and fetch returns
    // nothing.
    const bCtx = makeCtx(db, stmts, bId, "claude1")
    const renameResult = (await handleToolCall(bCtx, "tribe.rename", { new_name: "adhoc1" }, makeOpts())) as {
      content: Array<{ text: string }>
      structuredContent: Record<string, unknown>
    }

    const renamePayload = JSON.parse(renameResult.content[0]!.text) as {
      renamed: boolean
      new_name: string
      replayed_cursor?: number
    }
    expect(renamePayload.renamed).toBe(true)
    expect(renamePayload.new_name).toBe("adhoc1")
    // The cursor should be rewound to (m2.rowid - 1) so the next fetch
    // returns M2 and M3 (the gap directs).
    expect(renamePayload.replayed_cursor).toBe(m2.rowid - 1)

    // Verify the fetch surfaces M2 and M3 (but NOT M1, which A already drained).
    const fetchResult = (await handleToolCall(bCtx, "tribe.fetch", { limit: 50 }, makeOpts())) as {
      content: Array<{ text: string }>
    }
    const fetchPayload = JSON.parse(fetchResult.content[0]!.text) as {
      events: Array<{ id: string; from: string; to: string; content: string; type: string }>
    }
    const ids = fetchPayload.events.map((e) => e.id)
    expect(ids).toContain(m2.id)
    expect(ids).toContain(m3.id)
    // Sanity: M1 stays drained — A's last_delivered_seq covered it, so the
    // watermark excludes M1.
    expect(ids).not.toContain(m1.id)
  })

  // -------------------------------------------------------------------------
  // tribe.join path mirrors tribe.rename
  // -------------------------------------------------------------------------

  it("session B claiming a name via join also surfaces gap directs", async () => {
    // Prior holder disconnects without ever draining (degenerate but realistic
    // — A connects, never reads, then process dies).
    const aId = randomUUID()
    insertSessionRow(db, aId, "ghost1")
    // No cursor advance: A never read anything.
    db.prepare("UPDATE sessions SET name = $tomb WHERE id = $id").run({
      $tomb: `ghost1-dead-${aId.slice(0, 8)}`,
      $id: aId,
    })

    const chiefId = randomUUID()
    insertSessionRow(db, chiefId, "chief")
    const chiefCtx = makeCtx(db, stmts, chiefId, "chief")

    const m1 = sendMessage(chiefCtx, "ghost1", "M1: ghost message", "query", undefined, undefined, "direct")

    // Session B registers, then joins as "ghost1".
    const bId = randomUUID()
    insertSessionRow(db, bId, "claude1")
    const tail = (stmts.getMessageTailSeq.get() as { seq: number }).seq
    stmts.resetSessionDeliveryOffsets.run({ $id: bId, $ts: Date.now(), $seq: tail })

    const bCtx = makeCtx(db, stmts, bId, "claude1")
    const joinResult = (await handleToolCall(bCtx, "tribe.join", { name: "ghost1" }, makeOpts())) as {
      content: Array<{ text: string }>
    }
    const joinPayload = JSON.parse(joinResult.content[0]!.text) as {
      joined: boolean
      name: string
      replayed_cursor?: number
    }
    expect(joinPayload.joined).toBe(true)
    expect(joinPayload.name).toBe("ghost1")
    // A never drained, so the watermark falls through to 0 and the cursor
    // rewinds to (m1.rowid - 1).
    expect(joinPayload.replayed_cursor).toBe(m1.rowid - 1)

    const fetchResult = (await handleToolCall(bCtx, "tribe.fetch", { limit: 50 }, makeOpts())) as {
      content: Array<{ text: string }>
    }
    const fetchPayload = JSON.parse(fetchResult.content[0]!.text) as {
      events: Array<{ id: string }>
    }
    expect(fetchPayload.events.map((e) => e.id)).toContain(m1.id)
  })

  // -------------------------------------------------------------------------
  // No-op path — nothing to replay
  // -------------------------------------------------------------------------

  it("rename to a name with no unread directs does not rewind the cursor", async () => {
    const bId = randomUUID()
    insertSessionRow(db, bId, "claude1")
    const tail = (stmts.getMessageTailSeq.get() as { seq: number }).seq
    stmts.resetSessionDeliveryOffsets.run({ $id: bId, $ts: Date.now(), $seq: tail })
    const cursorBefore = (stmts.getInboxCursor.get({ $id: bId }) as { last_inbox_pull_seq: number }).last_inbox_pull_seq

    const bCtx = makeCtx(db, stmts, bId, "claude1")
    const renameResult = (await handleToolCall(bCtx, "tribe.rename", { new_name: "fresh-name" }, makeOpts())) as {
      content: Array<{ text: string }>
    }
    const renamePayload = JSON.parse(renameResult.content[0]!.text) as {
      renamed: boolean
      replayed_cursor?: number
    }
    expect(renamePayload.renamed).toBe(true)
    expect(renamePayload.replayed_cursor).toBeUndefined()

    const cursorAfter = (stmts.getInboxCursor.get({ $id: bId }) as { last_inbox_pull_seq: number }).last_inbox_pull_seq
    expect(cursorAfter).toBe(cursorBefore)
  })

  // -------------------------------------------------------------------------
  // Helper-level invariant — rewind is monotonic-down (never raises cursor)
  // -------------------------------------------------------------------------

  it("replayUnreadForClaimedName never raises the cursor above its current value", async () => {
    const aId = randomUUID()
    insertSessionRow(db, aId, "adhoc1")
    const aCtx = makeCtx(db, stmts, aId, "adhoc1")
    // Force A's cursor far in the past.
    stmts.resetSessionDeliveryOffsets.run({ $id: aId, $ts: Date.now(), $seq: 0 })

    const chiefId = randomUUID()
    insertSessionRow(db, chiefId, "chief")
    const chiefCtx = makeCtx(db, stmts, chiefId, "chief")
    sendMessage(chiefCtx, "adhoc1", "M1", "notify", undefined, undefined, "direct")

    // Cursor at 0 → already exposes the message. Replay finds an "oldest unread"
    // but the target (rowid-1) ≥ current cursor (0) only when rowid-1 ≥ 0, i.e.
    // rowid ≥ 1; current cursor is 0, so target == 0 ≥ 0 → no rewind (per `target >= currentCursor`).
    const result = replayUnreadForClaimedName(aCtx, "adhoc1")
    expect(result).toBeNull()
    const cursorAfter = (stmts.getInboxCursor.get({ $id: aId }) as { last_inbox_pull_seq: number }).last_inbox_pull_seq
    expect(cursorAfter).toBe(0)
  })
})
