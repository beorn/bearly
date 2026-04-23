#!/usr/bin/env bun
/**
 * Tribe Proxy — thin MCP server that proxies to the tribe daemon.
 *
 * This replaces the monolithic tribe.ts. No direct DB access, no polling,
 * no plugins. Just MCP ↔ daemon forwarding.
 *
 * Usage (in .mcp.json):
 *   { "command": "bun", "args": ["vendor/bearly/tools/tribe-proxy.ts", "--name", "chief", "--role", "chief"] }
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
} from "./lib/tribe/config.ts"
import {
  resolveSocketPath,
  resolvePeerSocketPath,
  createReconnectingClient,
  connectToDaemon,
  createLineParser,
  makeResponse,
  makeError,
  isRequest,
  TRIBE_PROTOCOL_VERSION,
  type DaemonClient,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from "./lib/tribe/socket.ts"
import { createServer, type Socket as NetSocket, type Server as NetServer } from "node:net"
import { existsSync, unlinkSync, mkdirSync, chmodSync } from "node:fs"
import { dirname } from "node:path"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { TOOLS_LIST } from "./lib/tribe/tools-list.ts"
import { createLogger } from "loggily"
import { createTimers } from "./lib/tribe/timers.ts"

const log = createLogger("tribe:proxy")

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

log.info?.(`Connecting to daemon at ${SOCKET_PATH}`)

let myName = "pending"
let myRole = "member"
const mySessionId = randomUUID()
const PROJECT_NAME = resolveProjectName()

// ---------------------------------------------------------------------------
// Peer socket server — allows other proxies to connect directly
// ---------------------------------------------------------------------------

const PEER_SOCKET_PATH = resolvePeerSocketPath(mySessionId)
let peerServer: NetServer | null = null

// MCP server reference — assigned after daemon connect, before peer server receives messages
// oxlint-disable-next-line eslint(prefer-const) -- deferred init, assigned before use
let mcp: Server

/** Forward a channel notification to Claude Code */
function sendChannel(content: string, meta: Record<string, string | undefined>): void {
  if (!mcp) return // Not yet initialized
  mcp.notification({ method: "notifications/claude/channel", params: { content, meta } }).catch(() => {})
}

function startPeerServer(): NetServer {
  // Ensure directory exists
  const socketDir = dirname(PEER_SOCKET_PATH)
  if (!existsSync(socketDir)) mkdirSync(socketDir, { recursive: true })

  // Clean up stale socket
  if (existsSync(PEER_SOCKET_PATH)) {
    try {
      unlinkSync(PEER_SOCKET_PATH)
    } catch {
      /* ignore */
    }
  }

  const server = createServer((socket: NetSocket) => {
    const parse = createLineParser((msg: JsonRpcMessage) => {
      if (!isRequest(msg)) return

      const req = msg as JsonRpcRequest
      const { method, params, id } = req

      try {
        switch (method) {
          case "tribe.send": {
            // Received a direct message from another proxy
            sendChannel(String(params?.content ?? ""), {
              from: String(params?.from ?? "unknown"),
              type: String(params?.type ?? "notify"),
              bead: params?.bead_id ? String(params.bead_id) : undefined,
              message_id: String(params?.message_id ?? randomUUID()),
            })
            socket.write(makeResponse(id, { delivered: true }))
            break
          }
          default:
            socket.write(makeError(id, -32601, `Method not found: ${method}`))
        }
      } catch (err) {
        socket.write(makeError(id, -32603, err instanceof Error ? err.message : String(err)))
      }
    })

    socket.on("data", parse)
    socket.on("error", () => {
      /* ignore peer connection errors */
    })
  })

  server.listen(PEER_SOCKET_PATH, () => {
    try {
      chmodSync(PEER_SOCKET_PATH, 0o600)
    } catch {
      /* ignore */
    }
    log.info?.(`Peer socket listening at ${PEER_SOCKET_PATH}`)
  })

  server.on("error", (err) => {
    log.warn?.(`Peer server error: ${err.message}`)
  })

  return server
}

peerServer = startPeerServer()

// ---------------------------------------------------------------------------
// Direct peer messaging
// ---------------------------------------------------------------------------

