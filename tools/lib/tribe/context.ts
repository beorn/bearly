/**
 * Tribe context — shared state passed to all functions instead of module globals.
 */

import type { Database } from "bun:sqlite"
import type { TribeStatements } from "./database.ts"
import type { TribeRole } from "./config.ts"

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type TribeContext = {
  db: Database
  stmts: TribeStatements
  sessionId: string
  sessionRole: TribeRole
  domains: string[]
  claudeSessionId: string | null
  claudeSessionName: string | null
  /** Get current name (may change after rename) */
  getName(): string
  /** Set current name (after rename) */
  setName(name: string): void
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
}): TribeContext {
  let currentName = opts.initialName
  return {
    db: opts.db,
    stmts: opts.stmts,
    sessionId: opts.sessionId,
    sessionRole: opts.sessionRole,
    domains: opts.domains,
    claudeSessionId: opts.claudeSessionId,
    claudeSessionName: opts.claudeSessionName,
    getName: () => currentName,
    setName: (name: string) => {
      currentName = name
    },
  }
}
