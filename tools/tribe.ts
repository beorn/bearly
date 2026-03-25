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

// Find .beads/ directory by walking up from cwd
function findBeadsDir(): string {
  let dir = process.cwd()
  while (dir !== "/") {
    const candidate = resolve(dir, ".beads")
    if (existsSync(candidate)) return candidate
    dir = dirname(dir)
  }
  // Fall back to cwd/.beads
  const fallback = resolve(process.cwd(), ".beads")
  mkdirSync(fallback, { recursive: true })
  return fallback
}

const DB_PATH = args.db ?? resolve(findBeadsDir(), "tribe.db")

// Auto-detect role: if no chief exists (or chief is dead), become chief; otherwise member
function detectRole(db: Database): "chief" | "member" {
  if (args.role) return args.role as "chief" | "member"
  const threshold = Date.now() - 30_000
  const liveChief = db.prepare("SELECT name FROM sessions WHERE role = 'chief' AND heartbeat > ?").get(threshold)
  return liveChief ? "member" : "chief"
}

// Auto-generate name: chief gets "chief", members get "member-<N>"
function detectName(db: Database, role: "chief" | "member"): string {
  if (args.name) return String(args.name)
  if (role === "chief") return "chief"
  // Find next available member number
  const existing = db.prepare("SELECT name FROM sessions WHERE name LIKE 'member-%'").all() as Array<{ name: string }>
  const nums = existing.map((r) => parseInt(r.name.replace("member-", ""), 10)).filter((n) => !isNaN(n))
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1
  return `member-${next}`
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
		last_read_ts INTEGER NOT NULL
	)`)

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
		ON CONFLICT(name) DO UPDATE SET
			id = $id, role = $role, domains = $domains,
			pid = $pid, cwd = $cwd, claude_session_id = $claude_session_id,
			claude_session_name = $claude_session_name, started_at = $now, heartbeat = $now, pruned_at = NULL
	`),

  heartbeat: db.prepare("UPDATE sessions SET heartbeat = $now, pruned_at = NULL WHERE id = $id"),

  pollMessages: db.prepare(`
		SELECT * FROM messages
		WHERE ts >= $cursor
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
			ts ASC
	`),

  markRead: db.prepare(
    "INSERT OR IGNORE INTO reads (message_id, session_id, read_at) VALUES ($message_id, $session_id, $now)",
  ),

  getCursor: db.prepare("SELECT last_read_ts FROM cursors WHERE session_id = $session_id"),

  upsertCursor: db.prepare(`
		INSERT INTO cursors (session_id, last_read_ts)
		VALUES ($session_id, $ts)
		ON CONFLICT(session_id) DO UPDATE SET last_read_ts = $ts
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

  checkNameTaken: db.prepare("SELECT id FROM sessions WHERE name = $name AND id != $session_id"),

  insertAlias: db.prepare(`
		INSERT OR REPLACE INTO aliases (old_name, session_id, renamed_at)
		VALUES ($old_name, $session_id, $now)
	`),

  renameSession: db.prepare("UPDATE sessions SET name = $new_name WHERE id = $session_id"),

  pruneSession: db.prepare("UPDATE sessions SET pruned_at = $now WHERE id = $id"),

  updateSessionMeta: db.prepare(`
		UPDATE sessions SET name = $name, role = $role, domains = $domains, heartbeat = $now, pruned_at = NULL
		WHERE id = $id
	`),
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

let currentName = SESSION_NAME

function now(): number {
  return Date.now()
}

function registerSession(): void {
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

  stmts.insertEvent.run({
    $id: randomUUID(),
    $type: "session.joined",
    $session: currentName,
    $bead_id: null,
    $data: JSON.stringify({ name: currentName, role: SESSION_ROLE, domains: SESSION_DOMAINS }),
    $ts: now(),
  })

  // Initialize cursor if needed
  const cursor = stmts.getCursor.get({ $session_id: SESSION_ID }) as { last_read_ts: number } | null
  if (!cursor) {
    stmts.upsertCursor.run({ $session_id: SESSION_ID, $ts: 0 })
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
- Use tribe_health() to check for silent members, stale beads, or conflicts
- Use beads (bd create, bd update, bd close) for persistent task tracking

When a member sends a "status" message, update the relevant bead.
When a member sends a "request" message, check for conflicts before approving.
When a member sends a "query" message, either answer directly or route to the right member.
When a member goes silent (tribe_health shows warning), send a query to check on them.
If a member dies (heartbeat timeout), reassign their beads to another member.`

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
          stmts.pruneSession.run({ $id: r.id, $now: now() })
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
      const allSessions = stmts.allSessions.all() as Array<{
        id: string
        name: string
        role: string
        domains: string
        pid: number
        started_at: number
        heartbeat: number
      }>

      const members = allSessions.map((s) => {
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

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ members, unread, checked_at: new Date().toISOString() }, null, 2),
          },
        ],
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

