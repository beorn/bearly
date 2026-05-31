#!/usr/bin/env bun
/**
 * Stdio Adapter — thin MCP server that bridges Claude Code's stdio MCP wire
 * to the tribe daemon's Unix-socket MCP wire.
 *
 * Per-agent transport translator: stdio ↔ daemon. No direct DB access, no
 * polling, no plugins — just MCP forwarding.
 *
 * Local dev (workspace .mcp.json):
 *   `bun packages/tribe-client/src/stdio-adapter.ts --name chief --role chief`
 * Published (plugin runtime): the plugin's `server.ts` calls
 *   `import { runStdioAdapter } from "@bearly/tribe-client/stdio"`
 * which transitively imports this file and invokes its module-level bootstrap.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import {
  parseTribeArgs,
  parseSessionDomains,
  resolveClaudeSessionId,
  resolveClaudeSessionName,
  resolveProjectName,
  resolveProjectId,
} from "./lib/config.ts"
import { resolveSocketPath, createReconnectingClient, TRIBE_PROTOCOL_VERSION, type DaemonClient } from "./lib/socket.ts"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { TOOLS_LIST } from "./lib/tools-list.ts"
import { createLogger, setSuppressConsole } from "loggily"
import { createTimers } from "./timers.ts"
import { defangModelInput } from "./lib/defang.ts"
import { evaluateCwdPolicy, probeCwd, readCwdPolicyFromEnv, type CwdEvaluation } from "./lib/cwd-guardrail.ts"

if (process.env.DEBUG_LOG) {
  process.env.LOG_FILE ??= process.env.DEBUG_LOG
  setSuppressConsole(true)
}

const log = createLogger("tribe:stdio-adapter")

const proxyAc = new AbortController()
const timers = createTimers(proxyAc.signal)

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const args = parseTribeArgs()
const SOCKET_PATH = resolveSocketPath(args.socket)
const SESSION_DOMAINS = parseSessionDomains(args)
const CLAUDE_SESSION_ID = resolveClaudeSessionId()
const CLAUDE_SESSION_NAME = resolveClaudeSessionName()
// km-bearly.tribe-dm-delivery-gap: declare delivery mode. MCP-only clients
// without a Claude channel reader (codex, gemini, hermes, etc.) should run
// with TRIBE_DELIVERY=pull so the daemon queues events for tribe.fetch instead
// of fanning them out down a Claude-specific notification channel.
const DELIVERY = process.env.TRIBE_DELIVERY === "pull" ? "pull" : "push"
const CLAUDE_CHANNEL_ENABLED = DELIVERY === "push"
const REQUIRE_EXPLICIT_JOIN = process.env.TRIBE_REQUIRE_JOIN !== "0"

// Worktree-isolation guardrail (km-bearly.tribe-codex-cwd-worktree-guardrail):
// standalone codex / non-launcher MCP clients inherit the user's invocation
// cwd. If that cwd is the main repo while a `<basename>-wtN` pool exists,
// warn the agent so edits don't leak into main. Evaluation is pure; the
// notification fires after MCP is up. Policy env: TRIBE_MAIN_REPO_POLICY.
const CWD_POLICY = readCwdPolicyFromEnv()
const CWD_EVAL: CwdEvaluation = evaluateCwdPolicy(CWD_POLICY, probeCwd())
if (CWD_EVAL.kind === "warn" || CWD_EVAL.kind === "refuse") {
  log.warn?.(CWD_EVAL.message)
} else {
  log.debug?.(`cwd-guardrail: ${CWD_EVAL.kind} (${CWD_EVAL.reason})`)
}

log.info?.(`Connecting to daemon at ${SOCKET_PATH}`)

let myName = "pending"
let myRole = "member"
let joined = !REQUIRE_EXPLICIT_JOIN
const mySessionId = randomUUID()
const PROJECT_NAME = resolveProjectName()

// MCP server reference — constructed + connected to Claude Code BEFORE the
// daemon connection resolves, so the MCP `initialize` handshake is answered
// in milliseconds rather than blocked on daemon spawn/connect.
// oxlint-disable-next-line eslint(prefer-const) -- deferred init, assigned before use
let mcp: Server
// Daemon client — populated asynchronously by `daemonReady` (the daemon
// block below). Stays `undefined` until the background connect resolves;
// call sites either `await daemonReady` (when they need a guaranteed
// client) or use `daemon?.` (best-effort).
let daemon: DaemonClient | undefined
// oxlint-disable-next-line eslint(prefer-const) -- assigned in the daemon block below
let daemonReady: Promise<DaemonClient>

/**
 * Forward a channel notification to Claude Code.
 *
 * The `content` is defanged via `defangModelInput` before reaching the
 * MCP wire. This is the third leg of the autocatalytic-trigger fix
 * (alongside the hook-stdio muzzle in `lib/tribe/hook-dispatch.ts` and
 * the envelope-defang in `injection-envelope/src/emit.ts`):
 *
 *   - Hooks → handled by hook-dispatch muzzle.
 *   - additionalContext payloads → handled by emit.ts defang.
 *   - **Tribe channel notifications** (this path) → handled here.
 *     These travel through the MCP server's notification channel,
 *     which Claude Code wraps as `<system-reminder>A message arrived
 *     from plugin:tribe:tribe ...</system-reminder>`. Without this
 *     defang, content like `agent7 | claimed: ... last commit: <SHA>`
 *     reads as transcript-shaped to the model — same trigger surface
 *     as additionalContext but a different transport.
 *
 * `meta` is harness/tribe routing metadata (from / type / bead /
 * message_id) — not user-visible content — so it's left as-is.
 */
