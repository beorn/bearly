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
		identity_token TEXT,
		started_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`)

  // Migrations table — tracks schema version so we can evolve the DB without
  // relying on try/catch soup. Each row in MIGRATIONS is run exactly once,
  // in order, for databases whose version < migration.version. Fresh installs
  // skip all migrations because the CREATE TABLE statements above already
  // reflect the latest schema.
  db.run("CREATE TABLE IF NOT EXISTS _schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  const versionRow = db.prepare("SELECT value FROM _schema_meta WHERE key = 'version'").get() as {
    value: string
  } | null
  const currentVersion = versionRow ? Number(versionRow.value) : 0

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue
    migration.up(db)
  }
  if (MIGRATIONS.length > 0 && MIGRATIONS[MIGRATIONS.length - 1]!.version > currentVersion) {
    const latest = MIGRATIONS[MIGRATIONS.length - 1]!.version
    db.run("INSERT INTO _schema_meta (key, value) VALUES ('version', $v) ON CONFLICT(key) DO UPDATE SET value = $v", {
      $v: String(latest),
    } as never)
  } else if (versionRow === null && MIGRATIONS.length > 0) {
    // Fresh install — stamp the current version so future migrations start from here.
    const latest = MIGRATIONS[MIGRATIONS.length - 1]!.version
    db.run("INSERT OR IGNORE INTO _schema_meta (key, value) VALUES ('version', $v)", {
      $v: String(latest),
    } as never)
  }

  db.run(`CREATE TABLE IF NOT EXISTS messages (
		id         TEXT PRIMARY KEY,
		type       TEXT NOT NULL,
		sender     TEXT NOT NULL,
		recipient  TEXT NOT NULL,
		kind       TEXT NOT NULL DEFAULT 'direct',
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

  // `event_log` was merged into `messages WHERE kind='event'` by migration v8
  // (km-tribe.polish-sweep item 9). Fresh installs get only the messages table;
  // existing databases retain their event_log rows via the v8 backfill.

  // Create indexes if they don't exist
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_recipient_ts ON messages(recipient, ts)")
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender)")
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_type_ts ON messages(type, ts)")
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_kind_ts ON messages(kind, ts)")
  db.run("CREATE INDEX IF NOT EXISTS idx_reads_session ON reads(session_id, message_id)")
  db.run("CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at)")
  db.run("CREATE INDEX IF NOT EXISTS idx_sessions_identity ON sessions(identity_token)")
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts)")
  db.run("CREATE INDEX IF NOT EXISTS idx_coordination_project ON coordination(project_id)")

  return db
}

// ---------------------------------------------------------------------------
// Migrations — ordered, versioned, idempotent. `openDatabase` runs everything
// with `version > _schema_meta.version` (stored as a string in that table);
// fresh installs skip the list because the CREATE TABLE statements already
// reflect the latest schema. Add new migrations at the end with the next
// integer; never reorder existing ones.
// ---------------------------------------------------------------------------

