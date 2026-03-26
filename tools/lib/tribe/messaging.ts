/**
 * Tribe messaging — send messages and log events.
 */

import { randomUUID } from "node:crypto"
import type { TribeStatements } from "./database.ts"
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

export function logEvent(ctx: TribeContext, type: string, bead_id?: string, data?: Record<string, unknown>): void {
  ctx.stmts.insertEvent.run({
    $id: randomUUID(),
    $type: type,
    $session: ctx.getName(),
    $bead_id: bead_id ?? null,
    $data: data ? JSON.stringify(data) : null,
    $ts: Date.now(),
  })
}
