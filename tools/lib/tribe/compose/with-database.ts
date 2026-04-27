/**
 * withDatabase — open the tribe SQLite database, register close on Scope.
 *
 * The DB is opened at composition time (synchronous via bun:sqlite). Closing
 * is registered on the daemon's root scope, so a clean shutdown / hot-reload
 * cleanup / test teardown closes the connection in LIFO order with the rest.
 */

import type { Database } from "bun:sqlite"
import { openDatabase, createStatements, type TribeStatements } from "../database.ts"
import type { BaseTribe } from "./base.ts"
import type { WithConfig } from "./with-config.ts"

export interface WithDatabase {
  readonly db: Database
  readonly stmts: TribeStatements
}

export function withDatabase<T extends BaseTribe & WithConfig>(): (t: T) => T & WithDatabase {
  return (t) => {
    const db = openDatabase(t.config.dbPath)
    const stmts = createStatements(db)
    t.scope.defer(() => {
      try {
        db.close()
      } catch {
        /* already closed */
      }
    })
    return { ...t, db, stmts }
  }
}