type Migration = { version: number; name: string; up(db: Database): void }

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "add-sessions-optional-columns",
    up(db) {
      // Introspect rather than try/catch — keeps the upgrade silent on fresh
      // installs (CREATE TABLE already has these columns) and surgical on old
      // ones (only ADD what's missing).
      const cols = new Set(
        (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((r) => r.name),
      )
      const wanted: ReadonlyArray<readonly [string, string]> = [
        ["project_id", "TEXT"],
        ["claude_session_id", "TEXT"],
        ["claude_session_name", "TEXT"],
        ["last_delivered_ts", "INTEGER"],
        ["last_delivered_seq", "INTEGER DEFAULT 0"],
      ]
      for (const [name, spec] of wanted) {
        if (!cols.has(name)) db.run(`ALTER TABLE sessions ADD COLUMN ${name} ${spec}`)
      }
    },
  },
  {
    version: 2,
    name: "rename-heartbeat-to-updated-at-drop-pruned-at",
    up(db) {
      // Phase 2 of km-tribe.plateau: liveness is in-memory (clients Map),
      // not a periodic DB timer.
      try {
        db.run("ALTER TABLE sessions RENAME COLUMN heartbeat TO updated_at")
      } catch {
        /* already renamed */
      }
      try {
        db.run("ALTER TABLE sessions DROP COLUMN pruned_at")
      } catch {
        /* already dropped */
      }
      try {
        db.run("DROP INDEX IF EXISTS idx_sessions_pruned")
      } catch {
        /* ignore */
      }
    },
  },
  {
    version: 3,
    name: "collapse-events-into-messages",
    up(db) {
      // Phase 4 of km-tribe.plateau: each event row becomes a message with
      // type "event.<orig-type>", sender=<session>, recipient="log".
      try {
        db.run(`
          INSERT INTO messages (id, type, sender, recipient, content, bead_id, ref, ts)
          SELECT id, 'event.' || type, COALESCE(session, 'unknown'), 'log',
                 COALESCE(data, ''), bead_id, NULL, ts
          FROM events
        `)
        db.run("DROP TABLE events")
      } catch {
        /* fresh install or already migrated */
      }
    },
  },
  {
    version: 4,
    name: "drop-aliases",
    up(db) {
      // Phase 4 of km-tribe.plateau: renames update sessions.name in place.
      db.run("DROP TABLE IF EXISTS aliases")
    },
  },
  {
    version: 5,
    name: "drop-leadership-vestige",
    up(db) {
      // Phase 1 of km-tribe.plateau: chief is derived from connection order.
      // Old deployments still have a vestigial leadership row — drop it so no
      // ghost state can confuse a future schema read.
      db.run("DROP TABLE IF EXISTS leadership")
    },
  },
  {
    version: 6,
    name: "add-sessions-identity-token",
    up(db) {
      // Phase 1.5 of km-tribe.plateau: stable session identity across Claude
      // Code restarts. The proxy hashes (claude_session_id, project_path,
      // role_hint) and sends the result on register; the daemon adopts the
      // prior sessionId + name + role + cursor when the token matches an
      // inactive row.
      try {
        db.run("ALTER TABLE sessions ADD COLUMN identity_token TEXT")
      } catch {
        /* exists */
      }
      db.run("CREATE INDEX IF NOT EXISTS idx_sessions_identity ON sessions(identity_token)")
    },
  },
  {
    version: 7,
    name: "add-messages-kind-replace-log-sentinel",
    up(db) {
      // km-tribe.polish-sweep item 3: replace the `recipient='log'` string
      // sentinel with a typed `kind` column. Recipients go back to being real
      // names (session id or '*'); delivery filters on `kind='event'` to skip
      // journal rows.
      //
      // Fresh installs reach this point before the CREATE TABLE for messages
      // runs below — we guard by checking sqlite_master so the ALTER is only
      // issued against a pre-existing table. Fresh installs get the `kind`
      // column from the CREATE TABLE itself.
      const hasMessages = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
        .get() as { name: string } | null
      if (!hasMessages) return
      const cols = new Set(
        (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((r) => r.name),
      )
      if (!cols.has("kind")) {
        db.run("ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'direct'")
      }
      // Backfill: event rows (recipient='log') become kind='event' with recipient='*'.
      db.run("UPDATE messages SET kind = 'event' WHERE recipient = 'log'")
      db.run("UPDATE messages SET recipient = '*' WHERE recipient = 'log'")
      // Broadcasts to '*' that aren't events get tagged as kind='broadcast'
      // so the typed column is maximally informative after migration.
      db.run("UPDATE messages SET kind = 'broadcast' WHERE recipient = '*' AND kind = 'direct'")
    },
  },
  {
    version: 8,
    name: "merge-event-log-into-messages",
    up(db) {
      // km-tribe.polish-sweep item 9: `event_log` is redundant with
      // `messages WHERE kind='event'` (after v7) — logEvent() already writes
      // every event into `messages` on the current code path. The dual write
      // served observability in an earlier era; now the single source of truth
      // is `messages`. Backfill any orphan rows (events that never made it
      // into `messages`), then drop the table and its indexes.
      const hasEventLog = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event_log'")
        .get() as { name: string } | null
      if (!hasEventLog) return
      // Backfill: any event_log row whose (ts, type) isn't represented as a
      // messages event row becomes one. We match conservatively on (ts, type)
      // — collisions are astronomically unlikely, and an accidental duplicate
      // is far less harmful than a silent data loss.
      db.run(`
        INSERT INTO messages (id, type, sender, recipient, kind, content, bead_id, ref, ts)
        SELECT
          lower(hex(randomblob(16))),
          'event.' || COALESCE(el.type, 'unknown'),
          COALESCE(s.name, 'unknown'),
          '*',
          'event',
          COALESCE(el.meta, ''),
          NULL,
          NULL,
          el.ts
        FROM event_log el
        LEFT JOIN sessions s ON s.id = el.session_id
        WHERE NOT EXISTS (
          SELECT 1 FROM messages m
          WHERE m.kind = 'event'
            AND m.ts = el.ts
            AND m.type = 'event.' || COALESCE(el.type, 'unknown')
        )
      `)
      db.run("DROP INDEX IF EXISTS idx_event_log_project_ts")
      db.run("DROP INDEX IF EXISTS idx_event_log_type")
      db.run("DROP TABLE event_log")
    },
  },
]

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