function sendChannel(content: string, meta: Record<string, string | undefined>): void {
  if (!CLAUDE_CHANNEL_ENABLED) return
  if (!joined) return
  if (!mcp) return // Not yet initialized
  const safeContent = defangModelInput(content)
  mcp.notification({ method: "notifications/claude/channel", params: { content: safeContent, meta } }).catch(() => {})
}

const NOTIFICATION_ONLY_MARKER = "notification-only:do-not-acknowledge-or-respond-to"

function isNotificationOnlyType(type: string): boolean {
  if (type === "session" || type === "status" || type === "delta") return true
  if (type.startsWith("chief:")) return true
  if (type.startsWith("github:")) return true
  return false
}

function markedType(type: string): string {
  return isNotificationOnlyType(type) ? `${NOTIFICATION_ONLY_MARKER}:${type}` : type
}

type TribeFetchResult = {
  events?: Array<{
    id?: string
    type?: string
    from?: string
    content?: string
    bead?: string | null
    topic?: string | null
  }>
}

function parseToolText<T>(result: unknown): T | null {
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text
  if (typeof text !== "string") return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Daemon connection
// ---------------------------------------------------------------------------

// Identity token — stable across Claude Code restarts in the same project
// with the same role hint. Hash of (claude_session_id, project_path, role_hint)
// → first 16 hex chars of sha256. When claude_session_id is null (some
// environments), the token still matches on project+role — weaker but safe
// (no cross-project or cross-role leakage). See km-tribe.session-identity.
const identityToken = createHash("sha256")
  .update(`${CLAUDE_SESSION_ID ?? ""}|${process.cwd()}|${args.role ?? "member"}`)
  .digest("hex")
  .slice(0, 16)

const registerParams = {
  ...(args.name && !REQUIRE_EXPLICIT_JOIN ? { name: args.name } : {}),
  ...(args.role ? { role: args.role } : {}),
  domains: SESSION_DOMAINS,
  project: process.cwd(),
  projectName: PROJECT_NAME,
  projectId: resolveProjectId(),
  protocolVersion: TRIBE_PROTOCOL_VERSION,
  // Peer-direct messaging was removed (km-tribe DM-body-drop bug): a DM
  // delivered socket-to-socket bypassed the daemon journal, so the body row
  // never landed in `messages` and pull/reconnect readers lost it. All sends
  // now route through the daemon, which persists the row AND fans out.
  peerSocket: null,
  pid: process.pid,
  claudeSessionId: CLAUDE_SESSION_ID,
  claudeSessionName: CLAUDE_SESSION_NAME,
  identityToken,
  delivery: REQUIRE_EXPLICIT_JOIN ? "pull" : DELIVERY,
  // @km/infra/15641 Phase 1 — per-session account/provider label sourced
  // from `ag` via TRIBE_ACCOUNT / TRIBE_PROVIDER env vars (which ag sets
  // at backend-launch time). Tribe stores them; quota visibility lives in
  // ag, not here.
  ...(args.account ? { account: args.account } : {}),
  ...(args.provider ? { provider: args.provider } : {}),
}

// NON-BLOCKING: the daemon connect runs in the background. We do NOT await
// it here — module evaluation continues straight through to `mcp.connect()`
// so the MCP `initialize` handshake is answered immediately. Without this, a
// slow daemon connect (cold start, or spawn + retry backoff) stalled the
// handshake long enough for codex's MCP launcher to time out and relaunch
// the server — the double-spawn seen in the connect logs. Tool calls that
// arrive before the daemon is ready `await daemonReady` in the handler.
daemonReady = createReconnectingClient({
  socketPath: SOCKET_PATH,
  async onConnect(client) {
    const reg = (await client.call("register", registerParams)) as {
      sessionId: string
      name: string
      role: string
      chief: string
    }
    myName = reg.name
    myRole = reg.role
    log.info?.(`Registered as ${myName} (${myRole})`)
    void client.call("subscribe").catch(() => {})

    // Startup banner — emit tribe state to the channel so the agent (and user) sees the setup
    try {
      const membersResult = (await client.call("tribe.members", {})) as { content: Array<{ text: string }> }
      const membersData = JSON.parse(membersResult.content?.[0]?.text ?? "{}") as {
        sessions?: Array<{ name: string; role: string; alive: boolean; uptime_min: number; delivery?: string }>
      }
      const sessions = (membersData.sessions ?? []).filter((s: { alive: boolean }) => s.alive)
      const chief = reg.chief || sessions.find((s: { role: string }) => s.role === "chief")?.name || "(none)"
      const peers =
        sessions
          .filter((s: { name: string }) => s.name !== myName)
          .map((s: { name: string; role: string }) => `${s.name} (${s.role})`)
          .join(", ") || "(solo)"

      const shortSocket = SOCKET_PATH.replace(process.env.HOME ?? "", "~")
      const banner = `**tribe** ${myName} (${myRole}) · chief: ${chief} · ${DELIVERY} · peers: ${peers} · ${shortSocket}`
      sendChannel(banner, { from: "tribe-startup", type: "system" })
    } catch {
      // Non-fatal — banner is diagnostic, don't block startup
      log.debug?.("Startup banner failed (non-fatal)")
    }
  },
  onDisconnect() {
    log.debug?.(`Daemon connection lost`)
  },
  onReconnect() {
    log.info?.(`Reconnected to daemon`)
  },
}).then((client) => {
  daemon = client
  return client
})

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const joinInstruction = `If you receive a stdio-adapter auto-identify message, just call tribe.join with a short name for your focus area. Omit the role parameter — the daemon auto-assigns chief to the first session and member to the rest. No need to call tribe.members or tribe.fetch afterward — just join silently and continue.`

// Shared turn-start inbox guidance for every role variant. Kept deliberately
// SMALL: new messages already arrive inline as <channel> envelopes (push delivery
// via drainDaemonInbox below), so the turn-start call is a small catch-up drain —
// NOT a full replay. The old `limit: 50` window re-pulled already-seen ambient
// traffic on every turn and flooded long-running agent context.
// See km @km/tribe/19442-turn-start-fetch-context-flood.
const turnStartInboxCheck = `Turn-start inbox check:
- New messages also arrive inline as <channel> envelopes — read those first; you do not need to fetch to receive them.
- For turn-start catch-up keep the drain SMALL: tribe.fetch({ limit: 10 }). Do NOT pull a large window every turn — replaying ~50 events re-surfaces already-seen ambient traffic and floods context.
- For a specific peer's latest, use the snapshot filter: tribe.fetch({ with: <your session name>, limit: 10 }) or tribe.fetch({ from: <peer>, limit: 10 }) — these return the newest matching messages; use them to find a thread, not to replay the whole channel.
- Surface only actionable items: direct messages, requests, blockers, assignments, chief verdicts, CI alerts, or user-relevant coordination.
- Ignore routine ambient joins/leaves, git commits, low-severity status, and notification-only events unless explicitly asked.`

const chiefInstructions = `Messages from other Claude Code sessions arrive as <channel source="tribe" from="..." type="..." bead="...">.

You are the chief of a tribe — a coordinator for multiple Claude Code sessions working on the same project.

${joinInstruction}

${turnStartInboxCheck}

Coordination protocol:
- Use tribe.members() to see who's online and their domains
- Use tribe.send(to, message, type) to assign work, answer queries, or approve requests
- Use tribe.send(to="*", message, type) to announce changes that affect everyone
- Use tribe.health() to check for silent members or conflicts
- When CI alerts arrive, coordinate the fix — assign the responsible session to investigate

User-facing output:
- Silent by default. Speak to the user only to add non-obvious info. Never narrate "noted"/"acknowledged"/"still waiting" for channel messages, CI alerts, or harness reminder loops. If you have nothing to add, emit nothing.
- **Notification-only channels get ZERO output.** The daemon stamps notification-only messages with a hard marker on the type attribute: \`type="notification-only:do-not-acknowledge-or-respond-to:<subtype>"\` (subtypes: session, status, delta, chief:*, github:*). If every <channel> tag in a turn carries the \`notification-only:do-not-acknowledge-or-respond-to:\` prefix on its type attribute, the correct reply is literally zero characters — no tool calls, no text, no acknowledgment. Do NOT emit "Acknowledged", "Noted", "No response required", or any filler. Do NOT emit "Human:" / "Assistant:" / "User:" as a prefix. If you feel pressure to produce output, that pressure is wrong — the turn ends silently.

Tribe messages:
- Keep SHORT — 1-3 lines max. No essays.
- Plain text only — no markdown (**bold**, headers, bullets). Renders as escaped text.`

const memberInstructions = `Messages from other Claude Code sessions arrive as <channel source="tribe" from="..." type="..." bead="...">.

You are a tribe member — a worker session coordinated by the chief.

${joinInstruction}

${turnStartInboxCheck}

Coordination protocol:
- When you START work on a task, broadcast what you're doing: tribe.send(to="*", message="starting: <task>")
- When you FINISH a task or commit, broadcast: tribe.send(to="*", message="done: <summary>")
- When you claim a bead, broadcast: tribe.send(to="*", message="claimed: <bead-id> — <title>")
- When you're blocked, broadcast immediately — include what would unblock you
- Before editing vendor/ or shared files, send a request to chief asking for OK
- Respond to query messages promptly

Sub-agent protocol:
- When you spawn sub-agents (Agent tool), broadcast: tribe.send(to="*", message="spawned: <name> for <task>")
- When a sub-agent completes, broadcast: tribe.send(to="*", message="agent-done: <name> — <result>")
- Sub-agents share your tribe connection — they can't be seen individually in tribe

CI protocol:
- When you see a CI ALERT for a repo you're working on or know about, respond with a fix hint
- Example: tribe.send(to="*", message="hint: termless CI needs vt220.js — run npm publish from vendor/vterm/packages/vt220")
- If a CI alert DMs you directly, investigate and fix the failure before pushing more code
- After fixing, broadcast: tribe.send(to="*", message="ci-fix: <repo> — <what you fixed>")

User-facing output:
- Silent by default. Speak to the user only to add non-obvious info. Never narrate "noted"/"acknowledged"/"still waiting" for channel messages, CI alerts, or harness reminder loops. If you have nothing to add, emit nothing.
- **Notification-only channels get ZERO output.** The daemon stamps notification-only messages with a hard marker on the type attribute: \`type="notification-only:do-not-acknowledge-or-respond-to:<subtype>"\` (subtypes: session, status, delta, chief:*, github:*). If every <channel> tag in a turn carries the \`notification-only:do-not-acknowledge-or-respond-to:\` prefix on its type attribute, the correct reply is literally zero characters — no tool calls, no text, no acknowledgment. Do NOT emit "Acknowledged", "Noted", "No response required", or any filler. Do NOT emit "Human:" / "Assistant:" / "User:" as a prefix. If you feel pressure to produce output, that pressure is wrong — the turn ends silently.

Tribe messages:
- Keep SHORT — 1-3 lines max. No essays.
- Plain text only — no markdown (**bold**, headers, bullets). Renders as escaped text.
- Don't over-broadcast — only send when it changes what someone else should know.`

const pullInstructions = `Tribe coordination is available through MCP tools.

${turnStartInboxCheck}

Coordination protocol:
- Use tribe.members() to see who's online and their domains.
- Use tribe.send(to, message, type) to assign work, answer queries, broadcast status, or request help.
- Keep tribe messages short: 1-3 lines, plain text only.`

// `experimental["claude/channel"]` registers this MCP server as a Claude Code
// *channel source*. Claude Code reads this capability from the `initialize`
// response, then captures every `notifications/claude/channel` notification
// the server emits (see `sendChannel` above) — queuing them and draining on
// the next REPL turn. This IS Claude Code's native channel-delivery mechanism;
// there is no `--channels` CLI flag (the flag does not exist in Claude Code
// 2.1.145 — channel delivery is purely the MCP capability + notification).
//
// This is Mode 2 of the three-host tribe-delivery design (km epic 15409): a
// `claude` session launched via `ag` receives tribe messages through this
// channel pipe, no silvercode host and no pty send-keys hack. The tribe MCP
// `tools/*` (fetch/send/members/…) stay alongside — channels is *additive*
// delivery (push), the tools remain the pull surface.
//
// Native auto-wake of an idle REPL on channel arrival is currently bug-broken
// upstream — Claude Code GitHub issue #44380 (channel messages queue but do
// not wake an idle REPL). Channels-as-delivery is still correct: messages
// arrive, queue, and drain on the next turn. The `/loop` heartbeat is the
// interim wake mechanism until #44380 lands.
mcp = new Server(
  { name: "tribe", version: "0.14.1" },
  {
    capabilities: {
      ...(CLAUDE_CHANNEL_ENABLED ? { experimental: { "claude/channel": {} } } : {}),
      tools: {},
    },
    // Role for the `initialize` instructions must be known synchronously
    // (the daemon hasn't connected yet — see the non-blocking daemon block).
    // `args.role` is the launch-time hint; daemon-assigned role isn't
    // available this early. Members are the common case; a chief is launched
    // with the role hint.
    instructions: CLAUDE_CHANNEL_ENABLED
      ? args.role === "chief"
        ? chiefInstructions
        : memberInstructions
      : pullInstructions,
  },
)

// ---------------------------------------------------------------------------
// Tools — forward all to daemon
// ---------------------------------------------------------------------------

let nudgeSent = false
/** Check if session name is auto-generated (not explicitly set by user/agent) */
function isAutoName(name: string): boolean {
  return name.startsWith("member-") || name.startsWith("pending-") || /^[a-z]+-\d+-[a-z0-9]{3}$/.test(name)
}
mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  // Nudge on tools discovery (fires on session init/resume)
  if (!nudgeSent && isAutoName(myName)) {
    nudgeSent = true
    timers.setTimeout(() => {
      sendChannel(
        `Auto-identify: call tribe.join(name="${myName}") with a short name for your focus area. Omit the role parameter — the daemon auto-assigns it. Do not call tribe.members or tribe.fetch — just join silently and continue.`,
        { from: "stdio-adapter", type: "system" },
      )
    }, 500)
  }
  return { tools: TOOLS_LIST }
})

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: toolArgs } = req.params
  const a = (toolArgs ?? {}) as Record<string, unknown>

  try {
    // Attach identity_token to join so the daemon can adopt prior
    // session state when Claude Code restarts and the agent calls join again.
    const payload = name === "join" ? { delivery: DELIVERY, ...a, identity_token: identityToken } : a
    // Tool names are bare verbs ("send", "fetch"); daemon wire methods use "tribe." prefix
    const daemonMethod = `tribe.${name}`
    // A tool call may arrive before the background daemon connect resolves
    // (the daemon block is non-blocking) — await `daemonReady` in that case.
    const d = daemon ?? (await daemonReady)
    const result = await d.call(daemonMethod, payload)
    // Update local name/role after join/rename
    if (name === "join" || name === "rename") {
      const r = result as { content: Array<{ type: string; text: string }> }
      try {
        const data = JSON.parse(r.content[0]?.text ?? "{}") as Record<string, string>
        if (data.name) myName = data.name
        if (data.role) myRole = data.role
      } catch {
        /* parse error, ignore */
      }
      if (name === "join") joined = true
      // Explicit rename by the agent — don't auto-rename later
      autoRenamed = true
    }
    return result as { content: Array<{ type: string; text: string }> }
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : err}` }],
    }
  }
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Hot-reload: re-exec on source changes (only when running from source, not bundled)
import { setupHotReload } from "./lib/hot-reload.ts"
using _reload = setupHotReload({
  importMetaUrl: import.meta.url,
  logActivity: (type, content) => {
    daemon?.call("log_event", { type, content }).catch(() => {})
  },
  onReload: () => {
    proxyAc.abort()
    daemon?.close()
  },
})

const shutdown = () => {
  proxyAc.abort()
  daemon?.close()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

// Connect MCP to Claude Code
await mcp.connect(new StdioServerTransport())

// Surface the cwd-guardrail decision on the tribe channel so the agent sees
// it next to other startup signals. Wrapped in setTimeout to give the MCP
// channel time to settle (mirrors the autoidentify nudge pattern above).
if (CWD_EVAL.kind === "warn" || CWD_EVAL.kind === "refuse") {
  const prefix = CWD_EVAL.kind === "refuse" ? "system" : "warning"
  timers.setTimeout(() => {
    sendChannel(CWD_EVAL.message, { from: "stdio-adapter", type: prefix })
    // Also log to the daemon's activity stream so diagnostics can surface it.
    daemon
      ?.call("log_event", {
        type: CWD_EVAL.kind === "refuse" ? "cwd_guardrail_refuse" : "cwd_guardrail_warn",
        content: CWD_EVAL.message,
      })
      .catch(() => {
        /* daemon may not be ready yet — log_event is best-effort */
      })
  }, 750)
}

// Watch transcript file for /rename slug changes and auto-sync to tribe
import { resolveTranscriptPath, readTranscriptSlug } from "./lib/transcript.ts"
import { watch as fsWatch } from "node:fs"
{
  const transcriptPath = resolveTranscriptPath(CLAUDE_SESSION_ID)
  if (transcriptPath) {
    let lastSlug: string | null = null
    const checkSlug = () => {
      const slug = readTranscriptSlug(transcriptPath)
      if (!slug || slug === lastSlug || slug === myName) return
      lastSlug = slug
      autoRenamed = true
      daemon
        ?.call("tribe.rename", { new_name: slug })
        .then((result) => {
          const r = result as { content: Array<{ type: string; text: string }> }
          try {
            const data = JSON.parse(r.content[0]?.text ?? "{}") as Record<string, string>
            if (data.name) myName = data.name
            log.info?.(`auto-renamed from /rename slug: ${myName}`)
          } catch {
            /* ignore */
          }
        })
        .catch(() => {
          /* rename failed — name taken or similar */
        })
    }
    // Check periodically (file watch is unreliable for appended JSONL files)
    timers.setInterval(checkSlug, 5_000)
  }
}

// Auto-rename: when this session claims a bead, rename to the bead scope
// e.g., claiming "km-storage.foo" renames session to "km-storage"
let autoRenamed = false
function tryAutoRenameOnClaim(content: string): void {
  if (autoRenamed) return
  // Only auto-rename if session still has auto-generated name (km-N-XXX pattern)
  if (!/^km-\d+-[a-z0-9]{3}$/.test(myName)) return
  // Match "[by:claude:XXXXXXXX]" in claim message and check if it's this session
  const byMatch = content.match(/\[by:claude:([a-f0-9]+)\]/)
  if (!byMatch) return
  const claimSessionPrefix = byMatch[1]!
  if (!CLAUDE_SESSION_ID || !CLAUDE_SESSION_ID.startsWith(claimSessionPrefix)) return
  // Extract bead scope from "Claimed: km-<scope>.<suffix> — ..."
  const beadMatch = content.match(/^Claimed: (km-[a-z][\w-]*?)\./)
  if (!beadMatch) return
  const scope = beadMatch[1]
  if (scope === myName) return
  autoRenamed = true
  daemon
    ?.call("tribe.rename", { new_name: scope })
    .then((result) => {
      const r = result as { content: Array<{ type: string; text: string }> }
      try {
        const data = JSON.parse(r.content[0]?.text ?? "{}") as Record<string, string>
        if (data.name) myName = data.name
      } catch {
        /* ignore */
      }
    })
    .catch(() => {
      /* rename failed, e.g. name taken — that's fine */
    })
}

function forwardFetchedEvent(event: NonNullable<TribeFetchResult["events"]>[number]): void {
  const content = String(event.content ?? "")
  const type = markedType(String(event.type ?? "notify"))
  if (type === "bead:claimed") tryAutoRenameOnClaim(content)
  sendChannel(content, {
    from: String(event.from ?? "unknown"),
    type,
    bead: event.bead ? String(event.bead) : undefined,
    message_id: event.id ? String(event.id) : undefined,
  })
}

let drainInFlight = false
let drainAgain = false

function drainDaemonInbox(): void {
  if (drainInFlight) {
    drainAgain = true
    return
  }
  drainInFlight = true
  void (async () => {
    try {
      do {
        drainAgain = false
        for (;;) {
          const result = parseToolText<TribeFetchResult>(await daemon?.call("tribe.fetch", { limit: 500 }))
          const events = result?.events ?? []
          for (const event of events) forwardFetchedEvent(event)
          if (events.length < 500) break
        }
      } while (drainAgain)
    } catch (err) {
      log.warn?.(`Failed to drain tribe inbox after wakeup: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      drainInFlight = false
      if (drainAgain) drainDaemonInbox()
    }
  })()
}

