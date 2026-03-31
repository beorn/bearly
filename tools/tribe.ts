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
import { randomUUID } from "node:crypto"
import {
  parseTribeArgs,
  parseSessionDomains,
  findBeadsDir,
  resolveDbPath,
  detectRole,
  detectName,
  resolveClaudeSessionId,
  resolveClaudeSessionName,
} from "./lib/tribe/config.ts"
import { openDatabase, createStatements } from "./lib/tribe/database.ts"
import { acquireLease } from "./lib/tribe/lease.ts"
import { createTribeContext } from "./lib/tribe/context.ts"
import {
  registerSession,
  resolveTranscriptPath,
  tryInitialRename,
  cleanupOldPrunedSessions,
  cleanupOldData,
  sendHeartbeat,
} from "./lib/tribe/session.ts"
import { logEvent, sendMessage } from "./lib/tribe/messaging.ts"
import { handleToolCall } from "./lib/tribe/handlers.ts"
import { createPoller } from "./lib/tribe/polling.ts"
import { beadsPlugin, gitPlugin, loadPlugins, type PluginContext } from "./lib/tribe/plugins.ts"
import { TOOLS_LIST } from "./lib/tribe/tools-list.ts"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { createLogger } from "loggily"

const log = createLogger("tribe")

// ---------------------------------------------------------------------------
// Source version check — re-exec if code changed since this process started
// ---------------------------------------------------------------------------

function computeSourceHash(): string {
  const dir = dirname(new URL(import.meta.url).pathname)
  const files = [
    resolve(dir, "tribe.ts"),
    ...(() => {
      const libDir = resolve(dir, "lib/tribe")
      if (!existsSync(libDir)) return []
      return readdirSync(libDir)
        .filter((f) => f.endsWith(".ts"))
        .sort()
        .map((f) => resolve(libDir, f))
    })(),
  ]
  const hash = createHash("md5")
  for (const f of files) {
    try {
      hash.update(readFileSync(f))
    } catch {
      /* file missing */
    }
  }
  return hash.digest("hex").slice(0, 12)
}

const SOURCE_HASH = computeSourceHash()

// Check if a prior process stored a different hash — if so, we're stale (Bun cache)
// Uses a simple file marker since the DB isn't open yet
const HASH_FILE = resolve(
  process.env.TRIBE_DB ?? findBeadsDir() ?? resolve(process.env.HOME ?? "~", ".local/share/tribe"),
  ".tribe-source-hash",
)

try {
  const stored = existsSync(HASH_FILE) ? readFileSync(HASH_FILE, "utf8").trim() : ""
  if (stored && stored !== SOURCE_HASH) {
    log.info?.(`source hash changed (${stored} → ${SOURCE_HASH}), re-execing`)
    // Write new hash before re-exec
    Bun.write(HASH_FILE, SOURCE_HASH)
    // Re-exec with fresh Bun compilation
    const child = Bun.spawn([process.execPath, ...process.argv.slice(1)], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE: "0" },
    })
    child.exited.then((code) => process.exit(code ?? 0))
    // Block further execution in this process
    await new Promise(() => {})
  }
  // Write current hash for future processes
  Bun.write(HASH_FILE, SOURCE_HASH)
} catch {
  // Hash check failed — continue anyway, not critical
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const args = parseTribeArgs()
const SESSION_DOMAINS = parseSessionDomains(args)
const SESSION_ID = randomUUID()
const CLAUDE_SESSION_ID = resolveClaudeSessionId()
const CLAUDE_SESSION_NAME = resolveClaudeSessionName()
const BEADS_DIR = findBeadsDir()
const DB_PATH = resolveDbPath(args, BEADS_DIR)

const db = openDatabase(String(DB_PATH))
const SESSION_ROLE = detectRole(db, args)
const SESSION_NAME = detectName(db, SESSION_ROLE, args)
const stmts = createStatements(db)

const ctx = createTribeContext({
  db,
  stmts,
  sessionId: SESSION_ID,
  sessionRole: SESSION_ROLE,
  initialName: SESSION_NAME,
  domains: SESSION_DOMAINS,
  claudeSessionId: CLAUDE_SESSION_ID,
  claudeSessionName: CLAUDE_SESSION_NAME,
})

// Log startup info (visible when DEBUG=tribe is set)
log.info?.(`${ctx.getName()} (${SESSION_ROLE}) joining tribe at ${DB_PATH}`)
log.info?.(`claude_session_id=${CLAUDE_SESSION_ID ?? "none"}`)
if (SESSION_DOMAINS.length > 0) {
  log.info?.(`domains: ${SESSION_DOMAINS.join(", ")}`)
}

// Acquire leadership lease on startup if chief
if (SESSION_ROLE === "chief") {
  const leased = acquireLease(db, SESSION_ID, SESSION_NAME)
  log.info?.(`leader lease: ${leased ? "acquired" : "held by another"}`)
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

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS_LIST }))

