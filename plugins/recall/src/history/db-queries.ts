/**
 * Database query functions — prepared statement wrappers, getters, setters, search.
 */

import { Database } from "bun:sqlite"
import * as path from "path"
import * as fs from "fs"
import type { SessionRecord, MessageRecord, ContentType, ContentRecord, SessionIndexEntry } from "./types.ts"
import { PROJECTS_DIR, PLANS_DIR, TODOS_DIR } from "./db-schema.ts"

// ============================================================================
// Session operations
// ============================================================================

export function upsertSession(
  db: Database,
  id: string,
  projectPath: string,
  jsonlPath: string,
  createdAt: number,
  updatedAt: number,
  messageCount: number,
  title?: string | null,
): void {
  db.prepare(`
    INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      updated_at = excluded.updated_at,
      message_count = excluded.message_count,
      title = COALESCE(excluded.title, sessions.title)
  `).run(id, projectPath, jsonlPath, createdAt, updatedAt, messageCount, title ?? null)
}

export function updateSessionTitle(db: Database, id: string, title: string | null): void {
  db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(title, id)
}

export function getSession(db: Database, id: string): SessionRecord | undefined {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRecord | undefined
}

export function getSessionByPath(db: Database, jsonlPath: string): SessionRecord | undefined {
  return db.prepare("SELECT * FROM sessions WHERE jsonl_path = ?").get(jsonlPath) as SessionRecord | undefined
}

// ============================================================================
// Message operations
// ============================================================================

export function insertMessage(
  db: Database,
  uuid: string | null,
  sessionId: string,
  type: string,
  content: string | null,
  toolName: string | null,
  filePaths: string | null,
  timestamp: number,
): number {
  const result = db
    .prepare(`
    INSERT INTO messages (uuid, session_id, type, content, tool_name, file_paths, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
    .run(uuid, sessionId, type, content, toolName, filePaths, timestamp)
  return Number(result.lastInsertRowid)
}

export function getMessageCount(db: Database, sessionId: string): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").get(sessionId) as {
    count: number
  }
  return row.count
}

// ============================================================================
// Write operations (backwards compatible)
// ============================================================================

export function insertWrite(
  db: Database,
  sessionId: string,
  sessionFile: string,
  toolUseId: string,
  timestamp: string,
  filePath: string,
  contentHash: string,
  contentSize: number,
  content: string | null,
): void {
  db.prepare(`
    INSERT INTO writes (session_id, session_file, tool_use_id, timestamp, file_path, content_hash, content_size, content)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, sessionFile, toolUseId, timestamp, filePath, contentHash, contentSize, content)
}

// ============================================================================
// FTS operations
// ============================================================================

/**
 * Escape a token for FTS5 query syntax.
 * FTS5 treats certain characters specially (e.g., . is column selector).
 * Tokens with special characters are quoted as phrases.
 */
function escapeToken(token: string): { text: string; quoted: boolean } {
  // Strip trailing punctuation that would confuse FTS5
  const cleaned = token.replace(/[?!.,;]+$/, "")
  if (cleaned.length === 0) return { text: '""', quoted: true }
  // Always quote as phrase — bulletproof against any FTS5 special chars.
  // Only need to escape internal double quotes by doubling them.
  return { text: `"${cleaned.replace(/"/g, '""')}"`, quoted: true }
}

// Convert search query to FTS5 syntax
export function toFts5Query(query: string): string {
  // Handle quoted phrases
  const phrases: string[] = []
  const remaining = query.replace(/"([^"]+)"/g, (_, phrase) => {
    phrases.push(phrase)
    return `__PHRASE_${phrases.length - 1}__`
  })

  // Split into tokens
  const tokens = remaining.split(/\s+/).filter(Boolean)
  const parts: string[] = []

  for (const token of tokens) {
    const phraseMatch = token.match(/^__PHRASE_(\d+)__$/)
    if (phraseMatch) {
      const idx = parseInt(phraseMatch[1]!, 10)
      const phrase = phrases[idx]
      if (phrase !== undefined) {
        // FTS5 phrase syntax: "word1 word2 word3"
        parts.push(`"${phrase}"`)
      }
    } else if (token.startsWith("-")) {
      // Negation: NOT term
      const term = token.slice(1)
      const escaped = escapeToken(term)
      // Quoted phrases can't use prefix matching
      parts.push(`NOT ${escaped.text}${escaped.quoted ? "" : "*"}`)
    } else {
      // Prefix match for each term (unless quoted)
      const escaped = escapeToken(token)
      parts.push(`${escaped.text}${escaped.quoted ? "" : "*"}`)
    }
  }

  return parts.join(" ")
}