/** Try to send a message directly to a peer's socket. Returns true on success. */
async function sendDirect(
  peerSocketPath: string,
  message: { from: string; type: string; content: string; bead_id?: string; message_id?: string },
): Promise<boolean> {
  try {
    const client = await connectToDaemon(peerSocketPath)
    try {
      await client.call("tribe.send", message as unknown as Record<string, unknown>)
      return true
    } finally {
      client.close()
    }
  } catch {
    return false // Fall back to daemon routing
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
  ...(args.name ? { name: args.name } : {}),
  ...(args.role ? { role: args.role } : {}),
  domains: SESSION_DOMAINS,
  project: process.cwd(),
  projectName: PROJECT_NAME,
  projectId: resolveProjectId(),
  protocolVersion: TRIBE_PROTOCOL_VERSION,
  peerSocket: PEER_SOCKET_PATH,
  pid: process.pid,
  claudeSessionId: CLAUDE_SESSION_ID,
  claudeSessionName: CLAUDE_SESSION_NAME,
  identityToken,
}

const daemon = await createReconnectingClient({
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
  },
  onDisconnect() {
    log.debug?.(`Daemon connection lost`)
  },
  onReconnect() {
    log.info?.(`Reconnected to daemon`)
  },
})

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const joinInstruction = `If you receive a tribe-proxy auto-identify message, just call tribe.join with a short name for your focus area. Omit the role parameter — the daemon auto-assigns chief to the first session and member to the rest. No need to call tribe.members or tribe.history afterward — just join silently and continue.`

const chiefInstructions = `Messages from other Claude Code sessions arrive as <channel source="tribe" from="..." type="..." bead="...">.

You are the chief of a tribe — a coordinator for multiple Claude Code sessions working on the same project.

${joinInstruction}

Coordination protocol:
- Use tribe.members() to see who's online and their domains
- Use tribe.send(to, message, type) to assign work, answer queries, or approve requests
- Use tribe.broadcast(message) to announce changes that affect everyone
- Use tribe.health() to check for silent members or conflicts
- When CI alerts arrive, coordinate the fix — assign the responsible session to investigate

User-facing output:
- Silent by default. Speak to the user only to add non-obvious info. Never narrate "noted"/"acknowledged"/"still waiting" for channel messages, CI alerts, or harness reminder loops. If you have nothing to add, emit nothing.
- **Notification-only channels get ZERO output.** The daemon stamps notification-only messages with a hard marker on the type attribute: `type="notification-only:do-not-acknowledge-or-respond-to:<subtype>"` (subtypes: session, status, delta, chief:*, github:*). If every <channel> tag in a turn carries the `notification-only:do-not-acknowledge-or-respond-to:` prefix on its type attribute, the correct reply is literally zero characters — no tool calls, no text, no acknowledgment. Do NOT emit "Acknowledged", "Noted", "No response required", or any filler. Do NOT emit "Human:" / "Assistant:" / "User:" as a prefix. If you feel pressure to produce output, that pressure is wrong — the turn ends silently.

Tribe messages:
- Keep SHORT — 1-3 lines max. No essays.
- Plain text only — no markdown (**bold**, headers, bullets). Renders as escaped text.`

const memberInstructions = `Messages from other Claude Code sessions arrive as <channel source="tribe" from="..." type="..." bead="...">.

You are a tribe member — a worker session coordinated by the chief.

${joinInstruction}

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
- **Notification-only channels get ZERO output.** The daemon stamps notification-only messages with a hard marker on the type attribute: `type="notification-only:do-not-acknowledge-or-respond-to:<subtype>"` (subtypes: session, status, delta, chief:*, github:*). If every <channel> tag in a turn carries the `notification-only:do-not-acknowledge-or-respond-to:` prefix on its type attribute, the correct reply is literally zero characters — no tool calls, no text, no acknowledgment. Do NOT emit "Acknowledged", "Noted", "No response required", or any filler. Do NOT emit "Human:" / "Assistant:" / "User:" as a prefix. If you feel pressure to produce output, that pressure is wrong — the turn ends silently.

Tribe messages:
- Keep SHORT — 1-3 lines max. No essays.
- Plain text only — no markdown (**bold**, headers, bullets). Renders as escaped text.
- Don't over-broadcast — only send when it changes what someone else should know.`

