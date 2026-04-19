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

  // Phase 2 of km-tribe.plateau: schema drops heartbeat/pruned_at in favour
  // of updated_at. Liveness is determined by the daemon's clients Map at
  // runtime — the DB only records lifecycle timestamps for cursor recovery.
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
		id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
		domains TEXT NOT NULL DEFAULT '[]', pid INTEGER NOT NULL,
		cwd TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
		last_delivered_ts INTEGER, last_delivered_seq INTEGER DEFAULT 0
	)`)
  db.run(`CREATE TABLE IF NOT EXISTS messages (
		id TEXT PRIMARY KEY, type TEXT NOT NULL, sender TEXT NOT NULL,
		recipient TEXT NOT NULL, content TEXT NOT NULL, bead_id TEXT,
		ref TEXT, ts INTEGER NOT NULL, read_at INTEGER
	)`)
  db.run(`CREATE TABLE IF NOT EXISTS cursors (
		session_id TEXT PRIMARY KEY, last_read_ts INTEGER NOT NULL
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
    `INSERT INTO sessions (id, name, role, domains, pid, cwd, started_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(name) DO UPDATE SET id=?, role=?, domains=?, pid=?, updated_at=?`,
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
		AND (recipient = ? OR recipient = '*')
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
    .all(cursor?.last_read_ts ?? 0, sessionId, sessionName, sessionName) as Array<{
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

  // Regression test for km-tribe.broadcast-loopback: the daemon's
  // pushNewMessages uses a raw SQL query distinct from pollMessages above.
  // Mirror it verbatim to lock the self-filter into place at the EXACT query
  // level the daemon runs on.
  test("daemon pushNewMessages query filters sender from broadcast (verbatim)", () => {
    registerSession(db, "id-a", "worker-a", "member")
    registerSession(db, "id-b", "worker-b", "member")

    sendMsg(db, "worker-a", "*", "A broadcasts", "notify")
    sendMsg(db, "worker-b", "*", "B broadcasts", "notify")

    // Exact daemon query, with client.name = "worker-a" — must exclude A's own.
    const aSeen = db
      .prepare(
        "SELECT id, type, sender, recipient, content FROM messages WHERE ts > ? AND (recipient = ? OR recipient = '*') AND sender != ? ORDER BY ts ASC",
      )
      .all(0, "worker-a", "worker-a") as Array<{ sender: string; content: string }>
    expect(aSeen.map((m) => m.sender)).toEqual(["worker-b"])
    expect(aSeen.map((m) => m.content)).toEqual(["B broadcasts"])

    const bSeen = db
      .prepare(
        "SELECT id, type, sender, recipient, content FROM messages WHERE ts > ? AND (recipient = ? OR recipient = '*') AND sender != ? ORDER BY ts ASC",
      )
      .all(0, "worker-b", "worker-b") as Array<{ sender: string; content: string }>
    expect(bSeen.map((m) => m.sender)).toEqual(["worker-a"])
  })

  // km-tribe.broadcast-loopback: sender=* fan-out to named recipient still
  // filters the sender, so `tribe.send(to="*")` (wildcard) matches
  // `tribe.broadcast` semantics.
  test("wildcard-send filters sender the same as broadcast", () => {
    registerSession(db, "id-a", "worker-a", "member")
    registerSession(db, "id-b", "worker-b", "member")

    // Wildcard send from A — daemon treats recipient="*" identically to broadcast.
    sendMsg(db, "worker-a", "*", "A wildcard send", "status")

    const aSelf = db
      .prepare("SELECT id FROM messages WHERE ts > ? AND (recipient = ? OR recipient = '*') AND sender != ?")
      .all(0, "worker-a", "worker-a") as Array<{ id: string }>
    expect(aSelf).toHaveLength(0)

    const bSees = db
      .prepare("SELECT id FROM messages WHERE ts > ? AND (recipient = ? OR recipient = '*') AND sender != ?")
      .all(0, "worker-b", "worker-b") as Array<{ id: string }>
    expect(bSees).toHaveLength(1)
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

  test("rename: messages to old name are not received (renames are in-place)", () => {
    registerSession(db, "id-worker", "worker-1", "member")
    registerSession(db, "id-chief", "chief", "chief")

    // Rename worker-1 → silvery-worker (in-place update; old name is not preserved)
    db.run("UPDATE sessions SET name = ? WHERE id = ?", ["silvery-worker", "id-worker"])

    // Chief sends to old name (doesn't know about rename yet)
    sendMsg(db, "chief", "worker-1", "Are you still there?", "query")

    // Worker polls with new name — old-name mail is NOT routed to the new name.
    // Callers must discover the new name (via health/members) and re-send.
    const messages = pollMessages(db, "id-worker", "silvery-worker")
    expect(messages).toHaveLength(0)
  })

  test("rename: messages to new name arrive", () => {
    registerSession(db, "id-worker", "worker-1", "member")
    registerSession(db, "id-chief", "chief", "chief")

    // Rename in place
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

  test("updated_at: registration records a fresh timestamp", () => {
    const before = Date.now()
    registerSession(db, "id-1", "member-a", "member")

    const row = db.prepare("SELECT updated_at FROM sessions WHERE id = ?").get("id-1") as {
      updated_at: number
    } | null
    expect(row).not.toBeNull()
    expect(row!.updated_at).toBeGreaterThanOrEqual(before)
    expect(row!.updated_at).toBeLessThanOrEqual(Date.now() + 10)
  })

  test("events are logged as messages with type 'event.*' and recipient 'log'", () => {
    const now = Date.now()
    db.run(
      "INSERT INTO messages (id, type, sender, recipient, content, bead_id, ref, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [randomUUID(), "event.session.joined", "worker-a", "log", '{"name":"worker-a"}', null, null, now],
    )
    db.run(
      "INSERT INTO messages (id, type, sender, recipient, content, bead_id, ref, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [randomUUID(), "event.bead.claimed", "worker-a", "log", '{"latency_ms":500}', "km-tui.fix", null, now + 100],
    )

    const events = db
      .prepare("SELECT type, sender, bead_id FROM messages WHERE type LIKE 'event.%' AND recipient = 'log' ORDER BY ts")
      .all() as Array<{
      type: string
      sender: string
      bead_id: string | null
    }>

    expect(events).toHaveLength(2)
    expect(events[0]!.type).toBe("event.session.joined")
    expect(events[1]!.type).toBe("event.bead.claimed")
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

  test("sessions table survives across disconnect (cursor recovery)", () => {
    // After Phase 2 of km-tribe.plateau, sessions are not soft-pruned on
    // disconnect — they survive verbatim so that last_delivered_seq can be
    // queried for cursor recovery when the same claudeSessionId reconnects.
    registerSession(db, "id-1", "worker-a", "member")
    // Simulate the daemon advancing the member's cursor as messages are delivered.
    db.run("UPDATE sessions SET last_delivered_seq = ?, last_delivered_ts = ? WHERE id = ?", [42, Date.now(), "id-1"])

    // A row still exists after the connection is gone (no DB-level pruning).
    const row = db
      .prepare("SELECT name, last_delivered_seq, last_delivered_ts FROM sessions WHERE id = ?")
      .get("id-1") as { name: string; last_delivered_seq: number; last_delivered_ts: number } | null
    expect(row).not.toBeNull()
    expect(row!.name).toBe("worker-a")
    expect(row!.last_delivered_seq).toBe(42)
    expect(row!.last_delivered_ts).toBeGreaterThan(0)
  })

  test("rejoin: re-register with updated metadata bumps updated_at", () => {
    registerSession(db, "id-1", "worker-a", "member", ["silvery"])
    const initial = (db.prepare("SELECT updated_at FROM sessions WHERE id = ?").get("id-1") as {
      updated_at: number
    }).updated_at

    // Rejoin happens through upsertSession — simulate it.
    const now = initial + 1000
    db.run("UPDATE sessions SET name = ?, role = ?, domains = ?, updated_at = ? WHERE id = ?", [
      "silvery-expert",
      "member",
      JSON.stringify(["silvery", "flexily"]),
      now,
      "id-1",
    ])

    const row = db.prepare("SELECT name, role, domains, updated_at FROM sessions WHERE id = ?").get("id-1") as {
      name: string
      role: string
      domains: string
      updated_at: number
    }
    expect(row.name).toBe("silvery-expert")
    expect(row.role).toBe("member")
    expect(JSON.parse(row.domains)).toEqual(["silvery", "flexily"])
    expect(row.updated_at).toBe(now)
  })
})

// ---------------------------------------------------------------------------
// registerSession — real library function, exercised end-to-end.
// ---------------------------------------------------------------------------

import { openDatabase, createStatements } from "../tools/lib/tribe/database.ts"
import { createTribeContext } from "../tools/lib/tribe/context.ts"
import { registerSession as realRegisterSession } from "../tools/lib/tribe/session.ts"

describe("registerSession (real impl)", () => {
  let rsDbPath: string

  beforeEach(() => {
    rsDbPath = join(tmpdir(), `tribe-rs-test-${randomUUID()}.db`)
  })

  afterEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = rsDbPath + suffix
      if (existsSync(p)) unlinkSync(p)
    }
  })

  test("colliding name from an ACTIVE holder falls back to a suffixed name", () => {
    const db = openDatabase(rsDbPath)
    const stmts = createStatements(db)
    try {
      const ctxA = createTribeContext({
        db,
        stmts,
        sessionId: randomUUID(),
        sessionRole: "member",
        initialName: "worker",
        domains: [],
        claudeSessionId: null,
        claudeSessionName: null,
      })
      realRegisterSession(ctxA, undefined, () => false)
      expect(ctxA.getName()).toBe("worker")

      // B tries to register with the same name while A is active.
      const ctxB = createTribeContext({
        db,
        stmts,
        sessionId: randomUUID(),
        sessionRole: "member",
        initialName: "worker",
        domains: [],
        claudeSessionId: null,
        claudeSessionName: null,
      })
      // isActive reports A as currently connected — B cannot overwrite its row.
      const activeIds = new Set([ctxA.sessionId])
      realRegisterSession(ctxB, undefined, (sid) => activeIds.has(sid))

      // B got a random suffix; A's row (with its last_delivered_seq / cursor)
      // is preserved for reconnection-time recovery.
      expect(ctxB.getName()).not.toBe("worker")
      expect(ctxB.getName().startsWith("worker-")).toBe(true)

      const rows = db
        .prepare("SELECT id, name FROM sessions ORDER BY name")
        .all() as Array<{ id: string; name: string }>
      expect(rows.map((r) => r.name).sort()).toEqual([ctxB.getName(), "worker"].sort())
      expect(rows.find((r) => r.name === "worker")!.id).toBe(ctxA.sessionId)
    } finally {
      db.close()
    }
  })

  test("colliding name from an INACTIVE holder is overwritten (name reclaimed)", () => {
    const db = openDatabase(rsDbPath)
    const stmts = createStatements(db)
    try {
      // Seed a row for a disconnected session.
      const staleId = randomUUID()
      const ctxStale = createTribeContext({
        db,
        stmts,
        sessionId: staleId,
        sessionRole: "member",
        initialName: "worker",
        domains: [],
        claudeSessionId: null,
        claudeSessionName: null,
      })
      realRegisterSession(ctxStale, undefined, () => false)

      // B registers with the same name; the holder is not in the active set.
      const ctxB = createTribeContext({
        db,
        stmts,
        sessionId: randomUUID(),
        sessionRole: "member",
        initialName: "worker",
        domains: [],
        claudeSessionId: null,
        claudeSessionName: null,
      })
      realRegisterSession(ctxB, undefined, () => false)

      expect(ctxB.getName()).toBe("worker")

      // Only B's row remains (the stale one was evicted so B could claim the name).
      const rows = db.prepare("SELECT id, name FROM sessions").all() as Array<{ id: string; name: string }>
      expect(rows).toHaveLength(1)
      expect(rows[0]!.name).toBe("worker")
      expect(rows[0]!.id).toBe(ctxB.sessionId)
    } finally {
      db.close()
    }
  })
})