export function ftsSearch(
  db: Database,
  query: string,
  options: { limit?: number; offset?: number; projectFilter?: string } = {},
): { results: MessageRecord[]; total: number } {
  const { limit = 50, offset = 0, projectFilter } = options

  // Convert search query to FTS5 syntax
  const ftsQuery = toFts5Query(query)

  let countQuery = `
    SELECT COUNT(*) as total
    FROM messages_fts f
    JOIN messages m ON f.rowid = m.id
    JOIN sessions s ON m.session_id = s.id
    WHERE messages_fts MATCH ?
  `
  let searchQuery = `
    SELECT m.*, s.project_path, bm25(messages_fts, 10.0, 1.0, 2.0) as rank
    FROM messages_fts f
    JOIN messages m ON f.rowid = m.id
    JOIN sessions s ON m.session_id = s.id
    WHERE messages_fts MATCH ?
  `

  const params: (string | number)[] = [ftsQuery]

  if (projectFilter) {
    const projectClause = ` AND s.project_path LIKE ?`
    countQuery += projectClause
    searchQuery += projectClause
    params.push(`%${projectFilter}%`)
  }

  searchQuery += ` ORDER BY rank LIMIT ? OFFSET ?`

  const totalRow = db.prepare(countQuery).get(...params) as { total: number }
  const results = db.prepare(searchQuery).all(...params, limit, offset) as MessageRecord[]

  return { results, total: totalRow.total }
}

export interface MessageSearchOptions {
  limit?: number
  offset?: number
  projectFilter?: string
  projectGlob?: string // Glob pattern for project matching
  sinceTime?: number // Filter messages after this timestamp
  messageType?: "user" | "assistant" // Filter by message type
  toolName?: string // Filter by tool name
  sessionId?: string // Filter by session ID
  snippetTokens?: number // Snippet window size (default 64)
}

export function ftsSearchWithSnippet(
  db: Database,
  query: string,
  options: MessageSearchOptions = {},
): {
  results: (MessageRecord & {
    snippet: string
    project_path: string
    rank: number
  })[]
  total: number
} {
  const {
    limit = 50,
    offset = 0,
    projectFilter,
    sinceTime,
    messageType,
    toolName,
    sessionId,
    snippetTokens = 64,
  } = options

  const ftsQuery = toFts5Query(query)

  let countQuery = `
    SELECT COUNT(*) as total
    FROM messages_fts f
    JOIN messages m ON f.rowid = m.id
    JOIN sessions s ON m.session_id = s.id
    WHERE messages_fts MATCH ?
  `
  let searchQuery = `
    SELECT m.*, s.project_path,
           snippet(messages_fts, 0, '>>>', '<<<', '...', ${snippetTokens}) as snippet,
           bm25(messages_fts, 10.0, 1.0, 2.0) as rank
    FROM messages_fts f
    JOIN messages m ON f.rowid = m.id
    JOIN sessions s ON m.session_id = s.id
    WHERE messages_fts MATCH ?
  `

  const params: (string | number)[] = [ftsQuery]

  if (projectFilter) {
    const projectClause = ` AND s.project_path LIKE ?`
    countQuery += projectClause
    searchQuery += projectClause
    params.push(`%${projectFilter}%`)
  }

  if (sinceTime !== undefined) {
    const timeClause = ` AND m.timestamp >= ?`
    countQuery += timeClause
    searchQuery += timeClause
    params.push(sinceTime)
  }

  if (messageType) {
    const typeClause = ` AND m.type = ?`
    countQuery += typeClause
    searchQuery += typeClause
    params.push(messageType)
  }

  if (toolName) {
    const toolClause = ` AND m.tool_name = ?`
    countQuery += toolClause
    searchQuery += toolClause
    params.push(toolName)
  }

  if (sessionId) {
    const sessionClause = ` AND m.session_id = ?`
    countQuery += sessionClause
    searchQuery += sessionClause
    params.push(sessionId)
  }

  searchQuery += ` ORDER BY rank LIMIT ? OFFSET ?`

  const totalRow = db.prepare(countQuery).get(...params) as { total: number }
  const results = db.prepare(searchQuery).all(...params, limit, offset) as (MessageRecord & {
    snippet: string
    project_path: string
    rank: number
  })[]

  return { results, total: totalRow.total }
}

