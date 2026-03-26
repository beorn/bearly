#!/usr/bin/env bun
/**
 * Tribe — Cross-session coordination channel for Claude Code
 *
 * An MCP channel plugin that lets multiple Claude Code sessions discover
 * each other, exchange messages, and coordinate work. One session acts
 * as chief (coordinator); the rest are members (workers).
 *
 * Usage:
 *   # In .mcp.json:
 *   { "command": "bun", "args": ["vendor/bearly/tools/tribe.ts", "--name", "chief", "--role", "chief"] }
 *
 *   # Or via env:
 *   TRIBE_NAME=silvery-worker TRIBE_ROLE=member TRIBE_DOMAINS=silvery,flexily
 *
 *   # Launch Claude Code with the channel:
 *   claude --dangerously-load-development-channels server:tribe
 *
 * Design: docs/design/tribe.md
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { execSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { parseArgs } from "node:util"
import { generateRetro, formatMarkdown, parseDuration } from "./tribe-retro.ts"
import { beadsPlugin, gitPlugin, loadPlugins, type PluginContext } from "./lib/tribe/plugins.ts"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    name: { type: "string", default: process.env.TRIBE_NAME },
    role: { type: "string", default: process.env.TRIBE_ROLE },
    domains: { type: "string", default: process.env.TRIBE_DOMAINS ?? "" },
    db: { type: "string", default: process.env.TRIBE_DB },
    "auto-report": { type: "boolean", default: (process.env.TRIBE_AUTO_REPORT ?? "1") === "1" },
  },
  strict: false,
})

const SESSION_DOMAINS = String(args.domains ?? "")
  .split(",")
  .filter(Boolean)
const SESSION_ID = randomUUID()
// Claude Code doesn't pass CLAUDE_SESSION_ID to MCP subprocesses.
// Detect it from BD_ACTOR env var (set by beads session hook) or parent process.
const CLAUDE_SESSION_ID = process.env.CLAUDE_SESSION_ID ?? process.env.BD_ACTOR?.replace("claude:", "") ?? null
const CLAUDE_SESSION_NAME = process.env.CLAUDE_SESSION_NAME ?? null

// Find .beads/ directory by walking up from cwd (returns null if not found)
function findBeadsDir(): string | null {
  let dir = process.cwd()
  while (dir !== "/") {
    const candidate = resolve(dir, ".beads")
    if (existsSync(candidate)) return candidate
    dir = dirname(dir)
  }
  return null
}

// DB location: --db flag > TRIBE_DB env > .beads/tribe.db > ~/.local/share/tribe/tribe.db
function resolveDbPath(): string {
  if (args.db) return String(args.db)
  if (process.env.TRIBE_DB) return process.env.TRIBE_DB
  const beadsDir = findBeadsDir()
  if (beadsDir) return resolve(beadsDir, "tribe.db")
  // No .beads/ found — use XDG data dir
  const xdgData = process.env.XDG_DATA_HOME ?? resolve(process.env.HOME ?? "~", ".local/share")
  const tribeDir = resolve(xdgData, "tribe")
  mkdirSync(tribeDir, { recursive: true })
  return resolve(tribeDir, "tribe.db")
}

const BEADS_DIR = findBeadsDir()
const DB_PATH = resolveDbPath()

// Auto-detect role: if no chief exists (or chief is dead), become chief; otherwise member
function detectRole(db: Database): "chief" | "member" {
  if (args.role) return args.role as "chief" | "member"
  const threshold = Date.now() - 30_000
  const liveChief = db.prepare("SELECT name FROM sessions WHERE role = 'chief' AND heartbeat > ?").get(threshold)
  return liveChief ? "member" : "chief"
}

// Auto-generate name: chief gets "chief", members get "member-<N>"
// Uses PID as tiebreaker to avoid UNIQUE conflicts when multiple sessions start simultaneously
function detectName(db: Database, role: "chief" | "member"): string {
  if (args.name) return String(args.name)
  if (role === "chief") return "chief"
  // Use PID-based name to avoid race conditions (max+1 can collide)
  const pidName = `member-${process.pid}`
  const taken = db.prepare("SELECT id FROM sessions WHERE name = ? AND pruned_at IS NULL").get(pidName)
  if (!taken) return pidName
  // PID collision (unlikely) — fall back to random suffix
  return `member-${process.pid}-${Math.random().toString(36).slice(2, 5)}`
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

function openDatabase(path: string): Database {
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
		claude_session_id TEXT,
		claude_session_name TEXT,
		started_at INTEGER NOT NULL,
		heartbeat  INTEGER NOT NULL,
		pruned_at  INTEGER
	)`)

  // Migration: add columns if they don't exist (for existing DBs)
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

  return db
}

const db = openDatabase(String(DB_PATH))
const SESSION_ROLE = detectRole(db)
const SESSION_NAME = detectName(db, SESSION_ROLE)

// Log startup info to stderr (visible in Claude Code debug logs)
process.stderr.write(`[tribe] ${SESSION_NAME} (${SESSION_ROLE}) joining tribe at ${DB_PATH}\n`)
process.stderr.write(`[tribe] claude_session_id=${CLAUDE_SESSION_ID ?? "none"}\n`)

if (SESSION_DOMAINS.length > 0) {
  process.stderr.write(`[tribe] domains: ${SESSION_DOMAINS.join(", ")}\n`)
}

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

const stmts = {
  upsertSession: db.prepare(`
		INSERT INTO sessions (id, name, role, domains, pid, cwd, claude_session_id, claude_session_name, started_at, heartbeat, pruned_at)
		VALUES ($id, $name, $role, $domains, $pid, $cwd, $claude_session_id, $claude_session_name, $now, $now, NULL)
		ON CONFLICT(id) DO UPDATE SET
			name = $name, role = $role, domains = $domains,
			pid = $pid, cwd = $cwd, claude_session_id = $claude_session_id,
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
		SELECT id, name, role, domains, pid, cwd, claude_session_id, claude_session_name, started_at, heartbeat, pruned_at
		FROM sessions
		WHERE heartbeat > $threshold AND pruned_at IS NULL
	`),

  allSessions: db.prepare(
    "SELECT id, name, role, domains, pid, cwd, claude_session_id, claude_session_name, started_at, heartbeat, pruned_at FROM sessions",
  ),

  messageHistory: db.prepare(`
		SELECT * FROM messages
		WHERE (sender = $name OR recipient = $name OR recipient = '*')
		ORDER BY ts DESC
		LIMIT $limit
	`),

  checkNameTaken: db.prepare("SELECT id FROM sessions WHERE name = $name AND id != $session_id AND pruned_at IS NULL"),

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

  updateLastDelivered: db.prepare("UPDATE sessions SET last_delivered_ts = $ts, last_delivered_seq = $seq WHERE id = $id"),

  getLastDelivered: db.prepare("SELECT last_delivered_ts, last_delivered_seq FROM sessions WHERE id = $id"),

  activeSessions: db.prepare(
    "SELECT id, name, role, domains, pid, cwd, claude_session_id, claude_session_name, started_at, heartbeat, pruned_at FROM sessions WHERE pruned_at IS NULL",
  ),

  deleteOldPrunedSessions: db.prepare("DELETE FROM sessions WHERE pruned_at IS NOT NULL AND pruned_at < $cutoff"),
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

let currentName = SESSION_NAME

function now(): number {
  return Date.now()
}

function registerSession(): void {
  try {
    stmts.upsertSession.run({
      $id: SESSION_ID,
      $name: currentName,
      $role: SESSION_ROLE,
      $domains: JSON.stringify(SESSION_DOMAINS),
      $pid: process.pid,
      $cwd: process.cwd(),
      $claude_session_id: CLAUDE_SESSION_ID,
      $claude_session_name: CLAUDE_SESSION_NAME,
      $now: now(),
    })
  } catch (err) {
    // Name collision — add random suffix and retry
    const fallbackName = `${currentName}-${Math.random().toString(36).slice(2, 5)}`
    process.stderr.write(`[tribe] name "${currentName}" taken, using "${fallbackName}"\n`)
    currentName = fallbackName
    stmts.upsertSession.run({
      $id: SESSION_ID,
      $name: currentName,
      $role: SESSION_ROLE,
      $domains: JSON.stringify(SESSION_DOMAINS),
      $pid: process.pid,
      $cwd: process.cwd(),
      $claude_session_id: CLAUDE_SESSION_ID,
      $claude_session_name: CLAUDE_SESSION_NAME,
      $now: now(),
    })
  }

  stmts.insertEvent.run({
    $id: randomUUID(),
    $type: "session.joined",
    $session: currentName,
    $bead_id: null,
    $data: JSON.stringify({ name: currentName, role: SESSION_ROLE, domains: SESSION_DOMAINS }),
    $ts: now(),
  })

  // Initialize cursor if needed
  const cursor = stmts.getCursor.get({ $session_id: SESSION_ID }) as {
    last_read_ts: number
    last_seq: number | null
  } | null
  if (!cursor) {
    // On reconnect after compaction: recover last_delivered_seq from prior session with same claude_session_id
    // to avoid re-delivering already-seen messages
    let initialTs = 0
    let initialSeq = 0
    if (CLAUDE_SESSION_ID) {
      const prior = db
        .prepare(
          "SELECT last_delivered_ts, last_delivered_seq FROM sessions WHERE claude_session_id = $csid AND id != $id AND last_delivered_ts IS NOT NULL ORDER BY last_delivered_ts DESC LIMIT 1",
        )
        .get({ $csid: CLAUDE_SESSION_ID, $id: SESSION_ID }) as {
        last_delivered_ts: number
        last_delivered_seq: number | null
      } | null
      if (prior?.last_delivered_ts) {
        initialTs = prior.last_delivered_ts
        initialSeq = prior.last_delivered_seq ?? 0
        process.stderr.write(`[tribe] recovered cursor from prior session: seq=${initialSeq} ts=${new Date(initialTs).toISOString()}\n`)
      }
    }
    // Backward compat: if no seq available, bootstrap from current max rowid
    if (initialSeq === 0 && initialTs > 0) {
      const maxRow = db.prepare("SELECT MAX(rowid) as max_rowid FROM messages WHERE ts <= $ts").get({ $ts: initialTs }) as { max_rowid: number | null } | null
      initialSeq = maxRow?.max_rowid ?? 0
      process.stderr.write(`[tribe] migrated ts cursor to seq=${initialSeq}\n`)
    }
    stmts.upsertCursor.run({ $session_id: SESSION_ID, $ts: initialTs, $seq: initialSeq })
  } else if (!cursor.last_seq) {
    // Backward compat: existing cursor without last_seq — migrate from last_read_ts
    const maxRow = db.prepare("SELECT MAX(rowid) as max_rowid FROM messages WHERE ts <= $ts").get({ $ts: cursor.last_read_ts }) as { max_rowid: number | null } | null
    const migratedSeq = maxRow?.max_rowid ?? 0
    stmts.upsertCursor.run({ $session_id: SESSION_ID, $ts: cursor.last_read_ts, $seq: migratedSeq })
    process.stderr.write(`[tribe] migrated existing cursor to seq=${migratedSeq}\n`)
  }
}

// ---------------------------------------------------------------------------
// Initial name from Claude Code's transcript slug (one-time, startup only)
// ---------------------------------------------------------------------------

let userRenamed = false // Set to true after explicit tribe_rename — blocks further auto-naming

function resolveTranscriptPath(): string | null {
  if (!CLAUDE_SESSION_ID) return null
  const cwd = process.cwd()
  const projectKey = "-" + cwd.replace(/\//g, "-")
  const transcriptPath = resolve(process.env.HOME ?? "~", ".claude/projects", projectKey, `${CLAUDE_SESSION_ID}.jsonl`)
  return existsSync(transcriptPath) ? transcriptPath : null
}

const TRANSCRIPT_PATH = resolveTranscriptPath()

/** Read the slug from the transcript — used once at startup to set initial name */
function readTranscriptSlug(): string | null {
  if (!TRANSCRIPT_PATH) return null
  try {
    const size = Bun.file(TRANSCRIPT_PATH).size
    if (size === 0) return null
    const text = new TextDecoder().decode(
      new Uint8Array(readFileSync(TRANSCRIPT_PATH).buffer.slice(Math.max(0, size - 4096))),
    )
    const lines = text.trimEnd().split("\n")
    const lastLine = lines[lines.length - 1]
    if (!lastLine) return null
    const data = JSON.parse(lastLine) as { slug?: string }
    return data.slug ?? null
  } catch {
    return null
  }
}

