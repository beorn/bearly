/**
 * Tribe database — schema, migrations, indexes, prepared statements.
 */

import { Database } from "bun:sqlite"

// ---------------------------------------------------------------------------
// Schema & migrations
// ---------------------------------------------------------------------------

export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA busy_timeout = 5000")

  db.run(`CREATE TABLE IF NOT EXISTS sessions (
		id         TEXT PRIMARY KEY,
		name       TEXT NOT NULL UNIQUE,
		role       TEXT NOT NULL,
		domains    TEXT NOT NULL DEFAULT '[]',
		pid        INTEGER NOT NULL,
		cwd        TEXT,
		project_id TEXT,
		claude_session_id TEXT,
		claude_session_name TEXT,
		started_at INTEGER NOT NULL,
		heartbeat  INTEGER NOT NULL,
		pruned_at  INTEGER
	)`)

  // Migration: add columns if they don't exist (for existing DBs)
  try {
    db.run("ALTER TABLE sessions ADD COLUMN project_id TEXT")
  } catch {
    /* already exists */
  }
  try {
    db.run("ALTER TABLE sessions ADD COLUMN claude_session_id TEXT")
  } catch {
    /* already exists */
  }
  try {
    db.run("ALTER TABLE sessions ADD COLUMN claude_session_name TEXT")
  } catch {
    /* already exists */
  }
  try {
    db.run("ALTER TABLE sessions ADD COLUMN pruned_at INTEGER")
  } catch {
    /* already exists */
  }
  try {
    db.run("ALTER TABLE sessions ADD COLUMN last_delivered_ts INTEGER")
  } catch {
    /* already exists */
  }
  try {
    db.run("ALTER TABLE sessions ADD COLUMN last_delivered_seq INTEGER DEFAULT 0")
  } catch {
    /* already exists */
  }

  db.run(`CREATE TABLE IF NOT EXISTS aliases (
		old_name   TEXT PRIMARY KEY,
		session_id TEXT NOT NULL,
		renamed_at INTEGER NOT NULL
	)`)

  db.run(`CREATE TABLE IF NOT EXISTS messages (
		id         TEXT PRIMARY KEY,
		type       TEXT NOT NULL,
		sender     TEXT NOT NULL,
		recipient  TEXT NOT NULL,
		content    TEXT NOT NULL,
		bead_id    TEXT,
		ref        TEXT,
		ts         INTEGER NOT NULL
	)`)

  db.run(`CREATE TABLE IF NOT EXISTS cursors (
		session_id   TEXT PRIMARY KEY,
		last_read_ts INTEGER NOT NULL,
		last_seq     INTEGER DEFAULT 0
	)`)

  // Migration: add last_seq column for rowid-based cursor (replaces timestamp-based)
  try {
    db.run("ALTER TABLE cursors ADD COLUMN last_seq INTEGER DEFAULT 0")
  } catch {
    /* already exists */
  }

  db.run(`CREATE TABLE IF NOT EXISTS reads (
		message_id TEXT NOT NULL,
		session_id TEXT NOT NULL,
		read_at    INTEGER NOT NULL,
		PRIMARY KEY (message_id, session_id)
	)`)

  db.run(`CREATE TABLE IF NOT EXISTS events (
		id       TEXT PRIMARY KEY,
		type     TEXT NOT NULL,
		session  TEXT,
		bead_id  TEXT,
		data     TEXT,
		ts       INTEGER NOT NULL
	)`)

  db.run(`CREATE TABLE IF NOT EXISTS retros (
		id          TEXT PRIMARY KEY,
		tribe_start INTEGER NOT NULL,
		tribe_end   INTEGER NOT NULL,
		members     TEXT NOT NULL,
		metrics     TEXT NOT NULL,
		lessons     TEXT NOT NULL,
		full_md     TEXT NOT NULL,
		ts          INTEGER NOT NULL
	)`)

  // Dedup table — atomic INSERT OR IGNORE prevents race-condition duplicates
  db.run(`CREATE TABLE IF NOT EXISTS dedup (
		key        TEXT PRIMARY KEY,
		session_id TEXT NOT NULL,
		ts         INTEGER NOT NULL
	)`)

  db.run(`CREATE TABLE IF NOT EXISTS coordination (
		project_id  TEXT NOT NULL,
		key         TEXT NOT NULL,
		value       TEXT,
		updated_by  TEXT,
		updated_at  INTEGER,
		PRIMARY KEY (project_id, key)
	)`)

  db.run(`CREATE TABLE IF NOT EXISTS event_log (
		id          INTEGER PRIMARY KEY,
		ts          INTEGER NOT NULL,
		session_id  TEXT,
		project_id  TEXT,
		type        TEXT,
		meta        TEXT
	)`)

  // Create indexes if they don't exist
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_recipient_ts ON messages(recipient, ts)")
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender)")
  db.run("CREATE INDEX IF NOT EXISTS idx_aliases_session ON aliases(session_id)")
  db.run("CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts)")
  db.run("CREATE INDEX IF NOT EXISTS idx_events_bead ON events(bead_id)")
  db.run("CREATE INDEX IF NOT EXISTS idx_events_session ON events(session)")

  // Indexes for common query patterns
  db.run("CREATE INDEX IF NOT EXISTS idx_reads_session ON reads(session_id, message_id)")
  db.run("CREATE INDEX IF NOT EXISTS idx_sessions_pruned ON sessions(pruned_at, heartbeat)")
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts)")
  db.run("CREATE INDEX IF NOT EXISTS idx_coordination_project ON coordination(project_id)")
  db.run("CREATE INDEX IF NOT EXISTS idx_event_log_project_ts ON event_log(project_id, ts)")
  db.run("CREATE INDEX IF NOT EXISTS idx_event_log_type ON event_log(type)")

  return db
}

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