// ============================================================================
// Activity queries
// ============================================================================

export function getActiveSessionsInWindow(
  db: Database,
  windowMs: number,
): {
  project_path: string
  session_id: string
  last_activity: number
  message_count: number
}[] {
  const cutoff = Date.now() - windowMs
  return db
    .prepare(`
    SELECT s.project_path, m.session_id, MAX(m.timestamp) as last_activity, COUNT(*) as message_count
    FROM messages m
    JOIN sessions s ON m.session_id = s.id
    WHERE m.timestamp > ?
    GROUP BY s.project_path, m.session_id
    ORDER BY last_activity DESC
  `)
    .all(cutoff) as {
    project_path: string
    session_id: string
    last_activity: number
    message_count: number
  }[]
}

export function getActivitySummary(
  db: Database,
  windowMs: number,
): {
  project_path: string
  message_count: number
  session_count: number
  last_activity: number
}[] {
  const cutoff = Date.now() - windowMs
  return db
    .prepare(`
    SELECT s.project_path,
           COUNT(*) as message_count,
           COUNT(DISTINCT m.session_id) as session_count,
           MAX(m.timestamp) as last_activity
    FROM messages m
    JOIN sessions s ON m.session_id = s.id
    WHERE m.timestamp > ?
    GROUP BY s.project_path
    ORDER BY message_count DESC
  `)
    .all(cutoff) as {
    project_path: string
    message_count: number
    session_count: number
    last_activity: number
  }[]
}

// ============================================================================
// Similar query detection
// ============================================================================

export function findSimilarQueries(
  db: Database,
  query: string,
  options: { limit?: number } = {},
): {
  user_content: string
  assistant_content: string
  session_id: string
  project_path: string
  timestamp: number
  rank: number
}[] {
  const { limit = 5 } = options
  const ftsQuery = toFts5Query(query)

  // Find user messages that match, then get their corresponding assistant responses
  return db
    .prepare(`
    SELECT
      m1.content as user_content,
      m2.content as assistant_content,
      m1.session_id,
      s.project_path,
      m1.timestamp,
      bm25(messages_fts, 10.0, 1.0, 2.0) as rank
    FROM messages_fts f
    JOIN messages m1 ON f.rowid = m1.id
    JOIN sessions s ON m1.session_id = s.id
    LEFT JOIN messages m2 ON m2.session_id = m1.session_id
      AND m2.type = 'assistant'
      AND m2.timestamp > m1.timestamp
      AND m2.id = (
        SELECT MIN(id) FROM messages
        WHERE session_id = m1.session_id
        AND type = 'assistant'
        AND timestamp > m1.timestamp
      )
    WHERE messages_fts MATCH ?
      AND m1.type = 'user'
    ORDER BY rank
    LIMIT ?
  `)
    .all(ftsQuery, limit) as {
    user_content: string
    assistant_content: string
    session_id: string
    project_path: string
    timestamp: number
    rank: number
  }[]
}

// ============================================================================
// Index metadata
// ============================================================================

export function setIndexMeta(db: Database, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)").run(key, value)
}

export function getIndexMeta(db: Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM index_meta WHERE key = ?").get(key) as { value: string } | undefined
  return row?.value
}

// ============================================================================
// Clear tables for rebuild
// ============================================================================

export function clearTables(db: Database, tables: ("writes" | "sessions" | "messages")[]): void {
  for (const table of tables) {
    db.prepare(`DELETE FROM ${table}`).run()
  }
  if (tables.includes("messages")) {
    // Rebuild FTS index
    db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')").run()
  }
}

// ============================================================================
// Session titles from sessions-index.json
// ============================================================================

interface SessionsIndexFile {
  version?: number
  entries?: SessionIndexEntry[]
  originalPath?: string
}

// Cache for sessions-index.json file mtimes and content
const sessionsIndexCache = new Map<string, { mtime: number; titles: Map<string, string> }>()

/**
 * Find all sessions-index.json files in the projects directory
 */