// One-time: if session has a generic member-N name, try to set it from the transcript slug
function tryInitialRename(): void {
  if (!currentName.startsWith("member-")) return // Already has a real name
  const slug = readTranscriptSlug()
  if (!slug || slug === currentName) return

  const existing = stmts.checkNameTaken.get({ $name: slug, $session_id: SESSION_ID })
  if (existing) return

  const oldName = currentName
  stmts.insertAlias.run({ $old_name: oldName, $session_id: SESSION_ID, $now: now() })
  stmts.renameSession.run({ $new_name: slug, $session_id: SESSION_ID })
  currentName = slug
  sendMessage("*", `Member "${oldName}" is now "${slug}"`, "notify")
  logEvent("session.renamed", undefined, { old_name: oldName, new_name: slug, source: "initial-slug" })
  process.stderr.write(`[tribe] initial name from /rename: ${oldName} → ${slug}\n`)
}

/** Delete sessions pruned more than 24 hours ago */
function cleanupOldPrunedSessions(): void {
  const cutoff = now() - 24 * 60 * 60 * 1000
  const result = stmts.deleteOldPrunedSessions.run({ $cutoff: cutoff })
  if (result.changes > 0) {
    process.stderr.write(`[tribe] cleaned up ${result.changes} old pruned session(s)\n`)
  }
}

