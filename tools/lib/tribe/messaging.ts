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
 * `ReplyHint` is the per-event hint the daemon derives at delivery time
 * from `(kind, recipient, senderRole)` — see `deriveReplyHint` below. It
 * is no longer persisted on the row (the column was dropped by migration
 * v11) and is no longer surfaced on the channel envelope. The type is
 * exported only because the broadcast pipeline still uses it as a return
 * shape (and `tribe.filter` mode `focus` still gates on it).
 *
 *   - `yes`      — direct DM from a peer member → reply via tribe.send
 *   - `optional` — broadcast / system / daemon push → agent decides
 *   - `no`       — ambient (event row) → silent read is correct
 */
export type ReplyHint = "yes" | "no" | "optional"

/**
 * Optional classification metadata for a message. All fields are optional —
 * pass nothing and the row defaults to push delivery.
 */
export type Classification = {
  delivery?: Delivery
  pluginKind?: string
  roomId?: string
}

/**
 * Derive the channel-envelope reply hint from the durable message metadata.
 * Replaces the persisted column dropped by migration v11 — every consumer
 * that needs the hint computes it on demand.
 *
 *   - `event` rows are journal-only, never delivered → `'no'`
 *   - `'*'` recipient (broadcast) → `'optional'` regardless of sender
 *   - sender role of `daemon` / `system` (plugin emits) → `'optional'`
 *   - everything else (direct DM from a peer member) → `'yes'`
 */
export function deriveReplyHint(opts: {
  kind: MessageKind
  recipient: string
  senderRole: string
}): ReplyHint {
  if (opts.kind === "event") return "no"
  if (opts.recipient === "*") return "optional"
  if (opts.senderRole === "daemon" || opts.senderRole === "system") return "optional"
  return "yes"
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
  const delivery: Delivery = classification.delivery ?? "push"
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
    senderRole: ctx.getRole(),
    recipient,
    content,
    bead_id: bead_id ?? null,
    delivery,
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
    // kind='event' before delivery. The delivery column is still populated to
    // keep schema invariants — every row carries a delivery class.
    $delivery: "push",
    $plugin_kind: null,
    $room_id: null,
  })
}
