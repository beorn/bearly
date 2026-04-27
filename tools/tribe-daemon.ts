#!/usr/bin/env bun
/**
 * Tribe Daemon — single process per project, sessions connect via Unix socket.
 *
 * Usage:
 *   bun tribe-daemon.ts                    # Auto-discover socket path
 *   bun tribe-daemon.ts --socket /path     # Explicit socket path
 *   bun tribe-daemon.ts --quit-timeout 0   # Quit immediately when last client disconnects
 *   bun tribe-daemon.ts --fd 3             # Inherit socket fd (for hot-reload re-exec)
 */

import { createConnection, createServer, type Socket as NetSocket, type Server } from "node:net"
import { existsSync, unlinkSync, chmodSync, readdirSync, readFileSync, realpathSync, watch } from "node:fs"
import { parseArgs } from "node:util"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { dirname as pathDirname, resolve as pathResolve } from "node:path"
import {
  resolveSocketPath,
  createLineParser,
  makeResponse,
  makeError,
  makeNotification,
  isRequest,
  TRIBE_PROTOCOL_VERSION,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from "./lib/tribe/socket.ts"
import {
  parseTribeArgs,
  parseSessionDomains,
  resolveDbPath,
  detectRole,
  detectName,
  resolveProjectId,
  type TribeRole,
} from "./lib/tribe/config.ts"
import { openDatabase, createStatements } from "./lib/tribe/database.ts"
import { createTribeContext, type TribeContext } from "./lib/tribe/context.ts"
import { handleToolCall, TRIBE_COORD_METHODS } from "./lib/tribe/handlers.ts"
import { logEvent, sendMessage } from "./lib/tribe/messaging.ts"
import { activityFromMessage, writeActivity } from "./lib/tribe/activity-log.ts"
import type { MessageInsertedInfo } from "./lib/tribe/context.ts"
import { cleanupOldData, registerSession } from "./lib/tribe/session.ts"
import type { TribeClientApi } from "./lib/tribe/plugin-api.ts"
import { loadPlugins } from "./lib/tribe/plugin-loader.ts"
import { gitPlugin } from "./lib/tribe/git-plugin.ts"
import { beadsPlugin } from "./lib/tribe/beads-plugin.ts"
import { githubPlugin } from "./lib/tribe/github-plugin.ts"
import { healthMonitorPlugin } from "./lib/tribe/health-monitor-plugin.ts"
import { accountlyPlugin } from "./lib/tribe/accountly-plugin.ts"
import { doltReaperPlugin } from "./lib/tribe/dolt-reaper-plugin.ts"
import { createLogger, addWriter } from "loggily"
import { createTimers } from "./lib/tribe/timers.ts"
import { createLoreHandlers, resolveSummarizerMode, type LoreConnState } from "./lib/tribe/lore-handlers.ts"
import { resolveLoreDbPath } from "../plugins/tribe/lore/lib/config.ts"
import { createCoalescer, type PendingBroadcast } from "./lib/tribe/broadcast-coalescer.ts"

const ac = new AbortController()
const timers = createTimers(ac.signal)

const _log = createLogger("tribe:daemon")
function log(msg: string): void {
  _log.info?.(msg)
}

// Broadcast warn/error log messages to tribe — makes daemon issues visible
// to all sessions without needing DEBUG env. Installed after tribeClientApi is ready.
let broadcastLog: ((msg: string, type: string) => void) | undefined
addWriter((formatted, level) => {
  if ((level === "warn" || level === "error") && broadcastLog) {
    // Strip ANSI codes and trim for clean tribe messages
    const clean = formatted.replace(/\x1b\[[0-9;]*m/g, "").trim()
    if (clean.length > 0) {
      broadcastLog(clean, level === "error" ? "health:daemon:error" : "health:daemon:warn")
    }
  }
})

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const { values: daemonArgs } = parseArgs({
  options: {
    socket: { type: "string" },
    db: { type: "string" },
    fd: { type: "string" },
    // Default 30 minutes — long enough to survive a Claude Code session
    // restart (close terminal, reopen, reconnect), short enough that an
    // idle daemon eventually cleans itself up. The previous 30-second
    // default caused frequent "tribe MCP disconnected" errors when users
    // briefly stepped away — see km-tribe.reliability-sweep-0415.
    // Use --quit-timeout 0 to quit immediately, --quit-timeout -1 to never auto-quit.
    "quit-timeout": { type: "string", default: "1800" },
    foreground: { type: "boolean", default: false },
    // Lore (memory) handler options — see createLoreHandlers. Defaults match
    // the standalone lore daemon so behaviour is unchanged after the merge.
    "lore-db": { type: "string" },
    "focus-poll-ms": { type: "string", default: process.env.TRIBE_FOCUS_POLL_MS ?? "60000" },
    "summary-poll-ms": { type: "string", default: process.env.TRIBE_SUMMARY_POLL_MS ?? "120000" },
    "summarizer-model": { type: "string", default: process.env.TRIBE_SUMMARIZER_MODEL ?? "off" },
    "no-lore": { type: "boolean", default: false },
  },
  strict: false,
})

const SOCKET_PATH = resolveSocketPath(daemonArgs.socket as string | undefined)
const QUIT_TIMEOUT = parseInt(String(daemonArgs["quit-timeout"]), 10)
const INHERIT_FD = daemonArgs.fd ? parseInt(String(daemonArgs.fd), 10) : null

// ---------------------------------------------------------------------------
// Database bootstrap
// ---------------------------------------------------------------------------

const tribeArgs = parseTribeArgs()
// --db from daemon args takes priority over parseTribeArgs
if (daemonArgs.db) tribeArgs.db = daemonArgs.db as string
const DB_PATH = resolveDbPath(tribeArgs)
const db = openDatabase(String(DB_PATH))
const stmts = createStatements(db)

// Daemon always acts as "daemon" role — it doesn't participate as chief/member
const DAEMON_SESSION_ID = randomUUID()
const daemonCtx = createTribeContext({
  db,
  stmts,
  sessionId: DAEMON_SESSION_ID,
  sessionRole: "daemon", // Typed role — never chief-eligible (see isChiefEligible)
  initialName: "daemon",
  domains: [],
  claudeSessionId: null,
  claudeSessionName: null,
  // Fanout hook — installed below once broadcastToConnected is defined.
  // (set via `daemonCtx.onMessageInserted = ...` after the function body.)
})

log(`Starting tribe daemon`)
log(`Socket: ${SOCKET_PATH}`)
log(`DB: ${DB_PATH}`)
log(`PID: ${process.pid}`)

// ---------------------------------------------------------------------------
// Lore handlers — memory/recall RPC surface absorbed from the former standalone
// lore daemon (km-bear.unified-daemon Phase 5a). Opens a second SQLite file
// (lore.db) in the same process; handlers run on the same event loop.
// ---------------------------------------------------------------------------

const LORE_DB_PATH = resolveLoreDbPath(daemonArgs["lore-db"] as string | undefined)
const FOCUS_POLL_MS = Math.max(100, parseInt(String(daemonArgs["focus-poll-ms"]), 10) || 60_000)
const SUMMARY_POLL_MS = Math.max(500, parseInt(String(daemonArgs["summary-poll-ms"]), 10) || 120_000)
const SUMMARIZER_MODE = resolveSummarizerMode(String(daemonArgs["summarizer-model"]))
const LORE_ENABLED = !daemonArgs["no-lore"]

const loreHandlers = LORE_ENABLED
  ? createLoreHandlers({
      dbPath: LORE_DB_PATH,
      socketPath: SOCKET_PATH,
      daemonVersion: "0.10.0",
      focusPollMs: FOCUS_POLL_MS,
      summaryPollMs: SUMMARY_POLL_MS,
      summarizerMode: SUMMARIZER_MODE,
      signal: ac.signal,
    })
  : null

if (loreHandlers) log(`Lore DB: ${LORE_DB_PATH}`)

// ---------------------------------------------------------------------------
// Client registry
// ---------------------------------------------------------------------------

type ClientSession = {
  socket: NetSocket
  id: string
  name: string
  role: TribeRole
  domains: string[]
  project: string
  projectName: string
  projectId: string
  pid: number
  claudeSessionId: string | null
  peerSocket: string | null // Peer socket path for direct proxy-to-proxy connections
  conn: string // Connection path (socket or db)
  ctx: TribeContext
  registeredAt: number
  /** Per-connection lore state — tracks sessionId/claudePid for lore handlers
   *  (set on tribe.hello / tribe.session_register). Kept separate from the
   *  tribe-side sessionId because a single proxy connection may carry both
   *  coordination + memory traffic interleaved. */
  lore: LoreConnState
}

const clients = new Map<string, ClientSession>() // connId → session
const socketToClient = new Map<NetSocket, string>() // socket → connId

// ---------------------------------------------------------------------------
// Chief derivation — derived from connection order unless explicitly claimed.
//
// Plateau model (no leases, no DB state): the chief is the longest-connected
// eligible client. A client can optionally call tribe.claim-chief to pin the
// role to themselves; tribe.release-chief (or disconnecting) unpins and falls
// back to derivation. `daemon`, `watch-*`, and `pending-*` sessions are never
// eligible — they're neutral observers or half-connected.
// ---------------------------------------------------------------------------

import { deriveChiefId, deriveChiefInfo, isChiefEligible } from "./lib/tribe/chief.ts"

let chiefClaim: string | null = null // sessionId of the explicit claimer, if any

function claimChiefFor(sessionId: string, name: string): void {
  chiefClaim = sessionId
  logActivity("chief:claimed", `${name} claimed chief`)
}

function releaseChiefFor(sessionId: string): void {
  if (chiefClaim !== sessionId) return
  chiefClaim = null
  // Find current client name for the release broadcast
  const c = Array.from(clients.values()).find((x) => x.ctx.sessionId === sessionId)
  const who = c?.name ?? "unknown"
  logActivity("chief:released", `${who} released chief`)
}

/** Return ctx.sessionIds of every currently-connected eligible client. */
function getActiveSessionIds(): Set<string> {
  const ids = new Set<string>()
  for (const c of clients.values()) {
    if (!isChiefEligible(c)) continue
    ids.add(c.ctx.sessionId)
  }
  return ids
}

function getActiveSessionInfo() {
  return Array.from(clients.values())
    .filter(isChiefEligible)
    .map((c) => ({
      id: c.ctx.sessionId,
      name: c.name,
      pid: c.pid,
      role: c.role,
      claudeSessionId: c.claudeSessionId,
      registeredAt: c.registeredAt,
    }))
}

/** No-op handler opts for daemon-side tool calls (no MCP session to clean up) */
const DAEMON_HANDLER_OPTS = {
  cleanup: () => {},
  userRenamed: false,
  setUserRenamed: () => {},
  getChiefId: () => deriveChiefId(clients.values(), chiefClaim),
  getChiefInfo: () => deriveChiefInfo(clients.values(), chiefClaim),
  claimChief: claimChiefFor,
  releaseChief: releaseChiefFor,
  getActiveSessionIds,
  getActiveSessionInfo,
  getDebugState: () => ({
    clients: Array.from(clients.values()).map((c) => ({
      id: c.ctx.sessionId,
      name: c.name,
      role: c.role,
      pid: c.pid,
      registeredAt: c.registeredAt,
    })),
    chief: deriveChiefInfo(clients.values(), chiefClaim),
    chiefClaim,
    cursors: db.prepare("SELECT id, name, last_delivered_ts, last_delivered_seq FROM sessions").all() as Array<{
      id: string
      name: string
      last_delivered_ts: number | null
      last_delivered_seq: number | null
    }>,
  }),
} as const

function broadcastNotification(method: string, params?: Record<string, unknown>, exclude?: string): void {
  const msg = makeNotification(method, params)
  for (const [connId, client] of clients) {
    if (connId === exclude) continue
    try {
      client.socket.write(msg)
    } catch {
      // Client dead — will be cleaned up on disconnect
    }
  }
}

// ---------------------------------------------------------------------------
// Injection-shape scrubber
// ---------------------------------------------------------------------------
// Prevents Claude Code models from pattern-completing transcript-shaped tokens
// in broadcast content. Two layers:
//   (1) Always-on regex scrub — strips role markers, angle-bracket tags, and
//       known trigger phrases from content before delivery. Deterministic,
//       zero-cost, zero-latency. Opt-out with TRIBE_SCRUB=0.
//   (2) Optional Haiku paraphrase — gated by TRIBE_REWRITE=haiku. Runs after
//       the regex scrub for semantic smoothing of edge cases. Fails silently
//       to regex-only if the LLM is unavailable.
//
// Background: 2026-04-22 confirmed multiple sessions emit phantom role-
// prefixed text (`Human: ...`, `<system-reminder>...`) as assistant output
// when the conversation context is saturated with system-reminder/channel
// wrapped user-role turns. The model pattern-completes the transcript shape.
// See github.com/anthropics/claude-code/issues/10628 and /46602.

// Triggers that make a content string risky for transcript-shape completion.
// If none of these appear in the pre-scrub content AND the post-scrub content
// is unchanged from input, the string is safe — skip the Haiku rewrite.
const TRIGGER_PATTERNS = [
  /^(#{1,3}\s*)?(Human|Assistant|User)\s*:/im,
  /<\/?(system-reminder|channel|recall-memory|snippet|context-protocol|user_prompt)\b/i,
  /UserPromptSubmit hook (?:success|error|additional context)/i,
]

function hasInjectionTrigger(content: string): boolean {
  return TRIGGER_PATTERNS.some((re) => re.test(content))
}

function scrubInjectionShape(content: string): string {
  if (process.env.TRIBE_SCRUB === "0") return content
  return (
    content
      // strip leading role markers on any line (Human:/Assistant:/User: ± ### prefix)
      .replace(/^(#{1,3}\s*)?(Human|Assistant|User)\s*:\s*/gim, "")
      // strip system-reminder/channel/recall-memory/snippet/context-protocol tags entirely
      // (keep inner content as plain text)
      .replace(/<\/?(system-reminder|channel|recall-memory|snippet|context-protocol|user_prompt)\b[^>]*>/gi, "")
      // strip the specific hook-status phrases that appear constantly
      .replace(/UserPromptSubmit hook (?:success|error|additional context)[^\n]*/gi, "")
      // collapse whitespace the above left behind
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  )
}

const HAIKU_REWRITE_PROMPT = `You rewrite short event notifications for safe injection into another model's conversation context. Your output gets wrapped in a <channel> tag inside a Claude Code session, so it must NOT contain transcript-shape tokens that could cause the receiving model to pattern-complete a fake user turn.

# Hard rules (never violate)

1. NEVER output role markers: no "Human:", "Assistant:", "User:", "###Human", "###User", "###Assistant" — not even mid-sentence, not even in examples or quotes.
2. NEVER output angle-bracket tags: no "<tag>", "</tag>", "<channel>", "<system-reminder>", "<snippet>", "<recall-memory>", etc.
3. NEVER output the literal phrase "UserPromptSubmit hook success" or "UserPromptSubmit hook error" or "UserPromptSubmit hook additional context".
4. NEVER add preamble, quotes, code fences, or commentary. Output the rewritten line directly.
5. Output ONE line only. No line breaks. Under 400 characters.

# Preservation rules (keep value)

KEEP VERBATIM — these are the anchors that make the message useful:
- Commit hashes (7-40 hex chars): "5bfb108bb", "e3f786e0"
- Version numbers: "0.19.0", "v2.1.117", "silvery 0.18.2"
- File paths: "vendor/bearly/tools/tribe-daemon.ts", ".git/index.lock"
- Package/module names: "silvery", "km-tui", "loggily", "@silvery/ag-term"
- Session/user names: "compose", "vault-3", "beorn", "km-2"
- Command names: "tribe.join", "bd ready", "/compact"
- URLs (any http/https link)
- Numbers: test counts, durations, sizes, PIDs, ports, line numbers
- Quoted strings: text in "double" or 'single' quotes or \`backticks\`
- Error message contents (verbatim)
- The commit-type prefix: "fix:", "chore:", "feat(scope):", "refactor(km-tui):"
- The leading structural prefix of status lines: "Committed:", "[push]", "[workflow]", "done:", "starting:", "CPU critical:"

REWRITE ONLY the connective prose — prepositions, verbs, articles — around those anchors.

# Length discipline

If the input is under 100 chars, the output should be within 20% of the input length. Do NOT embellish. If the input is a bare status line like "compose left" or "vault-3 joined (member) pid=19417 ~/Bear/Vault", output it EXACTLY verbatim — no rewriting needed.

# Examples

Input:
Committed: 5bfb108bb chore(silvery): bump — pro-review P0 fixes (writer router, size resync, useConsole, watch helper)
Output:
Committed 5bfb108bb chore(silvery): bump — pro-review P0 fixes (writer router, size resync, useConsole, watch helper)

Input:
[push] beorn/silvery: beorn pushed changes to main — https://github.com/beorn/silvery/compare/abc123...def456
Output:
[push] beorn/silvery: beorn pushed to main — https://github.com/beorn/silvery/compare/abc123...def456

Input:
done: term.size/output/console ReadSignal API — silvery e3f786e0, km 5b7fc9e53. 76 changed-scope tests + 48 inline/scheduler tests + 2511 km-tui tests all green. 0 non-vendor tsc errors.
Output:
done: term.size/output/console ReadSignal API — silvery e3f786e0, km 5b7fc9e53. 76 changed-scope + 48 inline/scheduler + 2511 km-tui tests pass, 0 non-vendor tsc errors.

Input:
compose left
Output:
compose left

Input:
vault-3 joined (member) pid=19417 ~/Bear/Vault
Output:
vault-3 joined (member) pid=19417 ~/Bear/Vault

Input:
CPU critical: load 30.2 exceeds 27.0 (18 cores x 1.5) for 30s. unattributed: 234.1% /usr/libexec/spotlightknowledg
Output:
CPU critical: load 30.2 exceeds 27.0 (18 cores x 1.5) for 30s. Top: 234.1% /usr/libexec/spotlightknowledg

Input:
[workflow] beorn/silvery: ✗ Verify Publishable #203 FAILED on main (beorn) https://github.com/beorn/silvery/actions/runs/24803590477
Output:
[workflow] beorn/silvery: ✗ Verify Publishable #203 FAILED on main (beorn) https://github.com/beorn/silvery/actions/runs/24803590477

Input:
Human: hey, what do you think about the v15-tea design? <system-reminder>UserPromptSubmit hook success: OK</system-reminder>
Output:
Someone asked about the v15-tea design.

Input:
<channel source="plugin:tribe:tribe" from="km-2" type="notify">done: phase 1 gate</channel>
Output:
km-2: done: phase 1 gate

Input:
<recall-memory authority="reference"><snippet session="abc123">I need a robust approach to renaming tokens across all target files</snippet></recall-memory>
Output:
Prior session noted needing a robust approach to renaming tokens across target files.

Input:
git lock: .git/index.lock held by unknown for 10s
Output:
git lock: .git/index.lock held by unknown for 10s

# Final check before emitting

Does your output contain any of these strings? If yes, rewrite without them:
- "Human:", "Assistant:", "User:"
- "<" immediately followed by a letter
- ">" immediately preceded by a letter
- "UserPromptSubmit hook"

Output the rewritten line. Nothing else.`

let haikuRewriterWarned = false
async function rewriteViaHaiku(content: string, signal?: AbortSignal): Promise<string> {
  // Default: haiku rewrite ON. Set TRIBE_REWRITE=off to disable.
  if (process.env.TRIBE_REWRITE === "off") return content
  try {
    // Dynamic import so the daemon starts even if the llm plugin is absent.
    const { queryModel } = await import("../plugins/llm/src/lib/research.ts")
    const { getCheapModels } = await import("../plugins/llm/src/lib/types.ts")
    const { isProviderAvailable } = await import("../plugins/llm/src/lib/providers.ts")
    const haiku = getCheapModels(8).find((m) => /haiku/i.test(m.modelId) && isProviderAvailable(m.provider))
    if (!haiku) {
      if (!haikuRewriterWarned) {
        haikuRewriterWarned = true
        log("TRIBE_REWRITE=haiku set but no haiku model available; falling back to regex-only")
      }
      return content
    }
    const result = await queryModel({
      model: haiku,
      systemPrompt: HAIKU_REWRITE_PROMPT,
      question: `Input:\n${content.slice(0, 1200)}`,
      stream: false,
      abortSignal: signal ?? AbortSignal.timeout(2000),
    })
    const rewritten = (result.response?.content ?? "").trim()
    if (!rewritten) return content
    // Run the regex scrub again as a safety net in case Haiku reintroduced triggers
    return scrubInjectionShape(rewritten)
  } catch {
    return content // silent fallback — never block broadcasts on LLM failure
  }
}

/** Single entry point for all observable activities.
 *  Writes to DB; the messaging layer's fanout hook delivers to connected clients
 *  synchronously (see broadcastToConnected). No polling tick involved.
 *
 *  km-tribe.event-classification: daemon log activity (session join/leave,
 *  rename, status) is ambient — the channel marker already tags these as
 *  notification-only, but routing them to inbox-only spares the channel
 *  entirely. Critical: a session-join/leave today still needs to wake the
 *  proxy (auto-rename hook) — the proxy now reads via tribe.inbox cursor.
 */
function logActivity(type: string, content: string): void {
  sendMessage(daemonCtx, "*", content, type, undefined, undefined, "broadcast", {
    delivery: "pull",
    responseExpected: "no",
    pluginKind: `daemon:${type}`,
  })
}

function pushToClient(connId: string, method: string, params?: Record<string, unknown>): void {
  const client = clients.get(connId)
  if (!client) return
  try {
    client.socket.write(makeNotification(method, params))
  } catch {
    // Dead client
  }
}

/**
 * Persist `sessions.last_delivered_{ts,seq}` for a recipient session. Called
 * after a successful socket write so the cursor survives daemon restart
 * (km-tribe.message-durability). Idempotent — the statement is an unconditional
 * UPDATE keyed by session id; SQLite is a no-op when the row is absent (which
 * happens for the daemon's own pseudo-session and for watch-*).
 */
function persistDeliveredCursor(sessionId: string, ts: number, seq: number): void {
  try {
    stmts.updateLastDelivered.run({ $id: sessionId, $ts: ts, $seq: seq })
  } catch {
    /* best effort — session row may not exist yet (daemon-self, watch-*) */
  }
}

/**
 * Synchronous fanout — called from the messaging layer the instant a message
 * row is committed. Replaces the former 1s polling push (km-tribe.event-bus).
 *
 * Delivery rules (mirror the old pushNewMessages SQL):
 *   - `watch-*` sessions see every message *except* their own.
 *   - Regular sessions see messages whose recipient matches their name or '*',
 *     minus their own.
 *
 * Each successful `socket.write` advances the recipient's persisted cursor so
 * a subsequent daemon restart doesn't re-push (Test E) and so a disconnected
 * session can pick up from where we stopped (Test F).
 */
// ---------------------------------------------------------------------------
// Broadcast coalescing (km-tribe.compact-channel-broadcasts)
//
// Multiple broadcast-kind events to the same client within a short window are
// merged into ONE MCP notification with combined content. This cuts the
// receiver's context-saturation from `<channel>` tag sprawl (each raw tag
// looks to the model like a transcript fragment under heavy activity, which
// amplifies role-prefix hallucination). Direct messages are not batched —
// they're time-sensitive.
//
// Window: TRIBE_BROADCAST_BATCH_MS (default 400, 0 = disabled).
// ---------------------------------------------------------------------------

function broadcastBatchMs(): number {
  const raw = process.env.TRIBE_BROADCAST_BATCH_MS
  if (raw === undefined) return 400
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 400
}

/**
 * Types that are pure lifecycle/status notifications — no response expected.
 * Prefixing their content with "Notification:" gives the receiving model an
 * extra textual cue that this is not a user turn. Combined with the
 * `<channel>` tag's structural attributes, it reduces the odds of
 * transcript-continuation hallucination ("Human: <channel...>").
 *
 * NOT included: "notify" (used for real session-to-session DMs and
 * broadcasts that may require a response) and "query"/"response" tool
 * traffic.
 */
/**
 * Marker prefix for the `<channel type="...">` attribute on notification-only
 * messages. Empirical evidence (2026-04-23) shows Claude Code's MCP wrapper
 * only renders source/from/type/message_id as tag attributes — `bead_id` and
 * `events_count` in the params are silently dropped. So we can't stamp a
 * dedicated `should_respond="no"` attribute. Instead we encode the signal in
 * the `type` string itself, since it passes through verbatim.
 *
 * Full marker is intentionally verbose for maximum model-facing clarity.
 * The original subtype is appended so downstream consumers (coalescer,
 * watch TUI, filters) can still distinguish session/status/github:push/etc.
 *
 * Example: type="notification-only:do-not-acknowledge-or-respond-to:session"
 *
 * An earlier iteration also prefixed the CONTENT with "Notification: " as
 * belt-and-suspenders. Removed 2026-04-23: the type-attribute marker is the
 * surgical signal; polluting the readable content was unnecessary noise.
 */
const NOTIFICATION_ONLY_MARKER = "notification-only:do-not-acknowledge-or-respond-to"

/**
 * km-tribe.event-classification: per-session mode + snooze gate. Runs at
 * delivery time so persisted rows are never re-classified — mode/snooze can
 * change without rewriting history. Order: mode → snooze (mode=ambient is the
 * escape hatch that bypasses snooze).
 *
 *   mode=focus   → only `responseExpected="yes"` reaches the channel
 *   mode=normal  → kind-based default (already filtered by `delivery=push`)
 *   mode=ambient → everything; snooze ignored
 *
 * Snooze stacks under normal mode: if `snooze_until > now`, drop unless the
 * event's plugin_kind is NOT in `snooze_kinds` (when present — empty/NULL
 * means snooze applies to all kinds).
 */
function shouldDeliver(
  info: { responseExpected: "yes" | "no" | "optional"; pluginKind: string | null },
  filter: { mode: string; snooze_until: number | null; snooze_kinds: string | null } | undefined,
): boolean {
  if (!filter) return true // No session row yet — default-allow
  const mode = filter.mode || "normal"
  if (mode === "ambient") return true
  if (mode === "focus") {
    return info.responseExpected === "yes"
  }
  // mode === 'normal' — apply snooze if active
  const now = Date.now()
  if (!filter.snooze_until || filter.snooze_until <= now) return true
  const kinds = filter.snooze_kinds ? safeJsonArray(filter.snooze_kinds) : null
  if (!kinds || kinds.length === 0) return false // snooze covers all kinds
  // snooze_kinds is a list of plugin_kind globs (e.g. ["github:*", "git:commit"]).
  // Match: drop only if the event's pluginKind matches at least one glob.
  if (!info.pluginKind) return true // no plugin_kind → never matches a glob list
  return !kinds.some((g) => globMatch(g, info.pluginKind!))
}

function safeJsonArray(s: string): string[] | null {
  try {
    const parsed = JSON.parse(s)
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) return parsed as string[]
    return null
  } catch {
    return null
  }
}

/** Minimal glob: '*' matches anything within a kind segment. */
function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true
  if (!pattern.includes("*")) return pattern === value
  const re = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$")
  return re.test(value)
}

function isNotificationOnlyType(type: string): boolean {
  if (type === "session" || type === "status" || type === "delta") return true
  if (type.startsWith("chief:")) return true
  if (type.startsWith("github:")) return true
  return false
}

function markedType(type: string): string {
  return isNotificationOnlyType(type) ? `${NOTIFICATION_ONLY_MARKER}:${type}` : type
}

function singleEventNotification(ev: PendingBroadcast): string {
  return makeNotification("channel", {
    from: ev.sender,
    type: markedType(ev.type),
    content: ev.content,
    bead_id: ev.bead_id,
    message_id: ev.id,
    // km-tribe.event-classification: surfaced on every channel envelope so the
    // receiving LLM can decide whether to reply at all. The MCP wrapper only
    // renders source/from/type/message_id by default; clients that want this
    // attribute pull it from `params.responseExpected` directly.
    responseExpected: ev.responseExpected,
    plugin_kind: ev.pluginKind,
  })
}

function batchedNotification(events: PendingBroadcast[], dropped: number): string {
  const lines = events.map((e) => `[${e.sender}] ${e.type}: ${e.content.replace(/\n/g, " ")}`)
  if (dropped > 0) lines.push(`(+${dropped} more events truncated)`)
  const total = events.length + dropped
  const header = `${total} tribe event${total === 1 ? "" : "s"}`
  const content = `${header}\n${lines.join("\n")}`
  const last = events[events.length - 1]
  // For a coalesced batch, the per-event responseExpected can vary. The
  // safest aggregation is the strongest signal: if any event in the batch
  // expected a reply ("yes"), the batch envelope says "yes"; otherwise
  // fall back to "optional" (avoids pretending an entire batch is "no").
  const aggResp: "yes" | "optional" = events.some((e) => e.responseExpected === "yes") ? "yes" : "optional"
  return makeNotification("channel", {
    from: "daemon",
    type: markedType("delta"),
    content,
    bead_id: null,
    message_id: last?.id ?? null,
    events_count: total,
    responseExpected: aggResp,
    plugin_kind: null,
  })
}

const broadcastCoalescer = createCoalescer({
  batchMs: broadcastBatchMs(),
  maxEventsPerBatch: 50,
  deps: {
    singleEvent: singleEventNotification,
    batched: batchedNotification,
    write(connId, payload) {
      const client = clients.get(connId)
      if (!client) return false
      try {
        client.socket.write(payload)
        return true
      } catch {
        return false
      }
    },
    onDelivered(connId, ev) {
      const client = clients.get(connId)
      if (!client) return
      persistDeliveredCursor(client.ctx.sessionId, ev.ts, ev.rowid)
    },
  },
})

async function broadcastToConnected(info: {
  id: string
  ts: number
  rowid: number
  type: string
  kind: "direct" | "broadcast" | "event"
  sender: string
  recipient: string
  content: string
  bead_id: string | null
  delivery: "push" | "pull"
  responseExpected: "yes" | "no" | "optional"
  pluginKind: string | null
  roomId: string | null
}): Promise<void> {
  // Journal-only rows (kind='event') stay durable in SQLite but are never
  // delivered to any connected client. This replaced the former
  // `recipient='log'` string sentinel (km-tribe.polish-sweep item 3).
  if (info.kind === "event") return

  // km-tribe.event-classification: 'pull' rows are inbox-only — they land in
  // SQLite (durable for tribe.inbox) but never get fanned out. Order matters:
  // delivery filter runs BEFORE expensive Haiku rewrite so ambient bulk doesn't
  // pay the LLM bill.
  if (info.delivery === "pull") return

  // Neutralize transcript-shaped triggers so receiving models don't
  // pattern-complete a fake user turn. Regex layer is synchronous + always on
  // (opt-out: TRIBE_SCRUB=0). Haiku paraphrase layer defaults on (opt-out:
  // TRIBE_REWRITE=off); falls back silently to regex-only if no haiku provider
  // is available.
  //
  // Skip Haiku entirely if the original content has no trigger patterns AND
  // the regex scrub was a no-op — short structured messages like "compose left"
  // or "Committed: <hash> <subject>" don't need paraphrasing and Haiku tends
  // to introduce semantic drift on them (e.g. "compose" → "compose operation").
  const hadTrigger = hasInjectionTrigger(info.content)
  let cleaned = scrubInjectionShape(info.content)
  if (hadTrigger || cleaned !== info.content) {
    cleaned = await rewriteViaHaiku(cleaned)
  }

  const pending: PendingBroadcast = {
    id: info.id,
    ts: info.ts,
    rowid: info.rowid,
    type: info.type,
    sender: info.sender,
    content: cleaned,
    bead_id: info.bead_id,
    responseExpected: info.responseExpected,
    pluginKind: info.pluginKind,
  }

  for (const [connId, client] of clients) {
    // Don't echo a message back to its own sender.
    if (client.name === info.sender) continue
    const isWatch = client.role === "watch"
    if (!isWatch) {
      if (info.recipient !== "*" && info.recipient !== client.name) continue
    }
    // Skip half-registered clients (role=pending placeholder).
    if (client.role === "pending") continue

    // km-tribe.event-classification: per-session mode + snooze filter.
    // Direct messages always bypass these — they're addressed to this session
    // explicitly and the sender already paid the actionable cost.
    if (info.kind !== "direct" && !isWatch) {
      const sessionFilter = stmts.getSessionMode.get({ $id: client.ctx.sessionId }) as
        | { mode: string; snooze_until: number | null; snooze_kinds: string | null }
        | undefined
      if (!shouldDeliver(info, sessionFilter)) continue
    }

    // Direct messages bypass coalescing — they're time-sensitive.
    if (info.kind === "direct") {
      try {
        client.socket.write(singleEventNotification(pending))
        persistDeliveredCursor(client.ctx.sessionId, info.ts, info.rowid)
      } catch {
        // Dead client — cleanup happens on socket close.
      }
      continue
    }

    // Broadcast — per-client coalescing (may write immediately if batchMs=0).
    broadcastCoalescer.enqueue(connId, pending)
  }
}

// Tap: every inserted message flows through `messageTap` — first to the
// activity log (best-effort observability), then to fanout. See
// lib/tribe/activity-log.ts. Tests disable with TRIBE_ACTIVITY_LOG=off.
const messageTap = (info: MessageInsertedInfo): void => {
  writeActivity(activityFromMessage(info))
  // Fire-and-forget: broadcastToConnected is async (Haiku rewrite path is
  // awaited inside). Swallow rejections so a flaky LLM can't kill the tap.
  void broadcastToConnected(info).catch(() => {})
}

// Install tap on the daemon's own ctx — logActivity() and the health-monitor
// / plugin writers all flow through daemonCtx.
daemonCtx.onMessageInserted = messageTap

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make a path relative to cwd */
function relPath(p: string): string {
  const cwd = process.cwd()
  return p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p
}

/** Generate a unique member-<pid> name, with random suffix if taken */
function generateMemberName(pid: number, connId: string): string {
  const pidName = `member-${pid || connId.slice(0, 6)}`
  const taken = db.prepare("SELECT id FROM sessions WHERE name = ?").get(pidName)
  return taken ? `member-${pid}-${Math.random().toString(36).slice(2, 5)}` : pidName
}

/** Deduplicate name against connected clients */
function deduplicateName(name: string): string {
  const connectedNames = new Set(Array.from(clients.values()).map((c) => c.name))
  if (!connectedNames.has(name)) return name
  const base = name
  let suffix = 2
  while (connectedNames.has(`${base}-${suffix}`)) suffix++
  return `${base}-${suffix}`
}

// ---------------------------------------------------------------------------
// Register handler — composed from small, locally-scoped helpers so the
// top-level `case "register":` body stays readable. Each helper takes only
// the dependencies it needs and returns a plain value; no side effects on
// globals except where explicitly labelled.
// ---------------------------------------------------------------------------

type PriorSession = { id: string; name: string; role: string }

/**
 * If the proxy supplied an identity token matching a prior, currently-
 * disconnected row, return that row so the caller can adopt its sessionId +
 * name + role. Returns null when there's no match or the prior session is
 * still actively connected. See km-tribe.session-identity.
 */
function adoptIdentity(identityToken: string | null, isActive: (sessionId: string) => boolean): PriorSession | null {
  if (!identityToken) return null
  const prior = db
    .prepare("SELECT id, name, role FROM sessions WHERE identity_token = ? ORDER BY updated_at DESC LIMIT 1")
    .get(identityToken) as PriorSession | null
  if (!prior) return null
  if (isActive(prior.id)) return null
  return prior
}

/**
 * True if a session name looks auto-generated (daemon fallback) and should
 * NOT be adopted by later sessions. Covers: `member-<digits>`, `km-<digits>`,
 * `member-<short>` (short rand hash), `chief`, any tombstoned dead row
 * (`*-dead-<8hex>`), and generic project-name fallbacks.
 *
 * Recognised non-auto names: user-chosen slugs like "plateau", "tea-wiring",
 * "backdrop" etc. — those get adopted by F1-D.
 */
function isAutoGeneratedName(name: string): boolean {
  if (!name) return true
  if (name === "chief") return true
  if (name.includes("-dead-")) return true
  if (/^member-[\w\d]{3,}$/.test(name)) return true
  if (/^km-?\d+$/.test(name)) return true
  if (/^km-[a-z0-9]{3,4}$/.test(name)) return true // km-7y5, km-5l5 auto-suffixed
  if (/^agent-[a-f0-9]+$/.test(name)) return true
  if (/^user-[\w\d]+$/.test(name)) return true
  return false
}

/**
 * F1-D — find a prior, non-active session at the same project_id + role
 * whose name is user-chosen (not auto-generated). Returns the most-recent
 * match, or null. Enables automatic resume of a user's named session across
 * Claude Code invocations at the same project root.
 *
 * `project_id` is already a realpath-normalised sha256 prefix (see
 * `resolveProjectId()`), so symlink/mount-path quirks are handled upstream.
 * See km-bearly.tribe-session-resume.
 */
function adoptByProjectAndRole(
  projectId: string | null,
  role: TribeRole,
  isActive: (sessionId: string) => boolean,
): PriorSession | null {
  if (!projectId) return null

  const candidates = db
    .prepare("SELECT id, name, role FROM sessions WHERE project_id = ? AND role = ? ORDER BY updated_at DESC LIMIT 50")
    .all(projectId, role) as PriorSession[]

  for (const c of candidates) {
    if (isActive(c.id)) continue
    if (isAutoGeneratedName(c.name)) continue
    return { id: c.id, name: c.name, role: c.role }
  }
  return null
}

/**
 * Resolve the session name from (in order):
 *   1. Explicit `p.name`
 *   2. Claude session name (CLAUDE_SESSION_NAME env)
 *   3. identity_token-adopted name
 *   4. Prior row keyed by claude_session_id (non-auto names only)
 *   5. **F1-D** — non-active session at same realpath(cwd)+role with a
 *      user-chosen name (e.g. "plateau" reclaimed on clean shutdown+resume)
 *   6. Role/project fallback (`chief` or project dir name)
 */
function resolveName(
  p: Record<string, unknown>,
  adopted: PriorSession | null,
  claudeSessionName: string | null,
  claudeSessionId: string | null,
  role: TribeRole,
  isActive: (sessionId: string) => boolean,
  projectId: string | null,
): string {
  if (p.name) return String(p.name)
  if (claudeSessionName) return claudeSessionName
  if (adopted?.name) return adopted.name

  // Recover from a prior row with the same Claude session ID. Skip
  // auto-generated names (useless to reuse) and role=pending/watch leftovers
  // (they'd route poorly on reconnect).
  const prev = claudeSessionId
    ? (db
        .prepare("SELECT name, role FROM sessions WHERE claude_session_id = ? ORDER BY updated_at DESC LIMIT 1")
        .get(claudeSessionId) as { name: string; role: string } | null)
    : null
  if (prev && !isAutoGeneratedName(prev.name) && prev.role !== "pending" && prev.role !== "watch") {
    return prev.name
  }

  // F1-D — project+role adoption (cross-Claude-session resume at same project).
  const projectAdopted = adoptByProjectAndRole(projectId, role, isActive)
  if (projectAdopted) return projectAdopted.name

  const projectName = String(
    p.projectName ??
      String(p.project ?? process.cwd())
        .split("/")
        .pop() ??
      "unknown",
  )
  return role === "chief" ? "chief" : projectName
}

/**
 * Apply a newly-registered client to the daemon's in-memory state: builds
 * the ClientSession, replaces the placeholder entry, and flags the daemon
 * as active. Returns the installed client record.
 */
function applyClient(
  connId: string,
  fields: {
    name: string
    role: TribeRole
    domains: string[]
    project: string
    projectName: string
    projectId: string
    pid: number
    claudeSessionId: string | null
    peerSocket: string | null
    ctx: TribeContext
  },
): ClientSession {
  const existing = clients.get(connId)!
  const client: ClientSession = {
    socket: existing.socket,
    id: connId,
    name: fields.name,
    role: fields.role,
    domains: fields.domains,
    project: fields.project,
    projectName: fields.projectName,
    projectId: fields.projectId,
    pid: fields.pid,
    claudeSessionId: fields.claudeSessionId,
    peerSocket: fields.peerSocket,
    conn: relPath(SOCKET_PATH),
    ctx: fields.ctx,
    registeredAt: Date.now(),
    // Preserve any lore state already set on the placeholder (tribe.hello
    // can arrive before register on the lore wire path).
    lore: existing.lore,
  }
  clients.set(connId, client)
  markActive()
  return client
}

/**
 * Advance the durability cursor and, for adopted identities, replay any
 * messages written after the persisted cursor. Brand-new sessions skip to
 * the current MAX(rowid) so a fresh join doesn't receive the entire project
 * history. See km-tribe.message-durability.
 */
function replayOrBootstrap(connId: string, client: ClientSession, adopted: PriorSession | null): void {
  const priorCursor = stmts.getLastDelivered.get({ $id: client.ctx.sessionId }) as {
    last_delivered_ts: number | null
    last_delivered_seq: number | null
  } | null

  if (adopted) {
    // Drain the backlog in pages of PAGE_SIZE — keep fetching until we reach
    // the current journal tip. The former single `LIMIT 200` query silently
    // truncated any backlog larger than 200, and because the durable cursor
    // only advanced as each delivered row was pushed, a subsequent live
    // fanout would jump the cursor past the undelivered middle — permanent
    // loss (km-tribe.delivery-correctness P0.5 + P1.7).
    //
    // This runs synchronously inside the register handler, so no fanout can
    // interleave: bun's event loop can't process another socket `data` or
    // `close` callback until we return.
    const PAGE_SIZE = 200
    let sinceSeq = priorCursor?.last_delivered_seq ?? 0
    // Watch sessions see everything; regular sessions see their name + broadcasts.
    const isWatch = client.role === "watch"
    const replayQuery = isWatch
      ? `SELECT rowid, id, type, sender, recipient, content, bead_id, ts FROM messages WHERE rowid > ? AND sender != ? ORDER BY rowid ASC LIMIT ${PAGE_SIZE}`
      : `SELECT rowid, id, type, sender, recipient, content, bead_id, ts FROM messages WHERE rowid > ? AND (recipient = ? OR recipient = '*') AND sender != ? ORDER BY rowid ASC LIMIT ${PAGE_SIZE}`
    const stmt = db.prepare(replayQuery)
    for (;;) {
      const replayParams = isWatch ? [sinceSeq, client.name] : [sinceSeq, client.name, client.name]
      const page = stmt.all(...replayParams) as Array<{
        rowid: number
        id: string
        type: string
        sender: string
        recipient: string
        content: string
        bead_id: string | null
        ts: number
      }>
      if (page.length === 0) break
      for (const msg of page) {
        pushToClient(connId, "channel", {
          from: msg.sender,
          type: msg.type,
          content: msg.content,
          bead_id: msg.bead_id,
          message_id: msg.id,
        })
        persistDeliveredCursor(client.ctx.sessionId, msg.ts, msg.rowid)
        sinceSeq = msg.rowid
      }
      if (page.length < PAGE_SIZE) break
    }
    return
  }

  // Brand-new session — skip to current latest so the backlog isn't replayed.
  const latest = db.prepare("SELECT MAX(rowid) as max_seq FROM messages").get() as {
    max_seq: number | null
  } | null
  const bootstrapSeq = latest?.max_seq ?? 0
  persistDeliveredCursor(client.ctx.sessionId, Date.now(), bootstrapSeq)
}

/**
 * Emit the "X joined" broadcast unless we're inside the post-start suppress
 * window (hot-reload reconnection burst). Also tags sub-agent joins with
 * their parent session name when another connection shares the same
 * Claude session id.
 */
function announceJoin(client: ClientSession): void {
  if (Date.now() - startedAt <= SUPPRESS_WINDOW_MS) return

  let parentName: string | null = null
  if (client.claudeSessionId) {
    for (const [cid, c] of clients) {
      if (cid !== client.id && c.claudeSessionId === client.claudeSessionId) {
        parentName = c.name
        break
      }
    }
  }
  const shortProject = client.project.replace(process.env.HOME ?? "", "~")
  const suffix = parentName ? ` (sub-agent of ${parentName})` : ""
  logActivity("session", `${client.name} joined (${client.role}) pid=${client.pid} ${shortProject}${suffix}`)
}

// ---------------------------------------------------------------------------
// JSON-RPC handler
// ---------------------------------------------------------------------------

async function handleRequest(req: JsonRpcRequest, connId: string): Promise<string> {
  const { method, params, id } = req
  const p = (params ?? {}) as Record<string, unknown>

  try {
    switch (method) {
      case "register": {
        const claudeSessionName = (p.claudeSessionName as string) ?? null
        const claudeSessionId = (p.claudeSessionId as string) ?? null
        const identityToken = (p.identityToken as string) ?? null

        let role = detectRole(db, { role: p.role as string | undefined })
        // Clients cannot register themselves as "daemon" or "pending" — both are
        // daemon-internal roles. Downgrade to "member" so a confused client
        // still gets a usable (but non-privileged) session.
        if (role === "daemon" || role === "pending") role = "member"

        const isActive = (sid: string): boolean => Array.from(clients.values()).some((c) => c.ctx.sessionId === sid)

        const adopted = adoptIdentity(identityToken, isActive)

        // Adopt role from prior session if caller didn't supply one explicitly.
        // Guard against stored rows with stale/unexpected role values — an
        // invalid or daemon-internal role ("daemon"/"pending") falls back to
        // the auto-detected role.
        if (!p.role && adopted?.role) {
          const adoptedRole = adopted.role
          if (adoptedRole === "chief" || adoptedRole === "member" || adoptedRole === "watch") {
            role = adoptedRole
          }
        }

        // Compute project identity FIRST so resolveName's F1-D step can use
        // project_id for cross-Claude-session name adoption.
        const project = String(p.project ?? process.cwd())
        const projectName = String(p.projectName ?? project.split("/").pop() ?? "unknown")
        const projectId = String(p.projectId ?? resolveProjectId(project))

        const name = deduplicateName(
          resolveName(p, adopted, claudeSessionName, claudeSessionId, role, isActive, projectId),
        )
        const domains = (p.domains as string[]) ?? []
        const peerSocket = (p.peerSocket as string) ?? null
        const pid = Number(p.pid ?? 0)

        // Log protocol version mismatch as warning
        const clientProtocolVersion = p.protocolVersion ? Number(p.protocolVersion) : undefined
        if (clientProtocolVersion !== undefined && clientProtocolVersion !== TRIBE_PROTOCOL_VERSION) {
          log(
            `Protocol version mismatch: client=${clientProtocolVersion}, daemon=${TRIBE_PROTOCOL_VERSION} (session=${name})`,
          )
        }

        const clientCtx = createTribeContext({
          db,
          stmts,
          sessionId: adopted?.id ?? randomUUID(),
          sessionRole: role,
          initialName: name,
          domains,
          claudeSessionId,
          claudeSessionName,
          // Tap hook — every message written through this ctx flows through
          // messageTap (activity-log + fanout). See km-tribe.event-bus +
          // km-tribe.activity-log.
          onMessageInserted: messageTap,
        })

        registerSession(clientCtx, projectId, (sid) => getActiveSessionIds().has(sid), identityToken)

        const client = applyClient(connId, {
          name,
          role,
          domains,
          project,
          projectName,
          projectId,
          pid,
          claudeSessionId,
          peerSocket,
          ctx: clientCtx,
        })

        replayOrBootstrap(connId, client, adopted)
        announceJoin(client)

        // Chief derived from connection order (or explicit claim).
        const chiefInfo = deriveChiefInfo(clients.values(), chiefClaim)
        const chiefName = chiefInfo?.name ?? "none"

        // Return current coordination state for this project
        const coordState = db
          .prepare("SELECT key, value FROM coordination WHERE project_id = ?")
          .all(projectId) as Array<{ key: string; value: string | null }>

        return makeResponse(id, {
          sessionId: clientCtx.sessionId,
          name,
          role,
          chief: chiefName,
          protocolVersion: TRIBE_PROTOCOL_VERSION,
          coordinationState: coordState,
          daemon: { pid: process.pid, uptime: Math.floor((Date.now() - startedAt) / 1000) },
        })
      }

      // Tribe tool calls — delegate to existing handlers.
      case TRIBE_COORD_METHODS.send:
      case TRIBE_COORD_METHODS.broadcast:
      case TRIBE_COORD_METHODS.members:
      case TRIBE_COORD_METHODS.history:
      case TRIBE_COORD_METHODS.rename:
      case TRIBE_COORD_METHODS.join:
      case TRIBE_COORD_METHODS.health:
      case TRIBE_COORD_METHODS.reload:
      case TRIBE_COORD_METHODS.retro:
      case TRIBE_COORD_METHODS.chief:
      case TRIBE_COORD_METHODS.claimChief:
      case TRIBE_COORD_METHODS.releaseChief:
      case TRIBE_COORD_METHODS.debug: {
        const client = clients.get(connId)
        const ctx = client?.ctx ?? daemonCtx

        const result = await handleToolCall(ctx, method, p, DAEMON_HANDLER_OPTS)

        // Sync client registry after name/role changes
        // (Don't logActivity here — the handler already broadcasts for rename,
        // and for join the session announces itself. Avoids duplicate messages.)
        if ((method === TRIBE_COORD_METHODS.join || method === TRIBE_COORD_METHODS.rename) && client) {
          client.name = ctx.getName()
          client.role = ctx.getRole()
        }

        // Fanout happens synchronously inside sendMessage via the
        // ctx.onMessageInserted hook installed on clientCtx at register time
        // (km-tribe.event-bus). No polling drain needed.

        return makeResponse(id, result)
      }

      // CLI-specific methods
      case "cli_status": {
        const now = Date.now()

        // Build parent map: first session per claudeSessionId is the parent
        const parentMap = new Map<string, string>()
        for (const [, c] of clients) {
          if (c.claudeSessionId && !parentMap.has(c.claudeSessionId)) {
            parentMap.set(c.claudeSessionId, c.name)
          }
        }

        const sessions = Array.from(clients.values()).map((c) => {
          const parent = c.claudeSessionId ? parentMap.get(c.claudeSessionId) : undefined
          return {
            id: c.id,
            name: c.name,
            role: c.role,
            domains: c.domains,
            pid: c.pid,
            project: c.project,
            projectName: c.projectName,
            projectId: c.projectId,
            claudeSessionId: c.claudeSessionId,
            peerSocket: c.peerSocket,
            connectedAt: c.registeredAt,
            uptimeMs: now - c.registeredAt,
            source: "daemon" as const,
            conn: c.conn,
            resources: [] as string[],
            parent: parent && parent !== c.name ? parent : undefined,
          }
        })

        return makeResponse(id, {
          sessions,
          daemon: {
            pid: process.pid,
            uptime: Math.floor((Date.now() - startedAt) / 1000),
            clients: clients.size,
            dbPath: DB_PATH,
            socketPath: SOCKET_PATH,
            resources: activePluginNames,
          },
        })
      }

      case "cli_health": {
        const health = await handleToolCall(daemonCtx, TRIBE_COORD_METHODS.health, {}, DAEMON_HANDLER_OPTS)
        // Include machine health metrics from health-monitor plugin
        const { getHealthSnapshot } = await import("./lib/tribe/health-monitor-plugin.ts")
        let machine: unknown = null
        try {
          machine = await getHealthSnapshot()
        } catch {
          /* health snapshot unavailable */
        }
        return makeResponse(id, {
          ...health,
          machine,
          daemon: {
            pid: process.pid,
            uptime: Math.floor((Date.now() - startedAt) / 1000),
            clients: clients.size,
          },
        })
      }

      case "cli_log": {
        const limit = Number(p.limit ?? 20)
        const rows = db.prepare("SELECT * FROM messages ORDER BY ts DESC LIMIT ?").all(limit)
        return makeResponse(id, { messages: (rows as unknown[]).reverse() })
      }

      case "cli_daemon": {
        return makeResponse(id, {
          pid: process.pid,
          uptime: Math.floor((Date.now() - startedAt) / 1000),
          clients: clients.size,
          dbPath: DB_PATH,
          socketPath: SOCKET_PATH,
          startedAt,
          quitTimeout: QUIT_TIMEOUT,
        })
      }

      // Log event — fire-and-forget from proxies for observability.
      // Events land in `messages WHERE kind='event'` as the single source of
      // truth (km-tribe.polish-sweep item 9 folded the former `event_log`
      // dual-write into this journal).
      case "log_event": {
        const client = clients.get(connId)
        const ctx = client?.ctx ?? daemonCtx
        logEvent(
          ctx,
          String(p.type ?? "unknown"),
          p.bead_id as string | undefined,
          p.meta as Record<string, unknown> | undefined,
        )
        // If content is provided, also broadcast via logActivity for watch visibility
        if (p.content) logActivity(String(p.type ?? "event"), String(p.content))
        return makeResponse(id, { ok: true })
      }

      // Discovery — find peers by project, name, or resource
      case "discover": {
        const query = {
          project_id: p.project_id as string | undefined,
          name: p.name as string | undefined,
        }

        let results = Array.from(clients.values()).filter((c) => c.role !== "pending")
        if (query.project_id) results = results.filter((c) => c.projectId === query.project_id)
        if (query.name) results = results.filter((c) => c.name === query.name)

        return makeResponse(id, {
          results: results.map((c) => ({
            name: c.name,
            role: c.role,
            project: c.project,
            projectId: c.projectId,
            peerSocket: c.peerSocket,
            domains: c.domains,
          })),
        })
      }

      // Coordination state — queryable key-value per project
      case "set_state": {
        const client = clients.get(connId)
        const projectId = String(p.project_id ?? client?.projectId ?? "")
        const key = String(p.key)
        const value = p.value !== undefined ? JSON.stringify(p.value) : null
        db.prepare(
          "INSERT OR REPLACE INTO coordination (project_id, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)",
        ).run(projectId, key, value, client?.name ?? "daemon", Date.now())
        return makeResponse(id, { ok: true })
      }

      case "get_state": {
        const client = clients.get(connId)
        const projectId = String(p.project_id ?? client?.projectId ?? "")
        if (p.key) {
          const row = db
            .prepare("SELECT * FROM coordination WHERE project_id = ? AND key = ?")
            .get(projectId, String(p.key))
          return makeResponse(id, { state: row ?? null })
        }
        const rows = db.prepare("SELECT * FROM coordination WHERE project_id = ?").all(projectId)
        return makeResponse(id, { state: rows })
      }

      // Stream mode for watch
      case "subscribe": {
        return makeResponse(id, { subscribed: true })
      }

      default: {
        // Lore (memory) RPC surface — absorbed from the former standalone
        // lore daemon (km-bear.unified-daemon Phase 5a). Lore method names
        // all sit under the tribe.* namespace (tribe.ask, tribe.brief, ...)
        // per km-silvery.tribe-mcp-rename. They are mutually exclusive with
        // the coord methods above because those use TRIBE_COORD_METHODS
        // (tribe.send / tribe.broadcast / etc.).
        if (loreHandlers && loreHandlers.isLoreMethod(method)) {
          const client = clients.get(connId)
          const loreConn = client?.lore ?? ({ sessionId: null, claudePid: null } as LoreConnState)
          try {
            const result = await loreHandlers.dispatch(loreConn, method, p)
            return makeResponse(id, result as Record<string, unknown>)
          } catch (err) {
            const errorWithCode = err as Error & { code?: number }
            const code = typeof errorWithCode.code === "number" ? errorWithCode.code : -32603
            const msg = errorWithCode.message ?? String(err)
            return makeError(id, code, msg)
          }
        }
        return makeError(id, -32601, `Method not found: ${method}`)
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`Error handling ${method}: ${msg}`)
    return makeError(id, -32603, msg)
  }
}

// ---------------------------------------------------------------------------
// Plugins (git / beads / github / health / accountly)
//
// Plugins are optional observer modules that emit messages onto the tribe
// wire via TribeClientApi. The daemon's core responsibilities (register,
// broadcast, fanout, lore) don't depend on any plugin — TRIBE_NO_PLUGINS=1
// boots a fully functional daemon with zero plugins.
//
// In an out-of-process world each plugin would connect to the daemon over
// the Unix socket as an observer client. Here they share the daemon's event
// loop for simplicity — but they are isolated from daemon internals (no DB,
// no clients map, no session UUID); the TribeClientApi below is the entire
// surface they see.
// ---------------------------------------------------------------------------

const tribeClientApi: TribeClientApi = {
  send(recipient, content, type, beadId, classification) {
    // Fanout via daemonCtx.onMessageInserted (km-tribe.event-bus) — no drain.
    // Kind is inferred: '*' → 'broadcast', anything else → 'direct'.
    sendMessage(
      daemonCtx,
      recipient,
      content,
      type,
      beadId,
      undefined,
      recipient === "*" ? "broadcast" : "direct",
      classification ?? {},
    )
  },
  broadcast(content, type, beadId, classification) {
    sendMessage(daemonCtx, "*", content, type, beadId, undefined, "broadcast", classification ?? {})
  },
  claimDedup(key) {
    // Single writer — no need for BEGIN IMMEDIATE in daemon mode
    const result = stmts.claimDedup.run({ $key: key, $session_id: DAEMON_SESSION_ID, $ts: Date.now() })
    return result.changes > 0
  },
  hasRecentMessage(contentPrefix) {
    const since = Date.now() - 300_000
    return !!stmts.hasRecentMessage.get({ $prefix: contentPrefix, $since: since })
  },
  getActiveSessions() {
    return Array.from(clients.values())
      .filter((c) => c.role !== "watch" && c.role !== "pending")
      .map((c) => ({ name: c.name, pid: c.pid, role: c.role }))
  },
  getSessionNames() {
    return Array.from(clients.values())
      .filter((c) => c.role !== "watch" && c.role !== "pending")
      .map((c) => c.name)
  },
  hasChief() {
    return deriveChiefId(clients.values(), chiefClaim) !== null
  },
}

// Wire up log broadcasting now that tribeClientApi is ready.
// km-tribe.event-classification: daemon warn/error logs are ambient — they
// signal degraded daemon health but no agent needs to act. Health alerts go
// through the health-monitor plugin path, which classifies severity.
broadcastLog = (msg, type) => {
  sendMessage(daemonCtx, "*", msg, type, undefined, undefined, "broadcast", {
    delivery: "pull",
    responseExpected: "no",
    pluginKind: type,
  })
}

const plugins = process.env.TRIBE_NO_PLUGINS
  ? []
  : [gitPlugin, beadsPlugin, githubPlugin, healthMonitorPlugin, accountlyPlugin, doltReaperPlugin]
const loadedPlugins = loadPlugins(plugins, tribeClientApi)
const activePluginNames = loadedPlugins.active.filter((p) => p.active).map((p) => p.name)
const stopPlugins = loadedPlugins.stop

// 1-second tick: idle-liveness only. Messages are delivered synchronously via
// the ctx.onMessageInserted fanout hook (km-tribe.event-bus), so there's no
// polling drain in this tick anymore.
const livenessInterval = timers.setInterval(() => {
  checkLiveness()
}, 1000)

// Data cleanup every 6 hours
const cleanupInterval = timers.setInterval(() => cleanupOldData(daemonCtx), 6 * 60 * 60 * 1000)
cleanupOldData(daemonCtx)

// Chief is derived from connection order (see `deriveChiefId`). No promotion
// timers, no lease renewal — the chief changes automatically when the
// longest-connected client disconnects. An explicit `tribe.claim-chief`
// overrides this until the claimer disconnects or calls `tribe.release-chief`.

// ---------------------------------------------------------------------------
// Socket server
// ---------------------------------------------------------------------------

// Suppress join/leave broadcasts during initial reconnection burst after hot-reload.
// TRIBE_NO_SUPPRESS=1 disables this (used in tests).
const SUPPRESS_WINDOW_MS = process.env.TRIBE_NO_SUPPRESS ? 0 : 10_000
const startedAt = Date.now()

function handleConnection(socket: NetSocket): void {
  const connId = randomUUID()
  log(`Client connected: ${connId.slice(0, 8)}`)

  // Pre-register with socket only (full registration on "register" call).
  // role="pending" marks this as half-registered — never chief-eligible, never
  // counted as a tribe member; the eligibility filter in isChiefEligible and
  // broadcastToConnected consult `role`, not `name`.
  const placeholder: ClientSession = {
    socket,
    id: connId,
    name: `pending-${connId.slice(0, 6)}`,
    role: "pending",
    domains: [],
    project: process.cwd(),
    projectName: "unknown",
    projectId: "",
    pid: 0,
    claudeSessionId: null,
    peerSocket: null,
    conn: "",
    ctx: daemonCtx,
    registeredAt: Date.now(),
    lore: { sessionId: null, claudePid: null },
  }
  clients.set(connId, placeholder)
  socketToClient.set(socket, connId)
  markActive()

  const parse = createLineParser(async (msg: JsonRpcMessage) => {
    if (isRequest(msg)) {
      const response = await handleRequest(msg, connId)
      try {
        socket.write(response)
      } catch {
        // Socket died during handling
      }
    }
  })

  socket.on("data", parse)

  socket.on("close", () => {
    const client = clients.get(connId)
    if (client && client.role !== "pending") {
      log(`Client disconnected: ${client.name}`)
      logActivity("session", `${client.name} left`)

      // Phase 2 of km-tribe.plateau: no DB bookkeeping on disconnect. The
      // session row survives (cursor recovery queries it on reconnect), and
      // liveness is determined by clients Map membership — `clients.delete`
      // below is the authoritative "this session is gone" signal.
      //
      // km-tribe.delivery-correctness P0.6: we do NOT delete journal rows on
      // disconnect. The journal is durable. Delivered-or-not, a direct stays
      // until retention prunes it — the cursor tracks delivery, the journal
      // tracks history. The old `DELETE FROM messages WHERE recipient = ?`
      // fought the durability contract and lost messages sent mid-disconnect.
    }

    // Flush any pending coalesced broadcasts before tearing down the client
    // so late-arriving events in the current batch window aren't dropped.
    broadcastCoalescer.flush(connId)
    broadcastCoalescer.discard(connId)

    clients.delete(connId)
    socketToClient.delete(socket)
    // No per-connection cursor state to clean up — the durability cursor lives
    // in sessions.last_delivered_seq (km-tribe.event-bus).
    if (loreHandlers && client) loreHandlers.dropConn(client.lore.sessionId)

    // If the disconnecting client had the explicit chief claim, clear it so
    // the derivation takes over (longest-remaining-connected becomes chief).
    if (client && chiefClaim === client.ctx.sessionId) {
      chiefClaim = null
      logActivity("chief:released", `${client.name} released chief (disconnect)`)
    }

    // Start idle countdown if no clients left
    if (clients.size === 0) markIdle()
  })

  socket.on("error", (err) => {
    log(`Client error (${connId.slice(0, 8)}): ${err.message}`)
    // Error triggers close event, which handles cleanup
    socket.destroy()
  })
}

let server: Server

if (INHERIT_FD !== null) {
  // Hot-reload: inherit existing socket fd
  server = createServer(handleConnection)
  server.listen({ fd: INHERIT_FD })
  log(`Inherited socket fd ${INHERIT_FD} (hot-reload)`)
} else {
  // Check if another daemon is already running by probing the socket.
  // If the connect succeeds, a live daemon is listening — exit quietly.
  // If it fails (ECONNREFUSED / ENOENT), the socket is stale or absent.
  if (existsSync(SOCKET_PATH)) {
    const alive = await new Promise<boolean>((resolvePromise) => {
      const probe = createConnection(SOCKET_PATH)
      let settled = false
      const finish = (v: boolean) => {
        if (settled) return
        settled = true
        try {
          probe.destroy()
        } catch {
          /* ignore */
        }
        resolvePromise(v)
      }
      probe.once("connect", () => finish(true))
      probe.once("error", () => finish(false))
      // Safety timeout — don't hang daemon startup on a wedged socket
      // Node returns NodeJS.Timeout (has .unref()), Bun returns number — guard both
      const t = setTimeout(() => finish(false), 500) as unknown as { unref?: () => void }
      t.unref?.()
    })
    if (alive) {
      log(`Another daemon is already listening on ${SOCKET_PATH}, exiting`)
      process.exit(0)
    }
    // Stale socket file — remove it so bind() succeeds below.
    try {
      unlinkSync(SOCKET_PATH)
    } catch {
      /* ignore */
    }
  }

  server = createServer(handleConnection)
  server.listen(SOCKET_PATH, () => {
    // Restrict socket to owner only (no group/other access)
    try {
      chmodSync(SOCKET_PATH, 0o600)
    } catch {
      /* ignore on platforms that don't support it */
    }
  })
  log(`Listening on ${SOCKET_PATH}`)
}

// ---------------------------------------------------------------------------
// Auto-quit liveness — declarative deadline + periodic check
// ---------------------------------------------------------------------------
//
// Liveness is a pure function of current state, not an event-driven timer:
//   - markActive()   — clear the deadline (someone is using us)
//   - markIdle()     — set the deadline (we may be done; checkLiveness decides)
//   - checkLiveness() — runs from the existing 1s tick poller
//
// This eliminates the bug class where a code path forgets to start/cancel
// a setTimeout. Adding a new "extends life" trigger is one line: markActive().

let idleDeadline: number | null = null

function markActive(): void {
  idleDeadline = null
}

function markIdle(): void {
  if (QUIT_TIMEOUT < 0) return // -1 = never auto-quit
  if (idleDeadline !== null) return // already counting down
  idleDeadline = Date.now() + QUIT_TIMEOUT * 1000
  log(`No clients connected. Auto-quit in ${QUIT_TIMEOUT}s...`)
}

function checkLiveness(): void {
  // Expire pending sessions that never sent a register message (>60s)
  const now = Date.now()
  for (const [connId, client] of clients) {
    if (client.role === "pending" && now - client.registeredAt > 60_000) {
      log(`Expiring stale pending session: ${client.name} (age=${Math.floor((now - client.registeredAt) / 1000)}s)`)
      clients.delete(connId)
      socketToClient.delete(client.socket)
      try {
        client.socket.destroy()
      } catch {
        /* already dead */
      }
    }
  }

  if (idleDeadline === null) return
  // Defensive: if a client snuck in, abort the countdown
  if (clients.size > 0) {
    idleDeadline = null
    return
  }
  if (now >= idleDeadline) {
    log("Auto-quit: idle deadline reached")
    shutdown()
  }
}

// ---------------------------------------------------------------------------
// Hot-reload (SIGHUP)
// ---------------------------------------------------------------------------

process.on("SIGHUP", () => {
  log("SIGHUP received — re-exec for hot-reload")
  // Don't broadcast reload — sessions reconnect automatically and don't need to know

  // Stop plugins BEFORE spawning — ensures cursor/state is flushed to disk
  // so the new process reads up-to-date state (prevents duplicate event delivery)
  stopPlugins()

  // Pass the socket fd to the new process
  const socketFd = (server as any)._handle?.fd
  if (socketFd == null) {
    log("Cannot hot-reload: no socket fd available")
    return
  }

  // Stop accepting new connections on old server
  // But don't close existing connections — let them drain

  const argv = process.argv.slice(1).filter((a) => !a.startsWith("--fd"))
  argv.push(`--fd=${socketFd}`)

  const child = spawn(process.execPath, argv, {
    stdio: ["ignore", "inherit", "inherit", socketFd],
    detached: false,
    env: process.env,
  })

  // Give new process time to start, then exit
  child.on("error", (err) => {
    log(`Hot-reload spawn failed: ${err.message}`)
  })

  timers.setTimeout(() => {
    log("Hot-reload: old process exiting, new process taking over")
    ac.abort()
    // Don't close server — fd is inherited by child
    process.exit(0)
  }, 1000)
})

// ---------------------------------------------------------------------------
// Source file watcher — auto-SIGHUP on code changes
// ---------------------------------------------------------------------------

const sourceDir = pathDirname(new URL(import.meta.url).pathname)
const libTribeDir = pathResolve(sourceDir, "lib/tribe")

function computeSourceHash(): string {
  const files = [
    pathResolve(sourceDir, "tribe-daemon.ts"),
    pathResolve(sourceDir, "tribe-proxy.ts"),
    ...(() => {
      try {
        return readdirSync(libTribeDir)
          .filter((f) => f.endsWith(".ts"))
          .sort()
          .map((f) => pathResolve(libTribeDir, f))
      } catch {
        return []
      }
    })(),
  ]
  const hash = createHash("md5")
  for (const f of files) {
    try {
      hash.update(readFileSync(f))
    } catch {
      /* missing */
    }
  }
  return hash.digest("hex").slice(0, 12)
}

let sourceHash = computeSourceHash()
let reloadDebounce: ReturnType<typeof setTimeout> | null = null

function onSourceChange(filename: string | null): void {
  if (filename && !filename.endsWith(".ts")) return
  if (reloadDebounce) timers.clearTimeout(reloadDebounce)
  reloadDebounce = timers.setTimeout(() => {
    const newHash = computeSourceHash()
    if (newHash === sourceHash) return // No actual change
    log(`Source changed (${sourceHash} → ${newHash}), triggering hot-reload`)
    sourceHash = newHash
    process.emit("SIGHUP")
  }, 500)
}

// Watch both the tools dir (tribe-daemon.ts, tribe-proxy.ts) and lib/tribe/
const watchers = [
  watch(sourceDir, { persistent: false }, (_event, filename) => onSourceChange(filename)),
  ...(existsSync(libTribeDir)
    ? [watch(libTribeDir, { persistent: false }, (_event, filename) => onSourceChange(filename))]
    : []),
]
log(`Watching source files for auto-reload`)

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(): void {
  log("Shutting down...")
  stopPlugins()
  ac.abort() // Clears all managed timers (push, cleanup, quit, debounce)
  // Close lore handlers (stops focus poller + summarizer, closes lore.db).
  // `ac.abort()` above already triggers this via the AbortSignal hook, but
  // call explicitly for clarity and pre-abort ordering.
  void loreHandlers?.close()
  for (const w of watchers) w.close()

  // Close all client connections
  for (const [, client] of clients) {
    try {
      client.socket.end()
    } catch {
      /* ignore */
    }
  }
  clients.clear()

  server.close()
  try {
    unlinkSync(SOCKET_PATH)
  } catch {
    /* ignore */
  }
  try {
    db.close()
  } catch {
    /* ignore */
  }
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

log(`Daemon ready (pid=${process.pid}, clients=${clients.size})`)

// Begin idle countdown immediately. If a client connects before the deadline,
// markActive() in handleConnection clears it. This handles the case where a
// daemon is spawned but no client ever connects (e.g. spawning test crashes).
if (clients.size === 0) markIdle()
