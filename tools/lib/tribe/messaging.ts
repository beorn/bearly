/**
 * Tribe messaging — send messages and log events.
 */

import { randomUUID } from "node:crypto"
import type { TribeContext } from "./context.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * `MessageKind` describes the *transport* class of a row in `messages`:
 *
 *   - `direct`    — addressed to a single recipient (recipient = session name)
 *   - `broadcast` — addressed to everyone (recipient = '*')
 *   - `event`     — journal-only row, never delivered to any client
 *                   (recipient = '*' but delivery filter checks `kind` first)
 *
 * Classification (actionable vs ambient) lives on the separate `delivery`
 * column — see `Delivery` below. The two axes are independent: a broadcast
 * can be `push` (actionable bell) or `pull` (ambient inbox-only), and a
 * direct message is always `push`.
 */
export type MessageKind = "direct" | "broadcast" | "event"

/**
 * `Delivery` is the km-tribe.event-classification routing class:
 *
 *   - `push` — actionable: fanned out down the MCP channel + lands in inbox
 *   - `pull` — ambient: lands in inbox only; the agent reads it when it asks
 *
 * Default for back-compat is `push` (existing call sites unchanged).
 */
export type Delivery = "push" | "pull"

/**
 * `ResponseExpected` is the per-event hint surfaced on the channel envelope
 * so the LLM can decide whether to reply at all:
 *
 *   - `yes`      — direct query / blocker / assignment → reply via tribe.send
 *   - `optional` — FYI that might warrant action → agent decides
 *   - `no`       — silent read is the correct response (most ambient kinds)
 */
export type ResponseExpected = "yes" | "no" | "optional"

/**
 * Optional classification metadata for a message. All fields are optional
 * for back-compat — pass nothing and the row defaults to push / optional.
 */
export type Classification = {
  delivery?: Delivery
  responseExpected?: ResponseExpected
  pluginKind?: string
  roomId?: string
}

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
  classification: Classification = {},
): { id: string; ts: number; rowid: number } {
  const id = randomUUID()
  const ts = Date.now()
  // Default kind inference: '*' is a broadcast unless the caller explicitly
  // passed 'event'. This keeps existing call sites correct without audit.
  const resolvedKind: MessageKind = kind === "event" ? "event" : recipient === "*" ? "broadcast" : kind
  // Direct messages are inherently actionable. Events are journal-only and
  // never delivered, so delivery is irrelevant — keep the column populated for
  // schema invariants.
  const delivery: Delivery =
    classification.delivery ?? (resolvedKind === "direct" ? "push" : resolvedKind === "event" ? "push" : "push")
  const responseExpected: ResponseExpected =
    classification.responseExpected ?? (resolvedKind === "direct" ? "yes" : "optional")
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
    $response_expected: responseExpected,
    $delivery: delivery,
    $plugin_kind: classification.pluginKind ?? null,
    $room_id: classification.roomId ?? null,
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
    delivery,
    responseExpected,
    pluginKind: classification.pluginKind ?? null,
    roomId: classification.roomId ?? null,
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
    // Event rows are journal-only; the daemon's broadcastToConnected drops
    // kind='event' before delivery. These columns are still populated to keep
    // schema invariants — every row carries a delivery class.
    $response_expected: "no",
    $delivery: "push",
    $plugin_kind: null,
    $room_id: null,
  })
}