function sendHeartbeat(): void {
  // Check if we were pruned — if so, log a rejoin event
  const session = db.prepare("SELECT pruned_at FROM sessions WHERE id = ?").get(SESSION_ID) as {
    pruned_at: number | null
  } | null
  if (session?.pruned_at) {
    logEvent("session.rejoined", undefined, { name: currentName, role: SESSION_ROLE, domains: SESSION_DOMAINS })
    process.stderr.write(`[tribe] ${currentName} rejoined tribe (was pruned)\n`)
    // Re-register to restore name (pruning renames to free the original name)
    registerSession()
    return
  }
  stmts.heartbeat.run({ $id: SESSION_ID, $now: now() })
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

function sendMessage(
  recipient: string,
  content: string,
  type = "notify",
  bead_id?: string,
  ref?: string,
): { id: string } {
  const id = randomUUID()
  stmts.insertMessage.run({
    $id: id,
    $type: type,
    $sender: currentName,
    $recipient: recipient,
    $content: content,
    $bead_id: bead_id ?? null,
    $ref: ref ?? null,
    $ts: now(),
  })
  return { id }
}

function logEvent(type: string, bead_id?: string, data?: Record<string, unknown>): void {
  stmts.insertEvent.run({
    $id: randomUUID(),
    $type: type,
    $session: currentName,
    $bead_id: bead_id ?? null,
    $data: data ? JSON.stringify(data) : null,
    $ts: now(),
  })
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const chiefInstructions = `Messages from other Claude Code sessions arrive as <channel source="tribe" from="..." type="..." bead="...">.

You are the chief of a tribe — a coordinator for multiple Claude Code sessions working on the same project.

Coordination protocol:
- Use tribe_sessions() to see who's online and their domains
- Use tribe_send(to, message, type) to assign work, answer queries, or approve requests
- Use tribe_broadcast(message) to announce changes that affect everyone
- Use tribe_health() to check for silent members or conflicts
- If beads are available (bd command exists), use bd create/update/close for persistent task tracking

When a member sends a "status" message, update any relevant tracking.
When a member sends a "request" message, check for conflicts before approving.
When a member sends a "query" message, either answer directly or route to the right member.
When a member goes silent (tribe_health shows warning), send a query to check on them.
If a member dies (heartbeat timeout), reassign their beads to another member.

Message format rules:
- Keep messages SHORT — 1-3 lines max. No essays.
- Use plain text only — no markdown (**bold**, headers, bullets). It renders as ugly escaped text.
- For sync broadcasts: keep the template concise, ask for one-line responses.
- Don't send overlapping sync/rollcall requests — one at a time, wait for responses.
- Batch-acknowledge: if you receive many messages at once, one summary covers all.`

const memberInstructions = `Messages from other Claude Code sessions arrive as <channel source="tribe" from="..." type="..." bead="...">.

You are a tribe member — a worker session coordinated by the chief.

Coordination protocol:
- When you claim a bead, send a status to chief
- When you commit a fix, send a status to chief with the commit hash
- When you're blocked, send a status to chief immediately — include what would unblock you
- Before editing vendor/ or shared files, send a request to chief asking for OK
- If you discover a new bug, create a bead and notify the tribe
- When all assigned work is done, send a status: "Available"
- Respond to query messages promptly

Infrastructure reporting — notify chief when you:
- Begin or complete a multi-file refactor (others may not be able to build)
- Need an npm package that hasn't been published yet
- Create or merge a git worktree
- Modify shared config (package.json, tsconfig, .mcp.json)
- Experience slowdowns (CPU contention from concurrent test runs, etc.)

Message format rules:
- Keep messages SHORT — 1-3 lines max. No essays.
- Use plain text only — no markdown (**bold**, headers, bullets). It renders as ugly escaped text.
- For sync responses: "Session: name | Idle: Xm | Closed: N beads | Blockers: none | Available"
- For status: "Claimed km-foo.bar" or "Committed abc1234 fix(scope): message" or "Available"
- For blocking: "Blocked on km-foo.bar — need X to unblock"
- Batch-acknowledge stale messages: "Acknowledged N old messages, no action needed" (one line, not per-message)
- NEVER respond to messages individually if you received a batch — one summary response covers all.

Don't over-communicate — only send messages when it changes what someone else should do.`

const mcp = new Server(
  { name: "tribe", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: SESSION_ROLE === "chief" ? chiefInstructions : memberInstructions,
  },
)

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "tribe_send",
      description: "Send a message to a specific tribe member",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: { type: "string", description: "Recipient session name" },
          message: { type: "string", description: "Message content" },
          type: {
            type: "string",
            description: "Message type",
            enum: ["assign", "status", "query", "response", "notify", "request", "verdict"],
            default: "notify",
          },
          bead: { type: "string", description: "Associated bead ID (optional)" },
          ref: { type: "string", description: "Reference to a previous message ID (optional)" },
        },
        required: ["to", "message"],
      },
    },
    {
      name: "tribe_broadcast",
      description: "Broadcast a message to all tribe members",
      inputSchema: {
        type: "object" as const,
        properties: {
          message: { type: "string", description: "Message content" },
          type: {
            type: "string",
            description: "Message type",
            enum: ["notify", "status"],
            default: "notify",
          },
          bead: { type: "string", description: "Associated bead ID (optional)" },
        },
        required: ["message"],
      },
    },
    {
      name: "tribe_sessions",
      description: "List active tribe sessions with their roles and domains",
      inputSchema: {
        type: "object" as const,
        properties: {
          all: { type: "boolean", description: "Include dead sessions (default: false)" },
        },
      },
    },
    {
      name: "tribe_history",
      description: "View recent message history",
      inputSchema: {
        type: "object" as const,
        properties: {
          with: { type: "string", description: "Filter to messages involving this session" },
          limit: { type: "number", description: "Max messages to return (default: 20)" },
        },
      },
    },
    {
      name: "tribe_rename",
      description: "Rename this session in the tribe",
      inputSchema: {
        type: "object" as const,
        properties: {
          new_name: { type: "string", description: "New session name" },
        },
        required: ["new_name"],
      },
    },
    {
      name: "tribe_health",
      description: "Diagnostic: check for silent members, stale beads, unread messages",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "tribe_join",
      description: "Re-announce this session's name, role, and domains (e.g. after compaction/rejoin)",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Session name" },
          role: {
            type: "string",
            description: "Session role",
            enum: ["chief", "member"],
          },
          domains: {
            type: "array",
            items: { type: "string" },
            description: "Domain expertise areas (e.g. ['silvery', 'flexily'])",
          },
        },
        required: ["name", "role"],
      },
    },
    {
      name: "tribe_reload",
      description:
        "Hot-reload the tribe MCP server — re-exec with latest code from disk. Use after tribe.ts is updated to pick up fixes without restarting the Claude Code session.",
      inputSchema: {
        type: "object" as const,
        properties: {
          reason: {
            type: "string",
            description: "Why the reload is needed (logged to events)",
          },
        },
      },
    },
    {
      name: "tribe_retro",
      description:
        "Generate a retrospective report analyzing tribe message history, coordination health, and per-member activity",
      inputSchema: {
        type: "object" as const,
        properties: {
          since: {
            type: "string",
            description: 'Duration to look back (e.g. "2h", "30m", "1d"). Default: entire session.',
          },
          format: {
            type: "string",
            description: "Output format",
            enum: ["markdown", "json"],
            default: "markdown",
          },
        },
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: toolArgs } = req.params
  const a = (toolArgs ?? {}) as Record<string, unknown>

  switch (name) {
    case "tribe_send": {
      const result = sendMessage(
        a.to as string,
        a.message as string,
        (a.type as string) ?? "notify",
        a.bead as string | undefined,
        a.ref as string | undefined,
      )
      logEvent(`message.sent.${(a.type as string) ?? "notify"}`, a.bead as string | undefined, {
        to: a.to,
        message_id: result.id,
      })
      return { content: [{ type: "text", text: JSON.stringify({ sent: true, id: result.id }) }] }
    }

    case "tribe_broadcast": {
      const result = sendMessage("*", a.message as string, (a.type as string) ?? "notify", a.bead as string | undefined)
      logEvent("message.broadcast", a.bead as string | undefined, { message_id: result.id })
      return { content: [{ type: "text", text: JSON.stringify({ sent: true, id: result.id }) }] }
    }

    case "tribe_sessions": {
      const threshold = now() - 30_000
      const rows = stmts.allSessions.all() as Array<{
        id: string
        name: string
        role: string
        domains: string
        pid: number
        cwd: string
        claude_session_id: string | null
        claude_session_name: string | null
        started_at: number
        heartbeat: number
        pruned_at: number | null
      }>

      // Auto-prune: check PID liveness and soft-prune dead sessions
      const dead: string[] = []
      for (const r of rows) {
        if (r.pid === process.pid) continue // don't kill ourselves
        if (r.pruned_at) continue // already pruned
        try {
          process.kill(r.pid, 0) // signal 0 = check if process exists
        } catch {
          dead.push(r.name)
          const pruneTs = now()
          stmts.pruneSession.run({ $id: r.id, $now: pruneTs, $pruned_name: `${r.name}-pruned-${pruneTs}` })
        }
      }

      // Re-query after pruning
      const liveRows = a.all ? stmts.allSessions.all() : stmts.liveSessions.all({ $threshold: threshold })
      const sessions = (
        liveRows as Array<{
          id: string
          name: string
          role: string
          domains: string
          pid: number
          cwd: string
          claude_session_id: string | null
          claude_session_name: string | null
          started_at: number
          heartbeat: number
          pruned_at: number | null
        }>
      ).map((r) => ({
        name: r.name,
        role: r.role,
        domains: JSON.parse(r.domains),
        pid: r.pid,
        cwd: r.cwd,
        claude_session_id: r.claude_session_id,
        claude_session_name: r.claude_session_name,
        alive: r.heartbeat > threshold && !r.pruned_at,
        pruned: !!r.pruned_at,
        uptime_min: Math.round((now() - r.started_at) / 60_000),
        last_heartbeat_sec: Math.round((now() - r.heartbeat) / 1000),
      }))
      const result: Record<string, unknown> = { sessions }
      if (dead.length > 0) result.pruned = dead
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
    }

    case "tribe_history": {
      const who = (a.with as string) ?? currentName
      const limit = (a.limit as number) ?? 20
      const rows = stmts.messageHistory.all({ $name: who, $limit: limit }) as Array<{
        id: string
        type: string
        sender: string
        recipient: string
        content: string
        bead_id: string
        ref: string
        ts: number
        read_at: number
      }>
      const messages = rows.map((r) => ({
        id: r.id,
        type: r.type,
        from: r.sender,
        to: r.recipient,
        content: r.content,
        bead: r.bead_id,
        ref: r.ref,
        ts: new Date(r.ts).toISOString(),
        read: !!r.read_at,
      }))
      return { content: [{ type: "text", text: JSON.stringify(messages, null, 2) }] }
    }

    case "tribe_rename": {
      const newName = a.new_name as string
      // Check if name is taken
      const existing = stmts.checkNameTaken.get({ $name: newName, $session_id: SESSION_ID })
      if (existing) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Name "${newName}" is already taken` }) }] }
      }
      const oldName = currentName
      stmts.insertAlias.run({ $old_name: oldName, $session_id: SESSION_ID, $now: now() })
      stmts.renameSession.run({ $new_name: newName, $session_id: SESSION_ID })
      currentName = newName
      userRenamed = true // Explicit rename — name is now sticky, won't be overridden
      // Broadcast the rename
      sendMessage("*", `Member "${oldName}" is now "${newName}"`, "notify")
      logEvent("session.renamed", undefined, { old_name: oldName, new_name: newName })
      return {
        content: [{ type: "text", text: JSON.stringify({ renamed: true, old_name: oldName, new_name: newName }) }],
      }
    }

    case "tribe_join": {
      const joinName = a.name as string
      const joinRole = (a.role as string) ?? SESSION_ROLE
      const joinDomains = (a.domains as string[]) ?? SESSION_DOMAINS

      // Check if name is taken by another session
      const taken = stmts.checkNameTaken.get({ $name: joinName, $session_id: SESSION_ID })
      if (taken) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Name "${joinName}" is already taken` }) }] }
      }

      const prevName = currentName
      // If name changed, create an alias for the old name
      if (joinName !== prevName) {
        stmts.insertAlias.run({ $old_name: prevName, $session_id: SESSION_ID, $now: now() })
      }

      stmts.updateSessionMeta.run({
        $id: SESSION_ID,
        $name: joinName,
        $role: joinRole,
        $domains: JSON.stringify(joinDomains),
        $now: now(),
      })
      currentName = joinName

      logEvent("session.joined", undefined, { name: joinName, role: joinRole, domains: joinDomains, rejoin: true })

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              joined: true,
              name: joinName,
              role: joinRole,
              domains: joinDomains,
              previous_name: joinName !== prevName ? prevName : undefined,
            }),
          },
        ],
      }
    }

    case "tribe_health": {
      const threshold = now() - 30_000
      const silentThreshold = now() - 300_000 // 5 minutes

      // Only check non-pruned sessions
      const activeSessions = stmts.activeSessions.all() as Array<{
        id: string
        name: string
        role: string
        domains: string
        pid: number
        started_at: number
        heartbeat: number
        pruned_at: number | null
      }>

      // Auto-prune: check PID liveness and soft-prune dead sessions
      const pruned: string[] = []
      for (const s of activeSessions) {
        if (s.pid === process.pid) continue
        try {
          process.kill(s.pid, 0)
        } catch {
          pruned.push(s.name)
          const pruneTs = now()
          stmts.pruneSession.run({ $id: s.id, $now: pruneTs, $pruned_name: `${s.name}-pruned-${pruneTs}` })
        }
      }

      // Clean up sessions pruned more than 24 hours ago
      cleanupOldPrunedSessions()

      // Re-query active sessions after pruning
      const liveSessions = stmts.activeSessions.all() as typeof activeSessions

      const members = liveSessions.map((s) => {
        const alive = s.heartbeat > threshold
        // Find last message from this member
        const lastMsg = db
          .prepare("SELECT ts FROM messages WHERE sender = $name ORDER BY ts DESC LIMIT 1")
          .get({ $name: s.name }) as { ts: number } | null

        const lastMsgAge = lastMsg ? now() - lastMsg.ts : null
        const warnings: string[] = []
        if (!alive) warnings.push("heartbeat timeout — session may be dead")
        if (alive && lastMsgAge && lastMsgAge > silentThreshold) {
          warnings.push(`no message in ${Math.round(lastMsgAge / 60_000)} min`)
        }
        if (!alive && !lastMsg) warnings.push("never sent a message")

        return {
          name: s.name,
          role: s.role,
          domains: JSON.parse(s.domains),
          alive,
          last_message: lastMsgAge ? `${Math.round(lastMsgAge / 60_000)} min ago` : "never",
          warnings,
        }
      })

      // Unread message count per recipient (direct messages only)
      const unread = db
        .prepare(`
				SELECT m.recipient, COUNT(*) as count FROM messages m
				WHERE m.recipient != '*'
				AND NOT EXISTS (
					SELECT 1 FROM reads r
					JOIN sessions s ON r.session_id = s.id
					WHERE r.message_id = m.id AND s.name = m.recipient
				)
				GROUP BY m.recipient
			`)
        .all() as Array<{ recipient: string; count: number }>

      const result: Record<string, unknown> = { members, unread, checked_at: new Date().toISOString() }
      if (pruned.length > 0) result.pruned = pruned
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      }
    }

    case "tribe_reload": {
      const reason = (a.reason as string) ?? "manual reload"
      logEvent("session.reload", undefined, { name: currentName, reason })
      process.stderr.write(`[tribe] reloading: ${reason}\n`)

      // Schedule re-exec after responding to the tool call
      setTimeout(() => {
        cleanup()
        // Re-exec the same script with the same args — picks up latest code from disk
        const args = process.argv.slice(1) // drop the bun/node executable
        process.stderr.write(`[tribe] exec: ${process.execPath} ${args.join(" ")}\n`)
        // Use Bun.spawn to replace the process
        const child = Bun.spawn([process.execPath, ...args], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          env: process.env,
        })
        // Forward exit
        child.exited.then((code) => process.exit(code ?? 0))
      }, 100) // small delay so the tool response gets sent first

      return {
        content: [{ type: "text", text: JSON.stringify({ reloading: true, reason, pid: process.pid }) }],
      }
    }

    case "tribe_retro": {
      const sinceStr = a.since as string | undefined
      let sinceMs: number | undefined
      if (sinceStr) {
        try {
          sinceMs = parseDuration(sinceStr)
        } catch {
          return { content: [{ type: "text", text: JSON.stringify({ error: `Invalid duration: "${sinceStr}"` }) }] }
        }
      }
      const fmt = (a.format as string) ?? "markdown"
      const report = generateRetro(db, sinceMs)
      const text = fmt === "json" ? JSON.stringify(report, null, 2) : formatMarkdown(report)
      return { content: [{ type: "text", text }] }
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
})

