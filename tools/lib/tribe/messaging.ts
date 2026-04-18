/**
 * Tribe messaging — send messages and log events.
 */

import { randomUUID } from "node:crypto"
import type { TribeContext } from "./context.ts"

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export function sendMessage(
  ctx: TribeContext,
  recipient: string,
  content: string,
  type = "notify",
  bead_id?: string,
  ref?: string,
): { id: string } {
  const id = randomUUID()
  ctx.stmts.insertMessage.run({
    $id: id,
    $type: type,
    $sender: ctx.getName(),
    $recipient: recipient,
    $content: content,
    $bead_id: bead_id ?? null,
    $ref: ref ?? null,
    $ts: Date.now(),
  })
  return { id }
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
