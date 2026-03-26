/**
 * Tribe polling — check for new messages and push as channel notifications.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import type { TribeContext } from "./context.ts"

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export function createPoller(ctx: TribeContext, mcp: Server) {
  let polling = false

  return async function pollMessages(): Promise<void> {
    if (polling) return
    polling = true
    try {
      try {
        const cursor = ctx.stmts.getCursor.get({ $session_id: ctx.sessionId }) as {
          last_read_ts: number
          last_seq: number | null
        } | null
        const lastSeq = cursor?.last_seq ?? 0

        const rows = ctx.stmts.pollMessages.all({
          $last_seq: lastSeq,
          $name: ctx.getName(),
          $session_id: ctx.sessionId,
        }) as Array<{
          rowid: number
          id: string
          type: string
          sender: string
          recipient: string
          content: string
          bead_id: string
          ref: string
          ts: number
        }>

        // Don't deliver our own messages back to us
        const incoming = rows.filter((r) => r.sender !== ctx.getName())

        for (const msg of incoming) {
          const meta: Record<string, string> = {
            from: msg.sender,
            type: msg.type,
            message_id: msg.id,
          }
          if (msg.bead_id) meta.bead = msg.bead_id
          if (msg.ref) meta.ref = msg.ref

          await mcp.notification({
            method: "notifications/claude/channel",
            params: { content: msg.content, meta },
          })

          ctx.stmts.markRead.run({ $message_id: msg.id, $session_id: ctx.sessionId, $now: Date.now() })
        }

        // Advance cursor to latest rowid (including our own messages)
        if (rows.length > 0) {
          const maxSeq = Math.max(...rows.map((r) => r.rowid))
          const maxTs = Math.max(...rows.map((r) => r.ts))
          ctx.stmts.upsertCursor.run({ $session_id: ctx.sessionId, $ts: maxTs, $seq: maxSeq })
          // Track last delivery so reconnecting sessions skip already-delivered messages
          if (incoming.length > 0) {
            ctx.stmts.updateLastDelivered.run({ $id: ctx.sessionId, $ts: maxTs, $seq: maxSeq })
          }
        }
      } catch {
        // SQLite busy or other transient error — retry next poll
      }
    } finally {
      polling = false
    }
  }
}
