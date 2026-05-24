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
		updated_at INTEGER NOT NULL,
		last_delivered_ts INTEGER,
		last_delivered_seq INTEGER NOT NULL DEFAULT 0,
		last_inbox_pull_seq INTEGER NOT NULL DEFAULT 0,
		filter_mode  TEXT NOT NULL DEFAULT 'normal',
		filter_until INTEGER,
		filter_mute TEXT,
		delivery     TEXT NOT NULL DEFAULT 'push',
		account    TEXT,
		provider   TEXT
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
		ts         INTEGER NOT NULL,
		delivery   TEXT NOT NULL DEFAULT 'push',
		topic      TEXT,
		room_id    TEXT,
		request    TEXT,
		reply      TEXT
	)`)

  db.run(`CREATE TABLE IF NOT EXISTS messages_archive (
		seq         INTEGER NOT NULL,
		id          TEXT PRIMARY KEY,
		type        TEXT NOT NULL,
		sender      TEXT NOT NULL,
		recipient   TEXT NOT NULL,
		kind        TEXT NOT NULL DEFAULT 'direct',
		content     TEXT NOT NULL,
		bead_id     TEXT,
		ref         TEXT,
		ts          INTEGER NOT NULL,
		delivery    TEXT NOT NULL DEFAULT 'push',
		topic       TEXT,
		room_id     TEXT,
		archived_at INTEGER NOT NULL,
		request     TEXT,
		reply       TEXT
	)`)

  // Ball-tracker: per-(request_id, recipient) row for every open request.
  // See @km/tribe/message-ball-tracker. Sender opens a tracked request by
  // sending a message with `request=<id>`; recipient closes it by replying
  // with `reply=<id>`. Multi-target (`to: [...]`) and broadcast (`to: "*"`)
  // both produce one row per resolved recipient.
  db.run(`CREATE TABLE IF NOT EXISTS pending_request (
		request_id TEXT NOT NULL,
		recipient  TEXT NOT NULL,
		sender     TEXT NOT NULL,
		opened_at  INTEGER NOT NULL,
		message_id TEXT NOT NULL,
		fanout     TEXT NOT NULL DEFAULT 'first',
		PRIMARY KEY (request_id, recipient)
	)`)

  // `cursors` and `reads` tables removed by migration v9 — the event-bus
  // (km-tribe.event-bus) made them vestigial: per-session delivery state now
  // lives on `sessions.last_delivered_seq`, and read-receipts were never
  // written by the post-event-bus code path. Fresh installs never create them.

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

  // Matrix-shape primitives (km-tribe.event-classification): rooms scope events
  // for future multi-room support; today every project has one synthetic room.
  db.run(`CREATE TABLE IF NOT EXISTS rooms (
		id           TEXT PRIMARY KEY,
		project_id   TEXT,
		name         TEXT,
		created_at   INTEGER NOT NULL,
		creator_id   TEXT,
		metadata     TEXT
	)`)
  db.run(`CREATE TABLE IF NOT EXISTS room_members (
		room_id     TEXT NOT NULL,
		session_id  TEXT NOT NULL,
		joined_at   INTEGER NOT NULL,
		role        TEXT NOT NULL DEFAULT 'member',
		PRIMARY KEY (room_id, session_id)
	)`)

  // `dismissals` table was dropped by migration v11 — ambient classification
  // + the inbox cursor already cover the audit / "ignored event" use case.

  // `event_log` was merged into `messages WHERE kind='event'` by migration v8
  // (km-tribe.polish-sweep item 9). Fresh installs get only the messages table;
  // existing databases retain their event_log rows via the v8 backfill.

  // Create indexes if they don't exist
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_recipient_ts ON messages(recipient, ts)")
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender)")
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_type_ts ON messages(type, ts)")
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_kind_ts ON messages(kind, ts)")
  db.run("CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at)")
  db.run("CREATE INDEX IF NOT EXISTS idx_sessions_identity ON sessions(identity_token)")
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts)")
  db.run("CREATE INDEX IF NOT EXISTS idx_coordination_project ON coordination(project_id)")
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_delivery_ts ON messages(delivery, ts)")
  db.run("DROP INDEX IF EXISTS idx_messages_plugin_kind_ts")
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_topic_ts ON messages(topic, ts)")
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_room_ts ON messages(room_id, ts)")
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_archive_ts ON messages_archive(ts)")
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_archive_seq ON messages_archive(seq)")
  db.run("CREATE INDEX IF NOT EXISTS idx_pending_recipient ON pending_request(recipient)")
  db.run("CREATE INDEX IF NOT EXISTS idx_pending_sender ON pending_request(sender)")

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
      const hasMessages = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get() as {
        name: string
      } | null
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
  {
    version: 9,
    name: "drop-cursors-and-reads",
    up(db) {
      // km-tribe.delivery-correctness P1.3: the event-bus (km-tribe.event-bus)
      // moved per-session delivery state onto `sessions.last_delivered_seq`,
      // making the `cursors` table redundant. `reads` had no post-event-bus
      // writer — markRead was never called on the live path. Drop both plus
      // their indexes.
      db.run("DROP INDEX IF EXISTS idx_reads_session")
      db.run("DROP TABLE IF EXISTS cursors")
      db.run("DROP TABLE IF EXISTS reads")
    },
  },
  {
    version: 10,
    name: "event-classification",
    up(db) {
      // km-tribe.event-classification: tag every event with a delivery class
      // (push = actionable channel-delivered, pull = ambient inbox-only) and a
      // response_expected hint (yes / no / optional). Adds rooms primitives
      // (Matrix-shape) plus per-session inbox cursor / mode / snooze and a
      // dismissals audit table. See vendor/bearly/CHANGELOG.md 0.12.0.
      //
      // Fresh-install guard: openDatabase() runs migrations BEFORE the
      // CREATE TABLE messages block (line ~63). On fresh installs the
      // messages table doesn't exist yet, but the CREATE TABLE below
      // already includes every column this migration adds — so we skip.
      const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get() as {
        name: string
      } | null
      if (!tableExists) return

      const messageCols = new Set(
        (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((r) => r.name),
      )
      if (!messageCols.has("response_expected")) {
        db.run("ALTER TABLE messages ADD COLUMN response_expected TEXT NOT NULL DEFAULT 'optional'")
      }
      if (!messageCols.has("delivery")) {
        db.run("ALTER TABLE messages ADD COLUMN delivery TEXT NOT NULL DEFAULT 'push'")
      }
      if (!messageCols.has("topic")) {
        db.run("ALTER TABLE messages ADD COLUMN topic TEXT")
      }
      if (!messageCols.has("room_id")) {
        db.run("ALTER TABLE messages ADD COLUMN room_id TEXT")
      }

      const sessionCols = new Set(
        (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((r) => r.name),
      )
      if (!sessionCols.has("last_inbox_pull_seq")) {
        db.run("ALTER TABLE sessions ADD COLUMN last_inbox_pull_seq INTEGER NOT NULL DEFAULT 0")
      }
      if (!sessionCols.has("mode")) {
        db.run("ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'normal'")
      }
      if (!sessionCols.has("snooze_until")) {
        db.run("ALTER TABLE sessions ADD COLUMN snooze_until INTEGER")
      }
      if (!sessionCols.has("snooze_kinds")) {
        db.run("ALTER TABLE sessions ADD COLUMN snooze_kinds TEXT")
      }

      // New tables — guarded by IF NOT EXISTS so re-runs are safe and fresh
      // installs (which already have these from the CREATE TABLE block) skip.
      db.run(`CREATE TABLE IF NOT EXISTS rooms (
				id           TEXT PRIMARY KEY,
				project_id   TEXT,
				name         TEXT,
				created_at   INTEGER NOT NULL,
				creator_id   TEXT,
				metadata     TEXT
			)`)
      db.run(`CREATE TABLE IF NOT EXISTS room_members (
				room_id     TEXT NOT NULL,
				session_id  TEXT NOT NULL,
				joined_at   INTEGER NOT NULL,
				role        TEXT NOT NULL DEFAULT 'member',
				PRIMARY KEY (room_id, session_id)
			)`)
      db.run(`CREATE TABLE IF NOT EXISTS dismissals (
				session_id TEXT NOT NULL,
				message_id TEXT NOT NULL,
				reason     TEXT,
				ts         INTEGER NOT NULL,
				PRIMARY KEY (session_id, message_id)
			)`)

      // Backfill: synthesize one default room per project_id, populate
      // messages.room_id, and join every existing session to its project room.
      // Sessions / messages without a project_id share the singleton 'default'
      // room — keeps the schema invariant (every event scoped to a room) without
      // forcing a project_id on legacy rows.
      //
      // Note: only sessions carries project_id. messages joins via sender →
      // sessions.name. Earlier draft of this migration UNIONed a phantom
      // messages.project_id and crashed on every existing v9 install.
      const now = Date.now()
      const projectRows = db
        .prepare("SELECT DISTINCT COALESCE(project_id, 'default') AS pid FROM sessions")
        .all() as Array<{ pid: string }>
      const insertRoom = db.prepare(
        "INSERT OR IGNORE INTO rooms (id, project_id, name, created_at) VALUES ($id, $pid, $name, $now)",
      )
      for (const row of projectRows) {
        const roomId = `room:${row.pid}`
        insertRoom.run({ $id: roomId, $pid: row.pid === "default" ? null : row.pid, $name: row.pid, $now: now })
      }
      // Backfill messages.room_id where unset.
      db.run(`UPDATE messages SET room_id = 'room:' || COALESCE(
				(SELECT s.project_id FROM sessions s WHERE s.name = messages.sender),
				'default'
			) WHERE room_id IS NULL`)
      // Backfill room_members from existing sessions.
      db.run(`INSERT OR IGNORE INTO room_members (room_id, session_id, joined_at, role)
				SELECT 'room:' || COALESCE(project_id, 'default'), id, started_at, role FROM sessions`)
    },
  },
  {
    version: 11,
    name: "filter-collapse",
    up(db) {
      // km-tribe.filter-collapse: rename sessions.mode/snooze_until/snooze_kinds
      // → filter_mode/filter_until/filter_mute; drop messages.response_expected
      // (the hint is derived from kind + sender at delivery time); drop the
      // dismissals table outright. The unified tribe.filter tool replaces the
      // prior trio — see plugins/tribe/CHANGELOG.md for the migration guide.
      //
      // Fresh-install guard: openDatabase() runs migrations BEFORE the CREATE TABLE
      // statements above, so on a fresh install the relevant tables don't yet exist
      // and we have nothing to migrate. (The CREATE TABLE statements already use the
      // post-v11 column names.)
      const hasSessions = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get() as {
        name: string
      } | null
      if (hasSessions) {
        const sessionCols = new Set(
          (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((r) => r.name),
        )
        if (sessionCols.has("mode") && !sessionCols.has("filter_mode")) {
          db.run("ALTER TABLE sessions RENAME COLUMN mode TO filter_mode")
        }
        if (sessionCols.has("snooze_until") && !sessionCols.has("filter_until")) {
          db.run("ALTER TABLE sessions RENAME COLUMN snooze_until TO filter_until")
        }
        if (sessionCols.has("snooze_kinds") && !sessionCols.has("filter_mute")) {
          db.run("ALTER TABLE sessions RENAME COLUMN snooze_kinds TO filter_mute")
        }
      }

      const hasMessages = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get() as {
        name: string
      } | null
      if (hasMessages) {
        const messageCols = new Set(
          (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((r) => r.name),
        )
        if (messageCols.has("response_expected")) {
          // Bun ships SQLite ≥3.45 (DROP COLUMN landed in 3.35), so the simple
          // ALTER works without the legacy table-rebuild dance.
          db.run("ALTER TABLE messages DROP COLUMN response_expected")
        }
      }

      // Dismissals: drop outright. The audit/classifier-training rationale was
      // never connected to anything that consumed the rows.
      db.run("DROP INDEX IF EXISTS idx_dismissals_session")
      db.run("DROP TABLE IF EXISTS dismissals")
    },
  },
  {
    version: 12,
    name: "session-delivery-mode",
    up(db) {
      // km-bearly.tribe-dm-delivery-gap: each session declares how it consumes
      // messages — `push` (channel fanout, default for stdio clients with a
      // notification reader) or `pull` (queued; drained via tribe.fetch).
      // The daemon's broadcast pipeline skips socket fanout for
      // pull-mode recipients so MCP-only clients (codex, etc.) don't lose DMs
      // to /dev/null.
      const hasSessions = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get() as {
        name: string
      } | null
      if (hasSessions) {
        const cols = new Set(
          (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((r) => r.name),
        )
        if (!cols.has("delivery")) {
          db.run("ALTER TABLE sessions ADD COLUMN delivery TEXT NOT NULL DEFAULT 'push'")
        }
      }
    },
  },
  {
    version: 13,
    name: "topic-and-filter-mute",
    up(db) {
      const hasMessages = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get() as {
        name: string
      } | null
      if (hasMessages) {
        db.run("DROP INDEX IF EXISTS idx_messages_plugin_kind_ts")
        const messageCols = new Set(
          (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((r) => r.name),
        )
        if (messageCols.has("plugin_kind") && !messageCols.has("topic")) {
          db.run("ALTER TABLE messages RENAME COLUMN plugin_kind TO topic")
        } else if (!messageCols.has("topic")) {
          db.run("ALTER TABLE messages ADD COLUMN topic TEXT")
        } else if (messageCols.has("plugin_kind")) {
          db.run("UPDATE messages SET topic = plugin_kind WHERE topic IS NULL AND plugin_kind IS NOT NULL")
          db.run("ALTER TABLE messages DROP COLUMN plugin_kind")
        }
        db.run("CREATE INDEX IF NOT EXISTS idx_messages_topic_ts ON messages(topic, ts)")
      }

      const hasSessions = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get() as {
        name: string
      } | null
      if (hasSessions) {
        const sessionCols = new Set(
          (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((r) => r.name),
        )
        if (sessionCols.has("filter_kinds") && !sessionCols.has("filter_mute")) {
          db.run("ALTER TABLE sessions RENAME COLUMN filter_kinds TO filter_mute")
        } else if (!sessionCols.has("filter_mute")) {
          db.run("ALTER TABLE sessions ADD COLUMN filter_mute TEXT")
        } else if (sessionCols.has("filter_kinds")) {
          db.run(
            "UPDATE sessions SET filter_mute = filter_kinds WHERE filter_mute IS NULL AND filter_kinds IS NOT NULL",
          )
          db.run("ALTER TABLE sessions DROP COLUMN filter_kinds")
        }
      }
    },
  },
  {
    version: 14,
    name: "message-archive",
    up(db) {
      db.run(`CREATE TABLE IF NOT EXISTS messages_archive (
				seq         INTEGER NOT NULL,
				id          TEXT PRIMARY KEY,
				type        TEXT NOT NULL,
				sender      TEXT NOT NULL,
				recipient   TEXT NOT NULL,
				kind        TEXT NOT NULL DEFAULT 'direct',
				content     TEXT NOT NULL,
				bead_id     TEXT,
				ref         TEXT,
				ts          INTEGER NOT NULL,
				delivery    TEXT NOT NULL DEFAULT 'push',
				topic       TEXT,
				room_id     TEXT,
				archived_at INTEGER NOT NULL
			)`)
      db.run("CREATE INDEX IF NOT EXISTS idx_messages_archive_ts ON messages_archive(ts)")
      db.run("CREATE INDEX IF NOT EXISTS idx_messages_archive_seq ON messages_archive(seq)")
    },
  },
  {
    version: 15,
    name: "session-account-provider",
    up(db) {
      // @km/infra/15641 Phase 1 — per-session account/provider label.
      // ag (the source of truth for account/quota) sets TRIBE_ACCOUNT +
      // TRIBE_PROVIDER env vars when launching backends; the tribe
      // adapter forwards them in registration. Tribe stays uncoupled
      // from quota logic — it just stores the label so members listing
      // can answer "which account is each session on?".
      const hasSessions = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get() as {
        name: string
      } | null
      if (!hasSessions) return
      const cols = new Set(
        (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((r) => r.name),
      )
      if (!cols.has("account")) db.run("ALTER TABLE sessions ADD COLUMN account TEXT")
      if (!cols.has("provider")) db.run("ALTER TABLE sessions ADD COLUMN provider TEXT")
    },
  },
  {
    version: 16,
    name: "ball-tracker-request-reply",
    up(db) {
      // @km/tribe/message-ball-tracker — add `request` + `reply` columns to
      // messages + messages_archive so the daemon can track "who has the
      // ball" on tracked requests. Plus pending_request table holds one row
      // per (request_id, recipient) for fanout semantics (1:1, multi-target,
      // broadcast). See bead body for full design.
      const hasMessages = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get() as {
        name: string
      } | null
      if (hasMessages) {
        const msgCols = new Set(
          (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((r) => r.name),
        )
        if (!msgCols.has("request")) db.run("ALTER TABLE messages ADD COLUMN request TEXT")
        if (!msgCols.has("reply")) db.run("ALTER TABLE messages ADD COLUMN reply TEXT")
      }
      const hasArchive = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_archive'")
        .get() as { name: string } | null
      if (hasArchive) {
        const archCols = new Set(
          (db.prepare("PRAGMA table_info(messages_archive)").all() as Array<{ name: string }>).map((r) => r.name),
        )
        if (!archCols.has("request")) db.run("ALTER TABLE messages_archive ADD COLUMN request TEXT")
        if (!archCols.has("reply")) db.run("ALTER TABLE messages_archive ADD COLUMN reply TEXT")
      }
      db.run(`CREATE TABLE IF NOT EXISTS pending_request (
				request_id TEXT NOT NULL,
				recipient  TEXT NOT NULL,
				sender     TEXT NOT NULL,
				opened_at  INTEGER NOT NULL,
				message_id TEXT NOT NULL,
				fanout     TEXT NOT NULL DEFAULT 'first',
				PRIMARY KEY (request_id, recipient)
			)`)
      db.run("CREATE INDEX IF NOT EXISTS idx_pending_recipient ON pending_request(recipient)")
      db.run("CREATE INDEX IF NOT EXISTS idx_pending_sender ON pending_request(sender)")
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
		INSERT INTO sessions (id, name, role, domains, pid, cwd, project_id, claude_session_id, claude_session_name, identity_token, started_at, updated_at, delivery, account, provider)
		VALUES ($id, $name, $role, $domains, $pid, $cwd, $project_id, $claude_session_id, $claude_session_name, $identity_token, $now, $now, COALESCE($delivery, 'push'), $account, $provider)
		ON CONFLICT(id) DO UPDATE SET
			name = $name, role = $role, domains = $domains,
			pid = $pid, cwd = $cwd, project_id = $project_id, claude_session_id = $claude_session_id,
			claude_session_name = $claude_session_name, identity_token = $identity_token, started_at = $now, updated_at = $now,
			delivery = COALESCE($delivery, delivery, 'push'),
			account = COALESCE($account, account),
			provider = COALESCE($provider, provider)
	`),

    insertMessage: db.prepare(`
		INSERT INTO messages (id, type, sender, recipient, kind, content, bead_id, ref, ts,
			delivery, topic, room_id)
		VALUES ($id, $type, $sender, $recipient, $kind, $content, $bead_id, $ref, $ts,
			$delivery, $topic, $room_id)
	`),

    allSessions: db.prepare(
      "SELECT id, name, role, domains, pid, cwd, project_id, claude_session_id, claude_session_name, started_at, updated_at, filter_mode, filter_until, filter_mute, last_inbox_pull_seq, delivery FROM sessions",
    ),

    /** Look up a session's delivery mode by name. Used by the broadcast pipeline
     *  to skip socket fanout for pull-mode recipients (km-bearly.tribe-dm-delivery-gap). */
    getSessionDeliveryByName: db.prepare("SELECT delivery FROM sessions WHERE name = $name LIMIT 1"),

    /** Update a session's delivery mode in place. */
    setSessionDelivery: db.prepare("UPDATE sessions SET delivery = $delivery, updated_at = $now WHERE id = $id"),

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

    archiveExpiredMessages: db.prepare(`
		INSERT OR IGNORE INTO messages_archive (
			seq, id, type, sender, recipient, kind, content, bead_id, ref, ts,
			delivery, topic, room_id, archived_at
		)
		SELECT
			rowid, id, type, sender, recipient, kind, content, bead_id, ref, ts,
			delivery, topic, room_id, $archived_at
		FROM messages
		WHERE ts < $cutoff
	`),

    deleteExpiredMessages: db.prepare("DELETE FROM messages WHERE ts < $cutoff"),

    updateLastDelivered: db.prepare(
      "UPDATE sessions SET last_delivered_ts = $ts, last_delivered_seq = $seq, updated_at = $ts WHERE id = $id",
    ),

    getLastDelivered: db.prepare("SELECT last_delivered_ts, last_delivered_seq FROM sessions WHERE id = $id"),

    getMessageTailSeq: db.prepare("SELECT COALESCE(MAX(rowid), 0) AS seq FROM messages"),

    resetSessionDeliveryOffsets: db.prepare(`
      UPDATE sessions
      SET
        last_delivered_ts = $ts,
        last_delivered_seq = $seq,
        last_inbox_pull_seq = $seq,
        updated_at = $ts
      WHERE id = $id
    `),

    // ---------------- km-tribe.event-classification ----------------

    /** Pull pending inbox rows for a session — push + pull rows whose rowid
     *  exceeds the session's pull cursor and whose recipient matches. */
    getInboxRows: db.prepare(`
		SELECT id, rowid, type, sender, recipient, content, bead_id, ref, ts,
			delivery, topic, room_id
		FROM messages
		WHERE rowid > $since
			AND (recipient = $name OR recipient = '*')
			AND kind != 'event'
			AND sender != $name
		ORDER BY rowid ASC
		LIMIT $limit
	`),

    /** Advance the per-session pull cursor — never decreases. */
    advanceInboxCursor: db.prepare(
      "UPDATE sessions SET last_inbox_pull_seq = MAX(last_inbox_pull_seq, $seq), updated_at = $now WHERE id = $id",
    ),

    /** Read-only fetch of the per-session pull cursor. */
    getInboxCursor: db.prepare("SELECT last_inbox_pull_seq FROM sessions WHERE id = $id"),

    /**
     * Apply a session's filter — single update covering persistent mode +
     * time-bounded mute + per-topic glob list. Replaces the old
     * setSessionMode / setSessionSnooze pair.
     *
     * Pass any field as null to clear that dimension: `$until = null` makes the
     * filter persistent, `$mute = null` silences everything (when a snooze is
     * active), `$mode = 'normal'` returns to default behavior.
     */
    setSessionFilter: db.prepare(
      "UPDATE sessions SET filter_mode = $mode, filter_until = $until, filter_mute = $mute, updated_at = $now WHERE id = $id",
    ),

    /** Read the session's current filter (mode + optional until + optional muted topics). */
    getSessionFilter: db.prepare("SELECT filter_mode, filter_until, filter_mute FROM sessions WHERE id = $id"),

    /**
     * Count prior `type='assign'` messages with the same sender → recipient →
     * bead, strictly before the given rowid. Used by the broadcast pipeline
     * to surface `reissue_count` on assign-typed channel envelopes so the
     * receiver can detect a re-firing of the same task and respond with prior
     * evidence instead of getting trapped in an A/B/C escalation loop.
     *
     * Comparing on `rowid` (monotonic per the SQLite ROWID guarantee) is
     * strictly correct even when two sends fall in the same millisecond — `ts`
     * resolution is too coarse for back-to-back assigns and would under-count.
     *
     * See bead `km-tribe.task-assignment-stale-snapshot`.
     */
    countPriorAssigns: db.prepare(`
      SELECT COUNT(*) as count FROM messages
      WHERE type = 'assign'
        AND sender = $sender
        AND recipient = $recipient
        AND bead_id = $bead_id
        AND rowid < $rowid
    `),
  }
}