let userRenamed = false

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: toolArgs } = req.params
  const a = (toolArgs ?? {}) as Record<string, unknown>
  return handleToolCall(ctx, name, a, {
    cleanup,
    userRenamed,
    setUserRenamed: (v: boolean) => {
      userRenamed = v
    },
  })
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

registerSession(ctx)
cleanupOldPrunedSessions(ctx)
cleanupOldData(ctx)

// One-time: if we have a generic member-N name, try to pick up the /rename slug
const transcriptPath = resolveTranscriptPath(CLAUDE_SESSION_ID)
tryInitialRename(ctx, transcriptPath)

// Heartbeat: every 10s
const heartbeatInterval = setInterval(() => sendHeartbeat(ctx), 10_000)

// Poll: every 1s
const pollMessages = createPoller(ctx, mcp)
const pollInterval = setInterval(() => void pollMessages(), 1_000)

// Data retention cleanup: every 6 hours
const cleanupDataInterval = setInterval(() => cleanupOldData(ctx), 6 * 60 * 60 * 1000)

// Plugins: optional capabilities (beads tracking, git commit reporting, etc.)
const pluginCtx: PluginContext = {
  sendMessage(to: string, content: string, type?: string, beadId?: string) {
    sendMessage(ctx, to, content, type, beadId)
  },
  hasChief() {
    const threshold = Date.now() - 30_000
    return !!db
      .prepare("SELECT name FROM sessions WHERE role = 'chief' AND heartbeat > ? AND pruned_at IS NULL")
      .get(threshold)
  },
  hasRecentMessage(contentPrefix: string): boolean {
    const since = Date.now() - 300_000
    return !!stmts.hasRecentMessage.get({ $prefix: contentPrefix, $since: since })
  },
  claimDedup(key: string): boolean {
    // BEGIN IMMEDIATE forces write lock acquisition before the INSERT,
    // serializing concurrent claims and preventing WAL race conditions
    try {
      db.run("BEGIN IMMEDIATE")
      const result = stmts.claimDedup.run({ $key: key, $session_id: SESSION_ID, $ts: Date.now() })
      db.run("COMMIT")
      return result.changes > 0
    } catch {
      try {
        db.run("ROLLBACK")
      } catch {
        /* already rolled back */
      }
      return false // Lock contention — another session won, skip
    }
  },
  sessionName: ctx.getName(),
  sessionId: SESSION_ID,
  claudeSessionId: CLAUDE_SESSION_ID,
  triggerReload(reason: string) {
    logEvent(ctx, "session.reload", undefined, { name: ctx.getName(), reason, auto: true })
    log.info?.(`auto-reload: ${reason}`)
    setTimeout(() => {
      cleanup()
      const argv = process.argv.slice(1)
      const child = Bun.spawn([process.execPath, ...argv], {
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
  clearInterval(cleanupDataInterval)
  stopPlugins()
  try {
    logEvent(ctx, "session.left", undefined, { name: ctx.getName() })
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