export type TribeStatements = ReturnType<typeof createStatements>

export function createStatements(db: Database) {
  return {
    upsertSession: db.prepare(`
		INSERT INTO sessions (id, name, role, domains, pid, cwd, project_id, claude_session_id, claude_session_name, identity_token, started_at, updated_at)
		VALUES ($id, $name, $role, $domains, $pid, $cwd, $project_id, $claude_session_id, $claude_session_name, $identity_token, $now, $now)
		ON CONFLICT(id) DO UPDATE SET
			name = $name, role = $role, domains = $domains,
			pid = $pid, cwd = $cwd, project_id = $project_id, claude_session_id = $claude_session_id,
			claude_session_name = $claude_session_name, identity_token = $identity_token, started_at = $now, updated_at = $now
	`),

    pollMessages: db.prepare(`
		SELECT rowid, * FROM messages
		WHERE rowid > $last_seq
		AND id NOT IN (SELECT message_id FROM reads WHERE session_id = $session_id)
		AND (
			recipient = $name
			OR recipient = '*'
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
		INSERT INTO messages (id, type, sender, recipient, kind, content, bead_id, ref, ts)
		VALUES ($id, $type, $sender, $recipient, $kind, $content, $bead_id, $ref, $ts)
	`),

    allSessions: db.prepare(
      "SELECT id, name, role, domains, pid, cwd, project_id, claude_session_id, claude_session_name, started_at, updated_at FROM sessions",
    ),

    messageHistory: db.prepare(`
		SELECT * FROM messages
		WHERE (sender = $name OR recipient = $name OR recipient = '*')
		AND kind != 'event'
		ORDER BY ts DESC
		LIMIT $limit
	`),

    checkNameTaken: db.prepare("SELECT id FROM sessions WHERE name = $name AND id != $session_id"),

    renameSession: db.prepare("UPDATE sessions SET name = $new_name, updated_at = $now WHERE id = $session_id"),

    updateSessionMeta: db.prepare(`
		UPDATE sessions SET name = $name, role = $role, domains = $domains, updated_at = $now
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
      "UPDATE sessions SET last_delivered_ts = $ts, last_delivered_seq = $seq, updated_at = $ts WHERE id = $id",
    ),

    getLastDelivered: db.prepare("SELECT last_delivered_ts, last_delivered_seq FROM sessions WHERE id = $id"),
  }
}