// Forward daemon notifications to Claude Code. Registered once the
// background daemon connect resolves; handlers persist across reconnects.
void daemonReady
  .then((d) =>
    d.onNotification((method, params) => {
      if (method === "wakeup") {
        drainDaemonInbox()
        return
      }
      if (method === "channel") {
        const content = String(params?.content ?? "")
        const type = markedType(String(params?.type ?? "notify"))
        // Auto-rename on bead claim by this session
        if (type === "bead:claimed") tryAutoRenameOnClaim(content)
        sendChannel(content, {
          from: String(params?.from ?? "unknown"),
          type,
          bead: params?.bead_id ? String(params.bead_id) : undefined,
          message_id: params?.message_id ? String(params.message_id) : undefined,
        })
      } else if (method === "session.joined" || method === "session.left") {
        const action = method === "session.joined" ? "joined" : "left"
        sendChannel(`${params?.name ?? "unknown"} ${action} the tribe`, { from: "daemon", type: "status" })
      } else if (method === "reload") {
        log.info?.(`Daemon requests reload: ${params?.reason}`)
        timers.setTimeout(() => {
          d.close()
          spawn(process.execPath, process.argv.slice(1), { stdio: "inherit", env: process.env }).on(
            "exit",
            (code: number | null) => process.exit(code ?? 0),
          )
        }, 500)
      }
    }),
  )
  .catch(() => {
    /* daemon never came up — the CallTool handler surfaces this to callers */
  })
