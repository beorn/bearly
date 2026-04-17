/**
 * Lore database — workspace-state schema for sessions + events.
 *
 * Phase 2 scope: sessions + events only. Phases 3-5 add focus, summaries,
 * dedup tables as additive migrations (CREATE TABLE IF NOT EXISTS).
 */

import { Database } from "bun:sqlite"

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function openLoreDatabase(path: string): Database {
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

  // Phase 3: focus cache — one row per alive Claude Code session, refreshed
  // by the daemon's background poller. Arrays stored as JSON strings.
  db.run(`CREATE TABLE IF NOT EXISTS session_focus (
    claude_pid        INTEGER PRIMARY KEY,
    last_activity_ts  INTEGER,
    age_ms            INTEGER,
    exchange_count    INTEGER NOT NULL DEFAULT 0,
    mentioned_paths   TEXT NOT NULL DEFAULT '[]',
    mentioned_beads   TEXT NOT NULL DEFAULT '[]',
    mentioned_tokens  TEXT NOT NULL DEFAULT '[]',
    tail              TEXT NOT NULL DEFAULT '',
    updated_at        INTEGER NOT NULL
  )`)

  db.run(`CREATE INDEX IF NOT EXISTS idx_session_focus_updated ON session_focus(updated_at)`)

  // Phase 4: opt-in LLM summary columns (additive, try/catch ALTER so
  // reopening an older DB is a no-op on second run).
  for (const col of [
    `ALTER TABLE session_focus ADD COLUMN focus_summary TEXT`,
    `ALTER TABLE session_focus ADD COLUMN loose_ends TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE session_focus ADD COLUMN summary_updated_at INTEGER`,
    `ALTER TABLE session_focus ADD COLUMN summary_model TEXT`,
    `ALTER TABLE session_focus ADD COLUMN summary_cost REAL`,
  ]) {
    try {
      db.run(col)
    } catch {
      /* column already present */
    }
  }

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

export type FocusRow = {
  claude_pid: number
  last_activity_ts: number | null
  age_ms: number | null
  exchange_count: number
  mentioned_paths: string[]
  mentioned_beads: string[]
  mentioned_tokens: string[]
  tail: string
  updated_at: number
  focus_summary: string | null
  loose_ends: string[]
  summary_updated_at: number | null
  summary_model: string | null
  summary_cost: number | null
}

export type SummaryUpsert = {
  claudePid: number
  focusSummary: string
  looseEnds: string[]
  summaryModel: string
  summaryCost: number
  summaryUpdatedAt: number
}

export type FocusUpsert = {
  claudePid: number
  lastActivityTs: number | null
  ageMs: number | null
  exchangeCount: number
  mentionedPaths: string[]
  mentionedBeads: string[]
  mentionedTokens: string[]
  tail: string
  updatedAt: number
}

export type LoreRepo = {
  upsertSession(input: SessionUpsert): SessionRow
  heartbeatSession(claudePid: number, now: number): SessionRow | null
  listSessions(): SessionRow[]
  getSessionByPid(claudePid: number): SessionRow | null
  getSessionBySessionId(sessionId: string): SessionRow | null
  markStale(pid: number, now: number): void
  sweepDeadSessions(now: number, staleAfterMs: number): number
  appendEvent(input: {
    ts: number
    sessionId?: string | null
    claudePid?: number | null
    type: string
    meta?: Record<string, unknown>
  }): void
  upsertFocus(input: FocusUpsert): void
  upsertSummary(input: SummaryUpsert): void
  getFocus(claudePid: number): FocusRow | null
  listFocus(): FocusRow[]
  deleteFocus(claudePid: number): void
  close(): void
}

export function createLoreRepo(db: Database): LoreRepo {
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
  const sweepStmt = db.prepare(`UPDATE sessions SET status = 'stale' WHERE status = 'alive' AND last_seen < $threshold`)
  const insertEventStmt = db.prepare(
    `INSERT INTO events (ts, session_id, claude_pid, type, meta) VALUES ($ts, $sessionId, $pid, $type, $meta)`,
  )

  const upsertFocusStmt = db.prepare(`
    INSERT INTO session_focus (
      claude_pid, last_activity_ts, age_ms, exchange_count,
      mentioned_paths, mentioned_beads, mentioned_tokens, tail, updated_at
    ) VALUES (
      $pid, $lastActivityTs, $ageMs, $exchangeCount,
      $paths, $beads, $tokens, $tail, $updatedAt
    )
    ON CONFLICT(claude_pid) DO UPDATE SET
      last_activity_ts = excluded.last_activity_ts,
      age_ms = excluded.age_ms,
      exchange_count = excluded.exchange_count,
      mentioned_paths = excluded.mentioned_paths,
      mentioned_beads = excluded.mentioned_beads,
      mentioned_tokens = excluded.mentioned_tokens,
      tail = excluded.tail,
      updated_at = excluded.updated_at
  `)
  const getFocusStmt = db.prepare(`SELECT * FROM session_focus WHERE claude_pid = $pid`)
  const listFocusStmt = db.prepare(`SELECT * FROM session_focus ORDER BY updated_at DESC`)
  const deleteFocusStmt = db.prepare(`DELETE FROM session_focus WHERE claude_pid = $pid`)
  const upsertSummaryStmt = db.prepare(`
    UPDATE session_focus SET
      focus_summary = $focus,
      loose_ends = $looseEnds,
      summary_updated_at = $updatedAt,
      summary_model = $model,
      summary_cost = $cost
    WHERE claude_pid = $pid
  `)

  type RawFocus = {
    claude_pid: number
    last_activity_ts: number | null
    age_ms: number | null
    exchange_count: number
    mentioned_paths: string
    mentioned_beads: string
    mentioned_tokens: string
    tail: string
    updated_at: number
    focus_summary: string | null
    loose_ends: string | null
    summary_updated_at: number | null
    summary_model: string | null
    summary_cost: number | null
  }

  function hydrateFocus(raw: RawFocus): FocusRow {
    return {
      claude_pid: raw.claude_pid,
      last_activity_ts: raw.last_activity_ts,
      age_ms: raw.age_ms,
      exchange_count: raw.exchange_count,
      mentioned_paths: safeParseArray(raw.mentioned_paths),
      mentioned_beads: safeParseArray(raw.mentioned_beads),
      mentioned_tokens: safeParseArray(raw.mentioned_tokens),
      tail: raw.tail,
      updated_at: raw.updated_at,
      focus_summary: raw.focus_summary,
      loose_ends: safeParseArray(raw.loose_ends ?? "[]"),
      summary_updated_at: raw.summary_updated_at,
      summary_model: raw.summary_model,
      summary_cost: raw.summary_cost,
    }
  }

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
    upsertFocus(input) {
      upsertFocusStmt.run({
        $pid: input.claudePid,
        $lastActivityTs: input.lastActivityTs,
        $ageMs: input.ageMs,
        $exchangeCount: input.exchangeCount,
        $paths: JSON.stringify(input.mentionedPaths),
        $beads: JSON.stringify(input.mentionedBeads),
        $tokens: JSON.stringify(input.mentionedTokens),
        $tail: input.tail,
        $updatedAt: input.updatedAt,
      })
    },
    getFocus(claudePid) {
      const raw = getFocusStmt.get({ $pid: claudePid }) as RawFocus | undefined
      return raw ? hydrateFocus(raw) : null
    },
    listFocus() {
      return (listFocusStmt.all() as RawFocus[]).map(hydrateFocus)
    },
    deleteFocus(claudePid) {
      deleteFocusStmt.run({ $pid: claudePid })
    },
    upsertSummary(input) {
      upsertSummaryStmt.run({
        $pid: input.claudePid,
        $focus: input.focusSummary,
        $looseEnds: JSON.stringify(input.looseEnds),
        $updatedAt: input.summaryUpdatedAt,
        $model: input.summaryModel,
        $cost: input.summaryCost,
      })
    },
    close() {
      db.close()
    },
  }
}

function safeParseArray(raw: string): string[] {
  try {
    const out = JSON.parse(raw)
    return Array.isArray(out) ? out.map(String) : []
  } catch {
    return []
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
