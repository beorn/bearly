/**
 * Bear database — workspace-state schema for sessions + events.
 *
 * Phase 2 scope: sessions + events only. Phases 3-5 add focus, summaries,
 * dedup tables as additive migrations (CREATE TABLE IF NOT EXISTS).
 */

import { Database } from "bun:sqlite"

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function openBearDatabase(path: string): Database {
  const db = new Database(path, { create: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA busy_timeout = 5000")
  db.run("PRAGMA foreign_keys = ON")

  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    claude_pid       INTEGER PRIMARY KEY,
    session_id       TEXT NOT NULL,
    transcript_path  TEXT,
    cwd              TEXT,
    project          TEXT,
    started_at       INTEGER NOT NULL,
    last_seen        INTEGER NOT NULL,
    status           TEXT NOT NULL DEFAULT 'alive'
  )`)

  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen)`)

  db.run(`CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    session_id  TEXT,
    claude_pid  INTEGER,
    type        TEXT NOT NULL,
    meta        TEXT
  )`)

  db.run(`CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts)`)

  return db
}

// ---------------------------------------------------------------------------
// Session row types
// ---------------------------------------------------------------------------

export type SessionRow = {
  claude_pid: number
  session_id: string
  transcript_path: string | null
  cwd: string | null
  project: string | null
  started_at: number
  last_seen: number
  status: "alive" | "stale"
}

export type SessionUpsert = {
  claudePid: number
  sessionId: string
  transcriptPath?: string | null
  cwd?: string | null
  project?: string | null
  now: number
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export type BearRepo = {
  upsertSession(input: SessionUpsert): SessionRow
  heartbeatSession(claudePid: number, now: number): SessionRow | null
  listSessions(): SessionRow[]
  getSessionByPid(claudePid: number): SessionRow | null
  getSessionBySessionId(sessionId: string): SessionRow | null
  markStale(pid: number, now: number): void
  sweepDeadSessions(now: number, staleAfterMs: number): number
  appendEvent(input: { ts: number; sessionId?: string | null; claudePid?: number | null; type: string; meta?: Record<string, unknown> }): void
  close(): void
}

export function createBearRepo(db: Database): BearRepo {
  const upsertStmt = db.prepare(`
    INSERT INTO sessions (claude_pid, session_id, transcript_path, cwd, project, started_at, last_seen, status)
    VALUES ($pid, $sessionId, $transcriptPath, $cwd, $project, $now, $now, 'alive')
    ON CONFLICT(claude_pid) DO UPDATE SET
      session_id = excluded.session_id,
      transcript_path = excluded.transcript_path,
      cwd = COALESCE(excluded.cwd, sessions.cwd),
      project = COALESCE(excluded.project, sessions.project),
      last_seen = excluded.last_seen,
      status = 'alive'
    RETURNING *
  `)

  const heartbeatStmt = db.prepare(`
    UPDATE sessions SET last_seen = $now, status = 'alive'
    WHERE claude_pid = $pid
    RETURNING *
  `)

  const getByPidStmt = db.prepare(`SELECT * FROM sessions WHERE claude_pid = $pid`)
  const getBySessionIdStmt = db.prepare(
    `SELECT * FROM sessions WHERE session_id = $sessionId ORDER BY last_seen DESC LIMIT 1`,
  )
  const listStmt = db.prepare(`SELECT * FROM sessions ORDER BY last_seen DESC`)
  const markStaleStmt = db.prepare(`UPDATE sessions SET status = 'stale' WHERE claude_pid = $pid`)
  const sweepStmt = db.prepare(
    `UPDATE sessions SET status = 'stale' WHERE status = 'alive' AND last_seen < $threshold`,
  )
  const insertEventStmt = db.prepare(
    `INSERT INTO events (ts, session_id, claude_pid, type, meta) VALUES ($ts, $sessionId, $pid, $type, $meta)`,
  )

  return {
    upsertSession(input) {
      return upsertStmt.get({
        $pid: input.claudePid,
        $sessionId: input.sessionId,
        $transcriptPath: input.transcriptPath ?? null,
        $cwd: input.cwd ?? null,
        $project: input.project ?? null,
        $now: input.now,
      }) as SessionRow
    },
    heartbeatSession(claudePid, now) {
      return (heartbeatStmt.get({ $pid: claudePid, $now: now }) as SessionRow | undefined) ?? null
    },
    listSessions() {
      return listStmt.all() as SessionRow[]
    },
    getSessionByPid(claudePid) {
      return (getByPidStmt.get({ $pid: claudePid }) as SessionRow | undefined) ?? null
    },
    getSessionBySessionId(sessionId) {
      return (getBySessionIdStmt.get({ $sessionId: sessionId }) as SessionRow | undefined) ?? null
    },
    markStale(pid, now) {
      markStaleStmt.run({ $pid: pid })
      insertEventStmt.run({
        $ts: now,
        $sessionId: null,
        $pid: pid,
        $type: "session.marked_stale",
        $meta: null,
      })
    },
    sweepDeadSessions(now, staleAfterMs) {
      const res = sweepStmt.run({ $threshold: now - staleAfterMs })
      return Number(res.changes ?? 0)
    },
    appendEvent(input) {
      insertEventStmt.run({
        $ts: input.ts,
        $sessionId: input.sessionId ?? null,
        $pid: input.claudePid ?? null,
        $type: input.type,
        $meta: input.meta ? JSON.stringify(input.meta) : null,
      })
    },
    close() {
      db.close()
    },
  }
}

// ---------------------------------------------------------------------------
// Row projection
// ---------------------------------------------------------------------------

export function sessionRowToInfo(row: SessionRow): {
  claudePid: number
  sessionId: string
  transcriptPath: string | null
  cwd: string | null
  project: string | null
  startedAt: number
  lastSeen: number
  status: "alive" | "stale"
} {
  return {
    claudePid: row.claude_pid,
    sessionId: row.session_id,
    transcriptPath: row.transcript_path,
    cwd: row.cwd,
    project: row.project,
    startedAt: row.started_at,
    lastSeen: row.last_seen,
    status: row.status,
  }
}
