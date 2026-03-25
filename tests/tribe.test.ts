/**
 * Tribe channel plugin — integration tests
 *
 * Tests the SQLite bus directly (without MCP transport) by importing
 * the database logic and verifying message exchange between sessions.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { unlinkSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// Minimal tribe DB helpers (extracted logic, no MCP dependency)
// ---------------------------------------------------------------------------

function createTribeDb(path: string): Database {
  const db = new Database(path, { create: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA busy_timeout = 5000")

  db.run(`CREATE TABLE IF NOT EXISTS sessions (
		id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
		domains TEXT NOT NULL DEFAULT '[]', pid INTEGER NOT NULL,
		cwd TEXT, started_at INTEGER NOT NULL, heartbeat INTEGER NOT NULL,
		pruned_at INTEGER
	)`)
  db.run(`CREATE TABLE IF NOT EXISTS aliases (
		old_name TEXT PRIMARY KEY, session_id TEXT NOT NULL, renamed_at INTEGER NOT NULL
	)`)
  db.run(`CREATE TABLE IF NOT EXISTS messages (
		id TEXT PRIMARY KEY, type TEXT NOT NULL, sender TEXT NOT NULL,
		recipient TEXT NOT NULL, content TEXT NOT NULL, bead_id TEXT,
		ref TEXT, ts INTEGER NOT NULL, read_at INTEGER
	)`)
  db.run(`CREATE TABLE IF NOT EXISTS cursors (
		session_id TEXT PRIMARY KEY, last_read_ts INTEGER NOT NULL
	)`)
  db.run(`CREATE TABLE IF NOT EXISTS events (
		id TEXT PRIMARY KEY, type TEXT NOT NULL, session TEXT,
		bead_id TEXT, data TEXT, ts INTEGER NOT NULL
	)`)
  db.run(`CREATE TABLE IF NOT EXISTS reads (
		message_id TEXT NOT NULL, session_id TEXT NOT NULL,
		read_at INTEGER NOT NULL, PRIMARY KEY (message_id, session_id)
	)`)
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_recipient_ts ON messages(recipient, ts)")
  return db
}

function registerSession(db: Database, id: string, name: string, role: string, domains: string[] = []): void {
  const now = Date.now()
  db.run(
    `INSERT INTO sessions (id, name, role, domains, pid, cwd, started_at, heartbeat)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(name) DO UPDATE SET id=?, role=?, domains=?, pid=?, heartbeat=?`,
    [
      id,
      name,
      role,
      JSON.stringify(domains),
      process.pid,
      process.cwd(),
      now,
      now,
      id,
      role,
      JSON.stringify(domains),
      process.pid,
      now,
    ],
  )
  db.run("INSERT OR IGNORE INTO cursors (session_id, last_read_ts) VALUES (?, ?)", [id, 0])
}

function sendMsg(
  db: Database,
  sender: string,
  recipient: string,
  content: string,
  type = "notify",
  bead_id?: string,
  ref?: string,
): string {
  const id = randomUUID()
  db.run(
    `INSERT INTO messages (id, type, sender, recipient, content, bead_id, ref, ts)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, type, sender, recipient, content, bead_id ?? null, ref ?? null, Date.now()],
  )
  return id
}

function pollMessages(
  db: Database,
  sessionId: string,
  sessionName: string,
): Array<{ id: string; type: string; sender: string; content: string; bead_id: string | null }> {
  const cursor = db.prepare("SELECT last_read_ts FROM cursors WHERE session_id = ?").get(sessionId) as {
    last_read_ts: number
  } | null

  const rows = db
    .prepare(`
		SELECT * FROM messages
		WHERE ts >= ?
		AND id NOT IN (SELECT message_id FROM reads WHERE session_id = ?)
		AND (recipient = ? OR recipient = '*'
		     OR recipient IN (SELECT old_name FROM aliases WHERE session_id = ?))
		AND sender != ?
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
			ts ASC
	`)
    .all(cursor?.last_read_ts ?? 0, sessionId, sessionName, sessionId, sessionName) as Array<{
    id: string
    type: string
    sender: string
    content: string
    bead_id: string | null
    ts: number
  }>

  if (rows.length > 0) {
    const maxTs = Math.max(...rows.map((r) => r.ts))
    db.run("UPDATE cursors SET last_read_ts = ? WHERE session_id = ?", [maxTs, sessionId])
    for (const row of rows) {
      db.run("INSERT OR IGNORE INTO reads (message_id, session_id, read_at) VALUES (?, ?, ?)", [
        row.id,
        sessionId,
        Date.now(),
      ])
    }
  }

  return rows
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let dbPath: string
let db: Database

beforeEach(() => {
  dbPath = join(tmpdir(), `tribe-test-${randomUUID()}.db`)
  db = createTribeDb(dbPath)
})

afterEach(() => {
  db.close()
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath + suffix
    if (existsSync(p)) unlinkSync(p)
  }
})

describe("tribe", () => {
  test("session registration", () => {
    registerSession(db, "id-1", "chief", "chief", ["all"])
    registerSession(db, "id-2", "worker-a", "member", ["silvery", "flexily"])

    const sessions = db.prepare("SELECT name, role, domains FROM sessions ORDER BY name").all() as Array<{
      name: string
      role: string
      domains: string
    }>

    expect(sessions).toHaveLength(2)
    expect(sessions[0]).toEqual({ name: "chief", role: "chief", domains: '["all"]' })
    expect(sessions[1]).toEqual({ name: "worker-a", role: "member", domains: '["silvery","flexily"]' })
  })

  test("direct message: chief → member", () => {
    registerSession(db, "id-chief", "chief", "chief")
    registerSession(db, "id-worker", "worker-a", "member")

    sendMsg(db, "chief", "worker-a", "Claim km-tui.flicker-fix", "assign", "km-tui.flicker-fix")

    const messages = pollMessages(db, "id-worker", "worker-a")
    expect(messages).toHaveLength(1)
    expect(messages[0]!.sender).toBe("chief")
    expect(messages[0]!.type).toBe("assign")
    expect(messages[0]!.content).toBe("Claim km-tui.flicker-fix")
    expect(messages[0]!.bead_id).toBe("km-tui.flicker-fix")
  })

  test("direct message: member → chief", () => {
    registerSession(db, "id-chief", "chief", "chief")
    registerSession(db, "id-worker", "worker-a", "member")

    sendMsg(db, "worker-a", "chief", "Fix committed abc123", "status", "km-tui.flicker-fix")

    const messages = pollMessages(db, "id-chief", "chief")
    expect(messages).toHaveLength(1)
    expect(messages[0]!.sender).toBe("worker-a")
    expect(messages[0]!.type).toBe("status")
  })

  test("broadcast reaches all members", () => {
    registerSession(db, "id-chief", "chief", "chief")
    registerSession(db, "id-a", "worker-a", "member")
    registerSession(db, "id-b", "worker-b", "member")

    sendMsg(db, "chief", "*", "Theme system refactored, pull latest", "notify")

    const msgsA = pollMessages(db, "id-a", "worker-a")
    const msgsB = pollMessages(db, "id-b", "worker-b")
    expect(msgsA).toHaveLength(1)
    expect(msgsB).toHaveLength(1)
    expect(msgsA[0]!.content).toBe("Theme system refactored, pull latest")
  })

  test("sender does not receive own messages", () => {
    registerSession(db, "id-chief", "chief", "chief")

    sendMsg(db, "chief", "*", "Broadcasting something", "notify")

    const messages = pollMessages(db, "id-chief", "chief")
    expect(messages).toHaveLength(0)
  })

  test("cursor advances — no duplicate delivery", () => {
    registerSession(db, "id-chief", "chief", "chief")
    registerSession(db, "id-worker", "worker-a", "member")

    sendMsg(db, "chief", "worker-a", "First message", "notify")
    const first = pollMessages(db, "id-worker", "worker-a")
    expect(first).toHaveLength(1)

    // Poll again — should be empty
    const second = pollMessages(db, "id-worker", "worker-a")
    expect(second).toHaveLength(0)

    // New message arrives
    sendMsg(db, "chief", "worker-a", "Second message", "notify")
    const third = pollMessages(db, "id-worker", "worker-a")
    expect(third).toHaveLength(1)
    expect(third[0]!.content).toBe("Second message")
  })

  test("rename: messages to old name still arrive", () => {
    registerSession(db, "id-worker", "worker-1", "member")
    registerSession(db, "id-chief", "chief", "chief")

    // Rename worker-1 → silvery-worker
    db.run("INSERT INTO aliases (old_name, session_id, renamed_at) VALUES (?, ?, ?)", [
      "worker-1",
      "id-worker",
      Date.now(),
    ])
    db.run("UPDATE sessions SET name = ? WHERE id = ?", ["silvery-worker", "id-worker"])

    // Chief sends to old name (doesn't know about rename yet)
    sendMsg(db, "chief", "worker-1", "Are you still there?", "query")

    // Worker polls with new name — should still receive via alias
    const messages = pollMessages(db, "id-worker", "silvery-worker")
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe("Are you still there?")
  })

  test("rename: messages to new name also arrive", () => {
    registerSession(db, "id-worker", "worker-1", "member")
    registerSession(db, "id-chief", "chief", "chief")

    // Rename
    db.run("INSERT INTO aliases (old_name, session_id, renamed_at) VALUES (?, ?, ?)", [
      "worker-1",
      "id-worker",
      Date.now(),
    ])
    db.run("UPDATE sessions SET name = ? WHERE id = ?", ["silvery-worker", "id-worker"])

    // Chief sends to new name
    sendMsg(db, "chief", "silvery-worker", "Welcome, silvery-worker", "notify")

    const messages = pollMessages(db, "id-worker", "silvery-worker")
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe("Welcome, silvery-worker")
  })

  test("message priority ordering", () => {
    registerSession(db, "id-worker", "worker-a", "member")
    registerSession(db, "id-chief", "chief", "chief")

    // Send in reverse priority order (all at same ts won't work, stagger slightly)
    const baseTs = Date.now()
    db.run("INSERT INTO messages (id, type, sender, recipient, content, ts) VALUES (?, ?, ?, ?, ?, ?)", [
      "m1",
      "notify",
      "chief",
      "worker-a",
      "FYI update",
      baseTs,
    ])
    db.run("INSERT INTO messages (id, type, sender, recipient, content, ts) VALUES (?, ?, ?, ?, ?, ?)", [
      "m2",
      "assign",
      "chief",
      "worker-a",
      "Do this task",
      baseTs + 1,
    ])
    db.run("INSERT INTO messages (id, type, sender, recipient, content, ts) VALUES (?, ?, ?, ?, ?, ?)", [
      "m3",
      "query",
      "chief",
      "worker-a",
      "How's it going?",
      baseTs + 2,
    ])

    // Reset cursor to before these messages
    db.run("UPDATE cursors SET last_read_ts = ? WHERE session_id = ?", [baseTs - 1, "id-worker"])

    const messages = pollMessages(db, "id-worker", "worker-a")
    expect(messages).toHaveLength(3)
    // assign (priority 0) should come first even though sent second
    expect(messages[0]!.type).toBe("assign")
    expect(messages[1]!.type).toBe("query")
    expect(messages[2]!.type).toBe("notify")
  })

  test("heartbeat and liveness", () => {
    registerSession(db, "id-1", "alive-member", "member")
    // Simulate dead session (heartbeat 60s ago)
    db.run(
      `INSERT INTO sessions (id, name, role, domains, pid, cwd, started_at, heartbeat)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["id-2", "dead-member", "member", "[]", 99999, "/tmp", Date.now() - 120_000, Date.now() - 60_000],
    )

    const threshold = Date.now() - 30_000
    const alive = db.prepare("SELECT name FROM sessions WHERE heartbeat > ?").all(threshold) as Array<{ name: string }>

    const dead = db.prepare("SELECT name FROM sessions WHERE heartbeat <= ?").all(threshold) as Array<{ name: string }>

    expect(alive.map((s) => s.name)).toContain("alive-member")
    expect(dead.map((s) => s.name)).toContain("dead-member")
  })

  test("events are logged", () => {
    const now = Date.now()
    db.run("INSERT INTO events (id, type, session, bead_id, data, ts) VALUES (?, ?, ?, ?, ?, ?)", [
      randomUUID(),
      "session.joined",
      "worker-a",
      null,
      '{"name":"worker-a"}',
      now,
    ])
    db.run("INSERT INTO events (id, type, session, bead_id, data, ts) VALUES (?, ?, ?, ?, ?, ?)", [
      randomUUID(),
      "bead.claimed",
      "worker-a",
      "km-tui.fix",
      '{"latency_ms":500}',
      now + 100,
    ])

    const events = db.prepare("SELECT type, session, bead_id FROM events ORDER BY ts").all() as Array<{
      type: string
      session: string
      bead_id: string | null
    }>

    expect(events).toHaveLength(2)
    expect(events[0]!.type).toBe("session.joined")
    expect(events[1]!.type).toBe("bead.claimed")
    expect(events[1]!.bead_id).toBe("km-tui.fix")
  })

  test("read tracking via reads table", () => {
    registerSession(db, "id-chief", "chief", "chief")
    registerSession(db, "id-worker", "worker-a", "member")

    const msgId = sendMsg(db, "chief", "worker-a", "Test", "notify")

    // Before poll: no read record
    const before = db.prepare("SELECT * FROM reads WHERE message_id = ? AND session_id = ?").get(msgId, "id-worker")
    expect(before).toBeNull()

    // After poll: read record exists
    pollMessages(db, "id-worker", "worker-a")
    const after = db
      .prepare("SELECT read_at FROM reads WHERE message_id = ? AND session_id = ?")
      .get(msgId, "id-worker") as { read_at: number } | null
    expect(after).not.toBeNull()
    expect(after!.read_at).toBeGreaterThan(0)
  })

  test("soft pruning: pruned sessions are marked, not deleted", () => {
    registerSession(db, "id-1", "worker-a", "member")
    const prunedAt = Date.now()

    // Soft-prune the session
    db.run("UPDATE sessions SET pruned_at = ? WHERE id = ?", [prunedAt, "id-1"])

    // Session row still exists
    const row = db.prepare("SELECT name, pruned_at FROM sessions WHERE id = ?").get("id-1") as {
      name: string
      pruned_at: number | null
    } | null
    expect(row).not.toBeNull()
    expect(row!.name).toBe("worker-a")
    expect(row!.pruned_at).toBe(prunedAt)
  })

  test("soft pruning: pruned sessions excluded from live query", () => {
    registerSession(db, "id-1", "alive-member", "member")
    registerSession(db, "id-2", "pruned-member", "member")

    // Soft-prune id-2
    db.run("UPDATE sessions SET pruned_at = ? WHERE id = ?", [Date.now(), "id-2"])

    const threshold = Date.now() - 30_000
    const live = db
      .prepare("SELECT name FROM sessions WHERE heartbeat > ? AND pruned_at IS NULL")
      .all(threshold) as Array<{ name: string }>

    expect(live.map((s) => s.name)).toContain("alive-member")
    expect(live.map((s) => s.name)).not.toContain("pruned-member")

    // But allSessions still includes it
    const all = db.prepare("SELECT name FROM sessions").all() as Array<{ name: string }>
    expect(all.map((s) => s.name)).toContain("pruned-member")
  })

  test("auto-rejoin: heartbeat clears pruned_at", () => {
    registerSession(db, "id-1", "worker-a", "member")

    // Soft-prune
    db.run("UPDATE sessions SET pruned_at = ? WHERE id = ?", [Date.now(), "id-1"])

    // Verify pruned
    const before = db.prepare("SELECT pruned_at FROM sessions WHERE id = ?").get("id-1") as {
      pruned_at: number | null
    }
    expect(before.pruned_at).not.toBeNull()

    // Simulate heartbeat (clears pruned_at)
    db.run("UPDATE sessions SET heartbeat = ?, pruned_at = NULL WHERE id = ?", [Date.now(), "id-1"])

    // Verify no longer pruned
    const after = db.prepare("SELECT pruned_at FROM sessions WHERE id = ?").get("id-1") as {
      pruned_at: number | null
    }
    expect(after.pruned_at).toBeNull()
  })

  test("auto-rejoin: pruned session reappears in live query after heartbeat", () => {
    registerSession(db, "id-1", "worker-a", "member")

    // Soft-prune
    db.run("UPDATE sessions SET pruned_at = ? WHERE id = ?", [Date.now(), "id-1"])

    const threshold = Date.now() - 30_000

    // Not in live sessions
    const before = db
      .prepare("SELECT name FROM sessions WHERE heartbeat > ? AND pruned_at IS NULL")
      .all(threshold) as Array<{ name: string }>
    expect(before.map((s) => s.name)).not.toContain("worker-a")

    // Heartbeat clears pruned_at
    db.run("UPDATE sessions SET heartbeat = ?, pruned_at = NULL WHERE id = ?", [Date.now(), "id-1"])

    // Now in live sessions
    const after = db
      .prepare("SELECT name FROM sessions WHERE heartbeat > ? AND pruned_at IS NULL")
      .all(threshold) as Array<{ name: string }>
    expect(after.map((s) => s.name)).toContain("worker-a")
  })

  test("tribe_join: re-register with updated metadata", () => {
    registerSession(db, "id-1", "worker-a", "member", ["silvery"])

    // Simulate tribe_join — update name, role, domains, clear pruned_at
    db.run("UPDATE sessions SET name = ?, role = ?, domains = ?, heartbeat = ?, pruned_at = NULL WHERE id = ?", [
      "silvery-expert",
      "member",
      JSON.stringify(["silvery", "flexily"]),
      Date.now(),
      "id-1",
    ])

    const row = db.prepare("SELECT name, role, domains, pruned_at FROM sessions WHERE id = ?").get("id-1") as {
      name: string
      role: string
      domains: string
      pruned_at: number | null
    }
    expect(row.name).toBe("silvery-expert")
    expect(row.role).toBe("member")
    expect(JSON.parse(row.domains)).toEqual(["silvery", "flexily"])
    expect(row.pruned_at).toBeNull()
  })

  test("tribe_join: clears pruned_at on rejoin", () => {
    registerSession(db, "id-1", "worker-a", "member")

    // Soft-prune then rejoin
    db.run("UPDATE sessions SET pruned_at = ? WHERE id = ?", [Date.now(), "id-1"])
    db.run("UPDATE sessions SET name = ?, role = ?, domains = ?, heartbeat = ?, pruned_at = NULL WHERE id = ?", [
      "worker-a",
      "member",
      JSON.stringify([]),
      Date.now(),
      "id-1",
    ])

    const row = db.prepare("SELECT pruned_at FROM sessions WHERE id = ?").get("id-1") as {
      pruned_at: number | null
    }
    expect(row.pruned_at).toBeNull()
  })
})