// ---------------------------------------------------------------------------
// Polling loop — check for new messages and push as channel notifications
// ---------------------------------------------------------------------------

let polling = false
async function pollMessages(): Promise<void> {
  if (polling) return
  polling = true
  try {
    try {
      const cursor = stmts.getCursor.get({ $session_id: SESSION_ID }) as {
        last_read_ts: number
        last_seq: number | null
      } | null
      const lastSeq = cursor?.last_seq ?? 0

      const rows = stmts.pollMessages.all({
        $last_seq: lastSeq,
        $name: currentName,
        $session_id: SESSION_ID,
      }) as Array<{
        rowid: number
        id: string
        type: string
        sender: string
        recipient: string
        content: string
        bead_id: string
        ref: string
        ts: number
      }>

      // Don't deliver our own messages back to us
      const incoming = rows.filter((r) => r.sender !== currentName)

      for (const msg of incoming) {
        const meta: Record<string, string> = {
          from: msg.sender,
          type: msg.type,
          message_id: msg.id,
        }
        if (msg.bead_id) meta.bead = msg.bead_id
        if (msg.ref) meta.ref = msg.ref

        await mcp.notification({
          method: "notifications/claude/channel",
          params: { content: msg.content, meta },
        })

        stmts.markRead.run({ $message_id: msg.id, $session_id: SESSION_ID, $now: now() })
      }

      // Advance cursor to latest rowid (including our own messages)
      if (rows.length > 0) {
        const maxSeq = Math.max(...rows.map((r) => r.rowid))
        const maxTs = Math.max(...rows.map((r) => r.ts))
        stmts.upsertCursor.run({ $session_id: SESSION_ID, $ts: maxTs, $seq: maxSeq })
        // Track last delivery so reconnecting sessions skip already-delivered messages
        if (incoming.length > 0) {
          stmts.updateLastDelivered.run({ $id: SESSION_ID, $ts: maxTs, $seq: maxSeq })
        }
      }
    } catch {
      // SQLite busy or other transient error — retry next poll
    }
  } finally {
    polling = false
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

registerSession()
cleanupOldPrunedSessions()

// One-time: if we have a generic member-N name, try to pick up the /rename slug
tryInitialRename()

// Heartbeat: every 10s
const heartbeatInterval = setInterval(sendHeartbeat, 10_000)

// Poll: every 1s
const pollInterval = setInterval(() => void pollMessages(), 1_000)

// Plugins: optional capabilities (beads tracking, git commit reporting, etc.)
const pluginCtx: PluginContext = {
  sendMessage,
  hasChief() {
    const threshold = Date.now() - 30_000
    return !!db
      .prepare("SELECT name FROM sessions WHERE role = 'chief' AND heartbeat > ? AND pruned_at IS NULL")
      .get(threshold)
  },
  hasRecentMessage(contentPrefix: string): boolean {
    // Check if any session already sent a message with this prefix in the last 120s (4 poll intervals)
    const since = Date.now() - 120_000
    return !!stmts.hasRecentMessage.get({ $prefix: contentPrefix, $since: since })
  },
  sessionName: currentName,
  sessionId: SESSION_ID,
  claudeSessionId: CLAUDE_SESSION_ID,
  triggerReload(reason: string) {
    logEvent("session.reload", undefined, { name: currentName, reason, auto: true })
    process.stderr.write(`[tribe] auto-reload: ${reason}\n`)
    setTimeout(() => {
      cleanup()
      const args = process.argv.slice(1)
      const child = Bun.spawn([process.execPath, ...args], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: process.env,
      })
      child.exited.then((code) => process.exit(code ?? 0))
    }, 500)
  },
}
const plugins = args["auto-report"] !== false ? [gitPlugin(), beadsPlugin({ beadsDir: BEADS_DIR })] : []
const stopPlugins = loadPlugins(plugins, pluginCtx)

// Cleanup on exit (guard against double-close)
let cleaned = false
function cleanup(): void {
  if (cleaned) return
  cleaned = true
  clearInterval(heartbeatInterval)
  clearInterval(pollInterval)
  stopPlugins()
  try {
    logEvent("session.left", undefined, { name: currentName })
    db.close()
  } catch {
    // DB may already be closed
  }
}

process.on("SIGINT", () => {
  cleanup()
  process.exit(0)
})
process.on("SIGTERM", () => {
  cleanup()
  process.exit(0)
})
process.on("exit", cleanup)

// Connect to Claude Code
await mcp.connect(new StdioServerTransport())
