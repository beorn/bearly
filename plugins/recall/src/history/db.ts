/**
 * Claude Session database management
 *
 * SQLite database with FTS5 for fast full-text search across Claude Code sessions.
 *
 * Barrel module: re-exports schema and queries. Owns DB lifecycle (open/close).
 */

import { Database } from "bun:sqlite"
import * as path from "path"
import * as fs from "fs"
import { DB_PATH, initSchema } from "./db-schema.ts"

// Re-export constants from schema
export { CLAUDE_DIR, DB_PATH, PROJECTS_DIR, PLANS_DIR, TODOS_DIR, MAX_CONTENT_SIZE } from "./db-schema.ts"

let dbInstance: Database | null = null

export function getDb(): Database {
  if (dbInstance) return dbInstance

  // Ensure .claude directory exists
  const claudeDir = path.dirname(DB_PATH)
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true })
  }

  dbInstance = new Database(DB_PATH)

  // Enable WAL mode for concurrent access (multiple Claude sessions)
  // WAL allows readers to not block writers and vice versa
  dbInstance.exec("PRAGMA journal_mode = WAL")
  dbInstance.exec("PRAGMA busy_timeout = 5000") // Wait 5s if locked

  initSchema(dbInstance)
  return dbInstance
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
  }
}

// Re-export schema
export { SCHEMA, MIGRATIONS, runMigrations, initSchema } from "./db-schema.ts"

// Re-export all queries
export {
  // Session operations
  upsertSession,
  updateSessionTitle,
  getSession,
  getSessionByPath,
  // Message operations
  insertMessage,
  getMessageCount,
  // Write operations
  insertWrite,
  // FTS operations
  toFts5Query,
  ftsSearch,
  ftsSearchWithSnippet,
  // Activity queries
  getActiveSessionsInWindow,
  getActivitySummary,
  // Similar query detection
  findSimilarQueries,
  // Index metadata
  setIndexMeta,
  getIndexMeta,
  // Clear tables
  clearTables,
  // Session titles
  findSessionsIndexFiles,
  readSessionTitles,
  getAllSessionTitles,
  refreshSessionTitles,
  getSessionTitle,
  // Unified content
  insertContent,
  upsertContent,
  clearContent,
  clearContentByType,
  searchAll,
  // Session context
  getSessionContext,
  // Session entries
  getAllSessionEntries,
  // File discovery
  findPlanFiles,
  findTodoFiles,
} from "./db-queries.ts"

// Re-export types
export type { MessageSearchOptions, ContentSearchOptions } from "./db-queries.ts"