async function pollMessages(): Promise<void> {
  try {
    const cursor = stmts.getCursor.get({ $session_id: SESSION_ID }) as { last_read_ts: number } | null
    const cursorTs = cursor?.last_read_ts ?? 0

    const rows = stmts.pollMessages.all({
      $cursor: cursorTs,
      $name: currentName,
      $session_id: SESSION_ID,
    }) as Array<{
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

    // Advance cursor to latest timestamp (including our own messages)
    if (rows.length > 0) {
      const maxTs = Math.max(...rows.map((r) => r.ts))
      stmts.upsertCursor.run({ $session_id: SESSION_ID, $ts: maxTs })
    }
  } catch {
    // SQLite busy or other transient error — retry next poll
  }
}

// ---------------------------------------------------------------------------
// Auto-reporter — detects git commits and bead changes, sends to chief
// ---------------------------------------------------------------------------

function startAutoReporter(): () => void {
  let lastHead = ""
  let lastIssuesMtime = 0
  let lastIssuesLineCount = 0
  const issuesPath = resolve(findBeadsDir(), "backup/issues.jsonl")

  // Initialize: capture current state without reporting
  try {
    lastHead = execSync("git rev-parse HEAD", { cwd: process.cwd(), encoding: "utf8" }).trim()
  } catch {
    /* not a git repo */
  }
  try {
    const stat = statSync(issuesPath)
    lastIssuesMtime = stat.mtimeMs
    const content = readFileSync(issuesPath, "utf8")
    lastIssuesLineCount = content.split("\n").filter(Boolean).length
  } catch {
    /* no issues file yet */
  }

  function hasChief(): boolean {
    const threshold = Date.now() - 30_000
    const chief = db
      .prepare("SELECT name FROM sessions WHERE role = 'chief' AND heartbeat > ? AND pruned_at IS NULL")
      .get(threshold)
    return !!chief
  }

  async function checkGit(): Promise<void> {
    if (!hasChief()) return
    try {
      const proc = Bun.spawn(["git", "log", "--oneline", "-1", "HEAD"], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "ignore",
      })
      const out = await new Response(proc.stdout).text()
      const line = out.trim()
      const head = line.split(" ")[0] ?? ""
      if (head && lastHead && head !== lastHead) {
        sendMessage("chief", `Committed: ${line}`, "status")
      }
      if (head) lastHead = head
    } catch {
      /* git error — skip */
    }
  }

  async function checkBeads(): Promise<void> {
    if (!hasChief()) return
    try {
      const stat = statSync(issuesPath)
      if (stat.mtimeMs === lastIssuesMtime) return
      lastIssuesMtime = stat.mtimeMs

      const content = await readFile(issuesPath, "utf8")
      const lines = content.split("\n").filter(Boolean)
      if (lines.length <= lastIssuesLineCount) {
        lastIssuesLineCount = lines.length
        return
      }

      // Process only new lines
      const newLines = lines.slice(lastIssuesLineCount)
      lastIssuesLineCount = lines.length

      for (const line of newLines) {
        try {
          const entry = JSON.parse(line) as { id?: string; title?: string; status?: string; claimed_by?: string }
          if (entry.claimed_by?.includes(currentName) || entry.claimed_by?.includes(SESSION_ID)) {
            sendMessage("chief", `Claimed: ${entry.id} — ${entry.title}`, "status", entry.id)
          } else if (entry.status === "closed") {
            sendMessage("chief", `Closed: ${entry.id} — ${entry.title}`, "status", entry.id)
          }
        } catch {
          /* malformed line */
        }
      }
    } catch {
      /* file missing or read error */
    }
  }

  const interval = setInterval(() => {
    void checkGit()
    void checkBeads()
  }, 30_000)

  process.stderr.write(`[tribe] auto-reporter started (30s polling)\n`)
  return () => clearInterval(interval)
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

registerSession()

// Heartbeat: every 10s
const heartbeatInterval = setInterval(sendHeartbeat, 10_000)

// Poll: every 1s
const pollInterval = setInterval(() => void pollMessages(), 1_000)

// Auto-reporter: detect commits + bead changes and notify chief
const autoReport = args["auto-report"] !== false
let stopAutoReporter: (() => void) | undefined
if (autoReport) {
  stopAutoReporter = startAutoReporter()
}

// Cleanup on exit (guard against double-close)
let cleaned = false
function cleanup(): void {
  if (cleaned) return
  cleaned = true
  clearInterval(heartbeatInterval)
  clearInterval(pollInterval)
  stopAutoReporter?.()
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
