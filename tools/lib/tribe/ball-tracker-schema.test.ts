/**
 * @km/tribe/message-ball-tracker — Phase 1 schema migration test.
 *
 * Verifies that:
 *  (1) A fresh openDatabase creates `messages.request`, `messages.reply`,
 *      `messages_archive.request`, `messages_archive.reply` columns and the
 *      `pending_request` table with its indexes.
 *  (2) An existing v15 database upgrades cleanly when reopened — the
 *      migration adds the columns + table without losing data.
 */

import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { openDatabase } from "./database.ts"

describe("ball-tracker schema (migration v16)", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ball-tracker-test-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("fresh install has request + reply columns on messages", () => {
    const dbPath = join(tmpDir, "tribe.db")
    const db = openDatabase(dbPath)
    try {
      const cols = (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((r) => r.name)
      expect(cols).toContain("request")
      expect(cols).toContain("reply")
    } finally {
      db.close()
    }
  })

  it("fresh install has request + reply columns on messages_archive", () => {
    const dbPath = join(tmpDir, "tribe.db")
    const db = openDatabase(dbPath)
    try {
      const cols = (db.prepare("PRAGMA table_info(messages_archive)").all() as Array<{ name: string }>).map(
        (r) => r.name,
      )
      expect(cols).toContain("request")
      expect(cols).toContain("reply")
    } finally {
      db.close()
    }
  })

  it("fresh install creates pending_request table with composite PK", () => {
    const dbPath = join(tmpDir, "tribe.db")
    const db = openDatabase(dbPath)
    try {
      const cols = db.prepare("PRAGMA table_info(pending_request)").all() as Array<{
        name: string
        pk: number
      }>
      const names = cols.map((r) => r.name)
      expect(names).toEqual(
        expect.arrayContaining(["request_id", "recipient", "sender", "opened_at", "message_id", "fanout"]),
      )
      const pkCols = cols
        .filter((r) => r.pk > 0)
        .map((r) => r.name)
        .sort()
      expect(pkCols).toEqual(["recipient", "request_id"])
    } finally {
      db.close()
    }
  })

  it("composite PK rejects duplicate (request_id, recipient) inserts", () => {
    const dbPath = join(tmpDir, "tribe.db")
    const db = openDatabase(dbPath)
    try {
      db.run(
        "INSERT INTO pending_request (request_id, recipient, sender, opened_at, message_id, fanout) VALUES ('req-1', '@agent/8', '@chief', 1000, 'msg-1', 'first')",
      )
      expect(() => {
        db.run(
          "INSERT INTO pending_request (request_id, recipient, sender, opened_at, message_id, fanout) VALUES ('req-1', '@agent/8', '@chief', 2000, 'msg-2', 'first')",
        )
      }).toThrow(/UNIQUE|constraint/i)
      // Different recipient on same request_id is allowed (multi-target case).
      db.run(
        "INSERT INTO pending_request (request_id, recipient, sender, opened_at, message_id, fanout) VALUES ('req-1', '@agent/0', '@chief', 1000, 'msg-1', 'all')",
      )
      const count = (
        db.prepare("SELECT COUNT(*) as c FROM pending_request WHERE request_id = 'req-1'").get() as {
          c: number
        }
      ).c
      expect(count).toBe(2)
    } finally {
      db.close()
    }
  })

  it("upgrade from v15 adds the new schema without dropping existing data", () => {
    const dbPath = join(tmpDir, "tribe.db")
    // Simulate a v15 DB: only the tables/columns that existed before v16.
    const seedDb = new Database(dbPath, { create: true })
    seedDb.run("PRAGMA journal_mode = WAL")
    seedDb.run("CREATE TABLE _schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    seedDb.run("INSERT INTO _schema_meta (key, value) VALUES ('version', '15')")
    seedDb.run(`CREATE TABLE messages (
			id TEXT PRIMARY KEY, type TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL,
			kind TEXT NOT NULL DEFAULT 'direct', content TEXT NOT NULL,
			bead_id TEXT, ref TEXT, ts INTEGER NOT NULL,
			delivery TEXT NOT NULL DEFAULT 'push', topic TEXT, room_id TEXT
		)`)
    seedDb.run(`CREATE TABLE messages_archive (
			seq INTEGER NOT NULL, id TEXT PRIMARY KEY, type TEXT NOT NULL,
			sender TEXT NOT NULL, recipient TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'direct',
			content TEXT NOT NULL, bead_id TEXT, ref TEXT, ts INTEGER NOT NULL,
			delivery TEXT NOT NULL DEFAULT 'push', topic TEXT, room_id TEXT, archived_at INTEGER NOT NULL
		)`)
    seedDb.run(
      "INSERT INTO messages (id, type, sender, recipient, content, ts) VALUES ('m1', 'notify', '@chief', '@agent/8', 'hello', 1000)",
    )
    seedDb.close()

    // Reopen — migration v16 should fire.
    const db = openDatabase(dbPath)
    try {
      const cols = (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((r) => r.name)
      expect(cols).toContain("request")
      expect(cols).toContain("reply")

      // Existing data preserved.
      const row = db.prepare("SELECT content FROM messages WHERE id = 'm1'").get() as { content: string } | null
      expect(row?.content).toBe("hello")

      // pending_request table created.
      const tableRow = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_request'")
        .get() as { name: string } | null
      expect(tableRow?.name).toBe("pending_request")

      // Schema version bumped to 16.
      const versionRow = db.prepare("SELECT value FROM _schema_meta WHERE key = 'version'").get() as {
        value: string
      } | null
      expect(Number(versionRow?.value)).toBeGreaterThanOrEqual(16)
    } finally {
      db.close()
    }
  })
})