export function findSessionsIndexFiles(): string[] {
  if (!fs.existsSync(PROJECTS_DIR)) return []

  const files: string[] = []
  try {
    for (const entry of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const indexPath = path.join(PROJECTS_DIR, entry.name, "sessions-index.json")
        if (fs.existsSync(indexPath)) {
          files.push(indexPath)
        }
      }
    }
  } catch {
    // Ignore errors reading directory
  }
  return files
}

/**
 * Read session titles from a sessions-index.json file
 */
export function readSessionTitles(indexPath: string): Map<string, string> {
  const titles = new Map<string, string>()

  try {
    const stats = fs.statSync(indexPath)
    const mtime = stats.mtime.getTime()

    // Check cache
    const cached = sessionsIndexCache.get(indexPath)
    if (cached && cached.mtime >= mtime) {
      return cached.titles
    }

    const content = fs.readFileSync(indexPath, "utf8")
    const data = JSON.parse(content) as SessionsIndexFile

    if (data.entries) {
      for (const entry of data.entries) {
        if (entry.sessionId && entry.customTitle) {
          titles.set(entry.sessionId, entry.customTitle)
        }
      }
    }

    // Update cache
    sessionsIndexCache.set(indexPath, { mtime, titles })
  } catch {
    // Ignore errors reading file
  }

  return titles
}

/**
 * Get all session titles from all projects (cached)
 */
export function getAllSessionTitles(): Map<string, string> {
  const allTitles = new Map<string, string>()

  for (const indexPath of findSessionsIndexFiles()) {
    const titles = readSessionTitles(indexPath)
    for (const [sessionId, title] of titles) {
      allTitles.set(sessionId, title)
    }
  }

  return allTitles
}

/**
 * Refresh session titles in the database from sessions-index.json files
 * Returns the number of titles updated
 */
export function refreshSessionTitles(db: Database): number {
  const titles = getAllSessionTitles()
  let updated = 0

  // Get all sessions that need title updates
  const sessions = db
    .prepare(`
    SELECT id, title FROM sessions
  `)
    .all() as { id: string; title: string | null }[]

  for (const session of sessions) {
    const newTitle = titles.get(session.id)
    if (newTitle && newTitle !== session.title) {
      updateSessionTitle(db, session.id, newTitle)
      updated++
    }
  }

  return updated
}

/**
 * Get session title (from cache, falls back to DB)
 */
export function getSessionTitle(db: Database, sessionId: string): string | null {
  // First check the live sessions-index.json files (cached)
  const titles = getAllSessionTitles()
  const liveTitle = titles.get(sessionId)
  if (liveTitle) return liveTitle

  // Fall back to database
  const session = getSession(db, sessionId)
  return session?.title ?? null
}

// ============================================================================
// Unified content table operations
// ============================================================================

/**
 * Insert content into the unified content table
 */
