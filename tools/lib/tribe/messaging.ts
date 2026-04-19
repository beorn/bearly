/**
 * Tribe messaging — send messages and log events.
 */

import { randomUUID } from "node:crypto"
import type { TribeContext } from "./context.ts"

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Insert a message row and (optionally) fan out to connected sockets.
 *
 * The daemon wires its fan-out hook through `ctx.onMessageInserted` so that
 * handlers in this file don't need to know about sockets. Standalone callers
 * (tests, migrations) don't set the hook — the row still lands in SQLite,
 * which is the durability baseline.
 *
 * `rowid` is returned so the daemon can advance per-recipient
 * `sessions.last_delivered_seq` after a successful write().
 */
export function sendMessage(
  ctx: TribeContext,
  recipient: string,
  content: string,
  type = "notify",
  bead_id?: string,
  ref?: string,
): { id: string; ts: number; rowid: number } {
  const id = randomUUID()
  const ts = Date.now()
  const result = ctx.stmts.insertMessage.run({
    $id: id,
    $type: type,
    $sender: ctx.getName(),
    $recipient: recipient,
    $content: content,
    $bead_id: bead_id ?? null,
    $ref: ref ?? null,
    $ts: ts,
  })
  const rowid = Number(result.lastInsertRowid)
  ctx.onMessageInserted?.({
    id,
    ts,
    rowid,
    type,
    sender: ctx.getName(),
    recipient,
    content,
    bead_id: bead_id ?? null,
  })
  return { id, ts, rowid }
}

/**
 * Log an event as a message with type `event.<type>` and recipient `log`.
 * The `log` recipient is a sentinel — never delivered to any session, but
 * queryable via `SELECT * FROM messages WHERE type LIKE 'event.%'`.
 */
export function logEvent(ctx: TribeContext, type: string, bead_id?: string, data?: Record<string, unknown>): void {
  ctx.stmts.insertMessage.run({
    $id: randomUUID(),
    $type: `event.${type}`,
    $sender: ctx.getName(),
    $recipient: "log",
    $content: data ? JSON.stringify(data) : "",
    $bead_id: bead_id ?? null,
    $ref: null,
    $ts: Date.now(),
  })
}
