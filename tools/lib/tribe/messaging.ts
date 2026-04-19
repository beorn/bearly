/**
 * Tribe messaging — send messages and log events.
 */

import { randomUUID } from "node:crypto"
import type { TribeContext } from "./context.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * `MessageKind` is the typed replacement for the former `recipient='log'`
 * string sentinel. Every row in `messages` carries a `kind` column:
 *
 *   - `direct`    — addressed to a single recipient (recipient = session name)
 *   - `broadcast` — addressed to everyone (recipient = '*')
 *   - `event`     — journal-only row, never delivered to any client
 *                   (recipient = '*' but delivery filter checks `kind` first)
 */
export type MessageKind = "direct" | "broadcast" | "event"

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
 *
 * `kind` defaults to `direct` for backward compatibility. Broadcasts should
 * pass `broadcast`; journal-only events should pass `event` (and route via
 * `logEvent` which sets the type prefix).
 */
export function sendMessage(
  ctx: TribeContext,
  recipient: string,
  content: string,
  type = "notify",
  bead_id?: string,
  ref?: string,
  kind: MessageKind = "direct",
): { id: string; ts: number; rowid: number } {
  const id = randomUUID()
  const ts = Date.now()
  // Default kind inference: '*' is a broadcast unless the caller explicitly
  // passed 'event'. This keeps existing call sites correct without audit.
  const resolvedKind: MessageKind = kind === "event" ? "event" : recipient === "*" ? "broadcast" : kind
  const result = ctx.stmts.insertMessage.run({
    $id: id,
    $type: type,
    $sender: ctx.getName(),
    $recipient: recipient,
    $kind: resolvedKind,
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
    kind: resolvedKind,
    sender: ctx.getName(),
    recipient,
    content,
    bead_id: bead_id ?? null,
  })
  return { id, ts, rowid }
}

/**
 * Log an event — a journal-only row that lands in `messages` but is never
 * delivered to any client. Rows are tagged with `kind='event'` and prefixed
 * type `event.<type>`, queryable via
 * `SELECT * FROM messages WHERE kind = 'event'`.
 *
 * Recipient is `'*'` so the row still participates in broadcast-style history
 * queries that join on recipient; the delivery-side filter
 * (`broadcastToConnected`) skips `kind='event'` rows before fanning out.
 */
export function logEvent(ctx: TribeContext, type: string, bead_id?: string, data?: Record<string, unknown>): void {
  ctx.stmts.insertMessage.run({
    $id: randomUUID(),
    $type: `event.${type}`,
    $sender: ctx.getName(),
    $recipient: "*",
    $kind: "event",
    $content: data ? JSON.stringify(data) : "",
    $bead_id: bead_id ?? null,
    $ref: null,
    $ts: Date.now(),
  })
}
