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
  getName(): string
  setName(name: string): void
  getRole(): TribeRole
  setRole(role: TribeRole): void
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
  }
}
