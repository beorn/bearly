/**
 * Tribe context — shared state passed to all functions instead of module globals.
 */

import type { Database } from "bun:sqlite"
import type { TribeStatements } from "./database.ts"
import type { TribeRole } from "./config.ts"
import type { MessageKind } from "./messaging.ts"

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Message-inserted hook — invoked synchronously inside `sendMessage` after
 * the row is committed. The daemon installs this to fan out to every
 * currently-connected socket whose name matches the recipient (or any name
 * for `recipient = "*"`). Absent (undefined) for standalone callers like
 * tests, which only need the durable row.
 */
export type MessageInsertedInfo = {
  id: string
  ts: number
  rowid: number
  type: string
  /** Typed message class — `direct` / `broadcast` / `event`. `event` rows are
   *  journal-only and must NOT be delivered to any client. */
  kind: MessageKind
  sender: string
  recipient: string
  content: string
  bead_id: string | null
}

export type TribeContext = {
  db: Database
  stmts: TribeStatements
  sessionId: string
  sessionRole: TribeRole
  domains: string[]
  claudeSessionId: string | null
  claudeSessionName: string | null
  getName(): string
  setName(name: string): void
  getRole(): TribeRole
  setRole(role: TribeRole): void
  onMessageInserted?: (info: MessageInsertedInfo) => void
}

export function createTribeContext(opts: {
  db: Database
  stmts: TribeStatements
  sessionId: string
  sessionRole: TribeRole
  initialName: string
  domains: string[]
  claudeSessionId: string | null
  claudeSessionName: string | null
  onMessageInserted?: (info: MessageInsertedInfo) => void
}): TribeContext {
  let currentName = opts.initialName
  let currentRole = opts.sessionRole
  return {
    db: opts.db,
    stmts: opts.stmts,
    sessionId: opts.sessionId,
    get sessionRole() {
      return currentRole
    },
    set sessionRole(r: TribeRole) {
      currentRole = r
    },
    domains: opts.domains,
    claudeSessionId: opts.claudeSessionId,
    claudeSessionName: opts.claudeSessionName,
    getName: () => currentName,
    setName: (n: string) => {
      currentName = n
    },
    getRole: () => currentRole,
    setRole: (r: TribeRole) => {
      currentRole = r
    },
    onMessageInserted: opts.onMessageInserted,
  }
}
