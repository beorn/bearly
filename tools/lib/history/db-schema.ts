/**
 * Database schema, migrations, initialization, and path constants.
 */

import { Database } from "bun:sqlite"
import * as path from "path"
import * as os from "os"

export const CLAUDE_DIR = path.join(os.homedir(), ".claude")
export const DB_PATH = path.join(CLAUDE_DIR, "session-index.db")
export const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects")
export const PLANS_DIR = path.join(CLAUDE_DIR, "plans")
export const TODOS_DIR = path.join(CLAUDE_DIR, "todos")
export const MAX_CONTENT_SIZE = 1024 * 1024 // 1MB - store content for files smaller than this

// Schema includes:
// 1. Original writes table (backwards compatible)
// 2. New sessions table for session metadata
// 3. New messages table for all message types
// 4. FTS5 virtual table for fast full-text search
export const SCHEMA = `
-- Original writes table (backwards compatible)
CREATE TABLE IF NOT EXISTS writes (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  session_file TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_size INTEGER NOT NULL,
  content TEXT
);

CREATE INDEX IF NOT EXISTS idx_writes_path ON writes(file_path);
CREATE INDEX IF NOT EXISTS idx_writes_timestamp ON writes(timestamp);
CREATE INDEX IF NOT EXISTS idx_writes_session ON writes(session_id);
CREATE INDEX IF NOT EXISTS idx_writes_hash ON writes(content_hash);

-- Session metadata
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  jsonl_path TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  message_count INTEGER DEFAULT 0,
  title TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);

-- All messages (user, assistant, tool_use, tool_result, etc.)
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  uuid TEXT UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  type TEXT NOT NULL,
  content TEXT,
  tool_name TEXT,
  file_paths TEXT,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_tool ON messages(tool_name);

-- FTS5 virtual table for fast full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  tool_name,
  file_paths,
  content='messages',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content, tool_name, file_paths)
  VALUES (new.id, new.content, new.tool_name, new.file_paths);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content, tool_name, file_paths)
  VALUES ('delete', old.id, old.content, old.tool_name, old.file_paths);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content, tool_name, file_paths)
  VALUES ('delete', old.id, old.content, old.tool_name, old.file_paths);
  INSERT INTO messages_fts(rowid, content, tool_name, file_paths)
  VALUES (new.id, new.content, new.tool_name, new.file_paths);
END;

-- Metadata table
CREATE TABLE IF NOT EXISTS index_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Unified content table for searching everything
CREATE TABLE IF NOT EXISTS content (
  id INTEGER PRIMARY KEY,
  content_type TEXT NOT NULL,  -- message, plan, summary, todo
  source_id TEXT NOT NULL,     -- session_id, plan filename, todo filename
  project_path TEXT,
  title TEXT,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_content_type ON content(content_type);
CREATE INDEX IF NOT EXISTS idx_content_source ON content(source_id);
CREATE INDEX IF NOT EXISTS idx_content_project ON content(project_path);
CREATE INDEX IF NOT EXISTS idx_content_timestamp ON content(timestamp);

-- Unified FTS5 for searching all content
CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(
  title,
  content,
  content='content',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Triggers for content FTS
CREATE TRIGGER IF NOT EXISTS content_ai AFTER INSERT ON content BEGIN
  INSERT INTO content_fts(rowid, title, content)
  VALUES (new.id, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS content_ad AFTER DELETE ON content BEGIN
  INSERT INTO content_fts(content_fts, rowid, title, content)
  VALUES ('delete', old.id, old.title, old.content);
END;
`

// Migrations to run after schema creation
export const MIGRATIONS = [
  // Add title column to sessions table
  `ALTER TABLE sessions ADD COLUMN title TEXT`,
  // Unique index for upsert support on content table
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_content_type_source ON content(content_type, source_id)`,
  // Update trigger for content FTS (needed for upsert)
  `CREATE TRIGGER IF NOT EXISTS content_au AFTER UPDATE ON content BEGIN
    INSERT INTO content_fts(content_fts, rowid, title, content)
    VALUES ('delete', old.id, old.title, old.content);
    INSERT INTO content_fts(rowid, title, content)
    VALUES (new.id, new.title, new.content);
  END`,
]

export function runMigrations(db: Database): void {
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration)
    } catch {
      // Column/table already exists, skip
    }
  }
}

export function initSchema(db: Database): void {
  db.exec(SCHEMA)
  runMigrations(db)
}