export type TribeStatements = ReturnType<typeof createStatements>

export function createStatements(db: Database) {
  return {
    upsertSession: db.prepare(`
		INSERT INTO sessions (id, name, role, domains, pid, cwd, project_id, claude_session_id, claude_session_name, started_at, heartbeat, pruned_at)
		VALUES ($id, $name, $role, $domains, $pid, $cwd, $project_id, $claude_session_id, $claude_session_name, $now, $now, NULL)
		ON CONFLICT(id) DO UPDATE SET
			name = $name, role = $role, domains = $domains,
			pid = $pid, cwd = $cwd, project_id = $project_id, claude_session_id = $claude_session_id,
			claude_session_name = $claude_session_name, started_at = $now, heartbeat = $now, pruned_at = NULL
	`),

    heartbeat: db.prepare("UPDATE sessions SET heartbeat = $now, pruned_at = NULL WHERE id = $id"),

    pollMessages: db.prepare(`
		SELECT rowid, * FROM messages
		WHERE rowid > $last_seq
		AND id NOT IN (SELECT message_id FROM reads WHERE session_id = $session_id)
		AND (
			recipient = $name
			OR recipient = '*'
			OR recipient IN (SELECT old_name FROM aliases WHERE session_id = $session_id)
		)
		ORDER BY
			CASE type
				WHEN 'assign' THEN 0
				WHEN 'request' THEN 1
				WHEN 'verdict' THEN 2
				WHEN 'query' THEN 3
				WHEN 'response' THEN 4
				WHEN 'status' THEN 5
				WHEN 'notify' THEN 6
				ELSE 7
			END,
			rowid ASC
	`),

    markRead: db.prepare(
      "INSERT OR IGNORE INTO reads (message_id, session_id, read_at) VALUES ($message_id, $session_id, $now)",
    ),

    getCursor: db.prepare("SELECT last_read_ts, last_seq FROM cursors WHERE session_id = $session_id"),

    upsertCursor: db.prepare(`
		INSERT INTO cursors (session_id, last_read_ts, last_seq)
		VALUES ($session_id, $ts, $seq)
		ON CONFLICT(session_id) DO UPDATE SET last_read_ts = $ts, last_seq = $seq
	`),

    insertMessage: db.prepare(`
		INSERT INTO messages (id, type, sender, recipient, content, bead_id, ref, ts)
		VALUES ($id, $type, $sender, $recipient, $content, $bead_id, $ref, $ts)
	`),

    insertEvent: db.prepare(`
		INSERT INTO events (id, type, session, bead_id, data, ts)
		VALUES ($id, $type, $session, $bead_id, $data, $ts)
	`),

    liveSessions: db.prepare(`
		SELECT id, name, role, domains, pid, cwd, project_id, claude_session_id, claude_session_name, started_at, heartbeat, pruned_at
		FROM sessions
		WHERE heartbeat > $threshold AND pruned_at IS NULL
	`),

    allSessions: db.prepare(
      "SELECT id, name, role, domains, pid, cwd, project_id, claude_session_id, claude_session_name, started_at, heartbeat, pruned_at FROM sessions",
    ),

    messageHistory: db.prepare(`
		SELECT * FROM messages
		WHERE (sender = $name OR recipient = $name OR recipient = '*')
		ORDER BY ts DESC
		LIMIT $limit
	`),

    checkNameTaken: db.prepare(
      "SELECT id FROM sessions WHERE name = $name AND id != $session_id AND pruned_at IS NULL",
    ),

    insertAlias: db.prepare(`
		INSERT OR REPLACE INTO aliases (old_name, session_id, renamed_at)
		VALUES ($old_name, $session_id, $now)
	`),

    renameSession: db.prepare("UPDATE sessions SET name = $new_name WHERE id = $session_id"),

    pruneSession: db.prepare("UPDATE sessions SET pruned_at = $now, name = $pruned_name WHERE id = $id"),

    updateSessionMeta: db.prepare(`
		UPDATE sessions SET name = $name, role = $role, domains = $domains, heartbeat = $now, pruned_at = NULL
		WHERE id = $id
	`),

    hasRecentMessage: db.prepare(`
		SELECT 1 FROM messages WHERE content LIKE $prefix || '%' AND ts > $since LIMIT 1
	`),

    // Atomic dedup: INSERT OR IGNORE — first session to claim a key wins, others get changes=0
    claimDedup: db.prepare("INSERT OR IGNORE INTO dedup (key, session_id, ts) VALUES ($key, $session_id, $ts)"),

    // Cleanup old dedup entries (called by retention)
    cleanupDedup: db.prepare("DELETE FROM dedup WHERE ts < $cutoff"),

    updateLastDelivered: db.prepare(
      "UPDATE sessions SET last_delivered_ts = $ts, last_delivered_seq = $seq WHERE id = $id",
    ),

    getLastDelivered: db.prepare("SELECT last_delivered_ts, last_delivered_seq FROM sessions WHERE id = $id"),

    activeSessions: db.prepare(
      "SELECT id, name, role, domains, pid, cwd, project_id, claude_session_id, claude_session_name, started_at, heartbeat, pruned_at FROM sessions WHERE pruned_at IS NULL",
    ),

    deleteOldPrunedSessions: db.prepare("DELETE FROM sessions WHERE pruned_at IS NOT NULL AND pruned_at < $cutoff"),
  }
}