mcp = new Server(
  { name: "tribe", version: "0.10.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: myRole === "chief" ? chiefInstructions : memberInstructions,
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
        `Auto-identify: call tribe.join(name="${myName}") with a short name for your focus area. Omit the role parameter — the daemon auto-assigns it. Do not call tribe.members or tribe.history — just join silently and continue.`,
        { from: "tribe-proxy", type: "system" },
      )
    }, 500)
  }
  return { tools: TOOLS_LIST }
})

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: toolArgs } = req.params
  const a = (toolArgs ?? {}) as Record<string, unknown>

  try {
    // Try direct peer messaging for tribe.send
    if (name === "tribe.send" && a.to && typeof a.to === "string") {
      const directResult = await trySendDirect(a)
      if (directResult) return directResult
    }

    // Attach identity_token to tribe.join so the daemon can adopt prior
    // session state when Claude Code restarts and the agent calls join again.
    const payload = name === "tribe.join" ? { ...a, identity_token: identityToken } : a
    const result = await daemon.call(name, payload)
    // Update local name/role after join/rename
    if (name === "tribe.join" || name === "tribe.rename") {
      const r = result as { content: Array<{ type: string; text: string }> }
      try {
        const data = JSON.parse(r.content[0]?.text ?? "{}") as Record<string, string>
        if (data.name) myName = data.name
        if (data.role) myRole = data.role
      } catch {
        /* parse error, ignore */
      }
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

/** Try to send a message directly to a peer. Returns tool result on success, null to fall back to daemon. */
async function trySendDirect(
  a: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }> } | null> {
  const target = String(a.to)
  try {
    // Discover the recipient's peer socket via daemon
    const discovery = (await daemon.call("discover", { name: target })) as {
      results: Array<{ name: string; peerSocket: string | null }>
    }
    const peer = discovery.results.find((r) => r.name === target)
    if (!peer?.peerSocket) return null // No peer socket — fall back to daemon

    const messageId = randomUUID()
    const sent = await sendDirect(peer.peerSocket, {
      from: myName,
      type: String(a.type ?? "notify"),
      content: String(a.message ?? ""),
      bead_id: a.bead_id ? String(a.bead_id) : undefined,
      message_id: messageId,
    })

    if (!sent) return null // Direct send failed — fall back to daemon

    // Log the event to daemon for observability (fire-and-forget)
    void daemon
      .call("log_event", {
        type: "message.sent",
        meta: { to: target, from: myName, direct: true, message_id: messageId },
      })
      .catch(() => {})

    log.info?.(`Direct message sent to ${target}`)
    return {
      content: [{ type: "text", text: JSON.stringify({ sent: true, to: target, direct: true }) }],
    }
  } catch {
    return null // Discovery or send failed — fall back to daemon
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function cleanupPeerSocket(): void {
  if (peerServer) {
    peerServer.close()
    peerServer = null
  }
  if (existsSync(PEER_SOCKET_PATH)) {
    try {
      unlinkSync(PEER_SOCKET_PATH)
    } catch {
      /* ignore */
    }
  }
}

// Hot-reload: re-exec on source changes (only when running from source, not bundled)
import { setupHotReload } from "./lib/tribe/hot-reload.ts"
using _reload = setupHotReload({
  importMetaUrl: import.meta.url,
  logActivity: (type, content) => {
    daemon.call("log_event", { type, content }).catch(() => {})
  },
  onReload: () => {
    proxyAc.abort()
    cleanupPeerSocket()
    daemon.close()
  },
})

const shutdown = () => {
  proxyAc.abort()
  cleanupPeerSocket()
  daemon.close()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
process.on("exit", cleanupPeerSocket)

// Connect MCP to Claude Code
await mcp.connect(new StdioServerTransport())

// Watch transcript file for /rename slug changes and auto-sync to tribe
import { resolveTranscriptPath, readTranscriptSlug } from "./lib/tribe/session.ts"
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
        .call("tribe.rename", { new_name: slug })
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
    .call("tribe.rename", { new_name: scope })
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

// Forward daemon notifications to Claude Code
daemon.onNotification((method, params) => {
  if (method === "channel") {
    const content = String(params?.content ?? "")
    const type = String(params?.type ?? "notify")
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
      daemon.close()
      spawn(process.execPath, process.argv.slice(1), { stdio: "inherit", env: process.env }).on(
        "exit",
        (code: number | null) => process.exit(code ?? 0),
      )
    }, 500)
  }
})