export function insertContent(
  db: Database,
  contentType: ContentType,
  sourceId: string,
  projectPath: string | null,
  title: string | null,
  content: string,
  timestamp: number,
): number {
  const result = db
    .prepare(`
    INSERT INTO content (content_type, source_id, project_path, title, content, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
    .run(contentType, sourceId, projectPath, title, content, timestamp)
  return Number(result.lastInsertRowid)
}

/**
 * Upsert content into the unified content table.
 * Uses ON CONFLICT on (content_type, source_id) unique index.
 */
export function upsertContent(
  db: Database,
  contentType: ContentType,
  sourceId: string,
  projectPath: string | null,
  title: string | null,
  content: string,
  timestamp: number,
): void {
  db.prepare(`
    INSERT INTO content (content_type, source_id, project_path, title, content, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(content_type, source_id) DO UPDATE SET
      title = excluded.title,
      content = excluded.content,
      timestamp = excluded.timestamp,
      project_path = excluded.project_path
  `).run(contentType, sourceId, projectPath, title, content, timestamp)
}

/**
 * Clear content table (for rebuild)
 */
export function clearContent(db: Database): void {
  db.prepare("DELETE FROM content").run()
  db.prepare("INSERT INTO content_fts(content_fts) VALUES('rebuild')").run()
}

/**
 * Clear content by type (for selective rebuild)
 */
export function clearContentByType(db: Database, contentType: ContentType): void {
  db.prepare("DELETE FROM content WHERE content_type = ?").run(contentType)
}

export interface ContentSearchOptions {
  limit?: number
  offset?: number
  types?: ContentType[]
  projectFilter?: string
  sinceTime?: number // Filter content after this timestamp
  snippetTokens?: number // Snippet window size (default 64)
}

/**
 * Unified search across all content types
 */
export function searchAll(
  db: Database,
  query: string,
  options: ContentSearchOptions = {},
): {
  results: (ContentRecord & { snippet: string; rank: number })[]
  total: number
} {
  const { limit = 50, offset = 0, types, projectFilter, sinceTime, snippetTokens = 64 } = options
  const ftsQuery = toFts5Query(query)

  const params: (string | number)[] = [ftsQuery]
  let typeClause = ""
  let projectClause = ""
  let timeClause = ""

  if (types && types.length > 0) {
    typeClause = ` AND c.content_type IN (${types.map(() => "?").join(",")})`
    params.push(...types)
  }

  if (projectFilter) {
    projectClause = ` AND c.project_path LIKE ?`
    params.push(`%${projectFilter}%`)
  }

  if (sinceTime !== undefined) {
    timeClause = ` AND c.timestamp >= ?`
    params.push(sinceTime)
  }

  const countQuery = `
    SELECT COUNT(*) as total
    FROM content_fts f
    JOIN content c ON f.rowid = c.id
    WHERE content_fts MATCH ?${typeClause}${projectClause}${timeClause}
  `

  const searchQuery = `
    SELECT c.*,
           snippet(content_fts, 1, '>>>', '<<<', '...', ${snippetTokens}) as snippet,
           bm25(content_fts, 2.0, 10.0) as rank
    FROM content_fts f
    JOIN content c ON f.rowid = c.id
    WHERE content_fts MATCH ?${typeClause}${projectClause}${timeClause}
    ORDER BY rank
    LIMIT ? OFFSET ?
  `

  const totalRow = db.prepare(countQuery).get(...params) as { total: number }
  const results = db.prepare(searchQuery).all(...params, limit, offset) as (ContentRecord & {
    snippet: string
    rank: number
  })[]

  return { results, total: totalRow.total }
}

// ============================================================================
// Session context
// ============================================================================

/**
 * Get messages from the same session near a given timestamp.
 * Returns messages within +/-radius rows of the closest message to the timestamp.
 */
export function getSessionContext(
  db: Database,
  sessionId: string,
  timestamp: number,
  radius: number = 5,
): MessageRecord[] {
  // Find the message closest to the timestamp
  const closest = db
    .prepare(`
    SELECT id FROM messages
    WHERE session_id = ?
    ORDER BY ABS(timestamp - ?)
    LIMIT 1
  `)
    .get(sessionId, timestamp) as { id: number } | undefined

  if (!closest) return []

  // Get surrounding messages
  return db
    .prepare(`
    SELECT * FROM messages
    WHERE session_id = ? AND id >= ? AND id <= ?
    ORDER BY id
  `)
    .all(sessionId, closest.id - radius, closest.id + radius) as MessageRecord[]
}

// ============================================================================
// Session entries
// ============================================================================

/**
 * Read all session entries from all sessions-index.json files
 */
export function getAllSessionEntries(): SessionIndexEntry[] {
  const entries: SessionIndexEntry[] = []

  for (const indexPath of findSessionsIndexFiles()) {
    try {
      const content = fs.readFileSync(indexPath, "utf8")
      const data = JSON.parse(content) as SessionsIndexFile
      if (data.entries) {
        entries.push(...data.entries)
      }
    } catch {
      // Ignore errors
    }
  }

  return entries
}

// ============================================================================
// File discovery
// ============================================================================

/**
 * Find all plan files
 */
export function findPlanFiles(): string[] {
  if (!fs.existsSync(PLANS_DIR)) return []

  const files: string[] = []
  try {
    for (const entry of fs.readdirSync(PLANS_DIR, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(path.join(PLANS_DIR, entry.name))
      }
    }
  } catch {
    // Ignore errors
  }
  return files
}

/**
 * Find all todo files
 */
export function findTodoFiles(): string[] {
  if (!fs.existsSync(TODOS_DIR)) return []

  const files: string[] = []
  try {
    for (const entry of fs.readdirSync(TODOS_DIR, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(path.join(TODOS_DIR, entry.name))
      }
    }
  } catch {
    // Ignore errors
  }
  return files
}
