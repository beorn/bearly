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
} from "./lib/tribe/config.ts"
import { resolveSocketPath, createReconnectingClient, type DaemonClient } from "./lib/tribe/socket.ts"
import { TOOLS_LIST } from "./lib/tribe/tools-list.ts"
import { createLogger } from "loggily"

const log = createLogger("tribe:proxy")

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

const registerParams = {
  ...(args.name ? { name: args.name } : {}),
  ...(args.role ? { role: args.role } : {}),
  domains: SESSION_DOMAINS,
  project: process.cwd(),
  pid: process.pid,
  claudeSessionId: CLAUDE_SESSION_ID,
  claudeSessionName: CLAUDE_SESSION_NAME,
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
    log.warn?.(`Daemon connection lost`)
  },
  onReconnect() {
    log.info?.(`Reconnected to daemon`)
  },
})

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const joinInstruction = `If you receive a tribe-proxy auto-identify message, just call tribe_join with a short name for your focus area and role="member". Do not use "chief" unless explicitly told. No need to call tribe_sessions or tribe_history afterward — just join silently and continue.`

const chiefInstructions = `Messages from other Claude Code sessions arrive as <channel source="tribe" from="..." type="..." bead="...">.

You are the chief of a tribe — a coordinator for multiple Claude Code sessions working on the same project.

${joinInstruction}

Coordination protocol:
- Use tribe_sessions() to see who's online and their domains
- Use tribe_send(to, message, type) to assign work, answer queries, or approve requests
- Use tribe_broadcast(message) to announce changes that affect everyone
- Use tribe_health() to check for silent members or conflicts

Message format rules:
- Keep messages SHORT — 1-3 lines max. No essays.
- Use plain text only — no markdown (**bold**, headers, bullets). It renders as ugly escaped text.
- Batch-acknowledge: if you receive many messages at once, one summary covers all.`

const memberInstructions = `Messages from other Claude Code sessions arrive as <channel source="tribe" from="..." type="..." bead="...">.

You are a tribe member — a worker session coordinated by the chief.

${joinInstruction}

Coordination protocol:
- When you claim a bead, send a status to chief
- When you commit a fix, send a status to chief with the commit hash
- When you're blocked, send a status to chief immediately — include what would unblock you
- Before editing vendor/ or shared files, send a request to chief asking for OK
- Respond to query messages promptly

Message format rules:
- Keep messages SHORT — 1-3 lines max. No essays.
- Use plain text only — no markdown (**bold**, headers, bullets). It renders as ugly escaped text.
- Batch-acknowledge stale messages: "Acknowledged N old messages, no action needed"

Don't over-communicate — only send messages when it changes what someone else should do.`

const mcp = new Server(
  { name: "tribe", version: "0.2.0" },
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
mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  // Nudge on tools discovery (fires on session init/resume)
  if (!nudgeSent && (myName.startsWith("member-") || myName.startsWith("pending-"))) {
    nudgeSent = true
    setTimeout(() => {
      sendChannel(
        `Auto-identify: call tribe_join(name="${myName}", role="member") with a short name for your focus area. Do not use "chief". Do not call tribe_sessions or tribe_history — just join silently and continue.`,
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
    const result = await daemon.call(name, a)
    // Update local name/role after join/rename
    if (name === "tribe_join" || name === "tribe_rename") {
      const r = result as { content: Array<{ type: string; text: string }> }
      try {
        const data = JSON.parse(r.content[0]?.text ?? "{}") as Record<string, string>
        if (data.name) myName = data.name
        if (data.role) myRole = data.role
      } catch {
        /* parse error, ignore */
      }
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

/** Forward a channel notification to Claude Code */
function sendChannel(content: string, meta: Record<string, string | undefined>): void {
  mcp.notification({ method: "notifications/claude/channel", params: { content, meta } }).catch(() => {})
}

const shutdown = () => { daemon.close(); process.exit(0) }
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

// Connect MCP to Claude Code
await mcp.connect(new StdioServerTransport())

// Forward daemon notifications to Claude Code
daemon.onNotification((method, params) => {
  if (method === "channel") {
    sendChannel(String(params?.content ?? ""), {
      from: String(params?.from ?? "unknown"),
      type: String(params?.type ?? "notify"),
      bead: params?.bead_id ? String(params.bead_id) : undefined,
      message_id: params?.message_id ? String(params.message_id) : undefined,
    })
  } else if (method === "session.joined" || method === "session.left") {
    const action = method === "session.joined" ? "joined" : "left"
    sendChannel(`${params?.name ?? "unknown"} ${action} the tribe`, { from: "daemon", type: "status" })
  } else if (method === "reload") {
    log.info?.(`Daemon requests reload: ${params?.reason}`)
    setTimeout(() => {
      daemon.close()
      const { spawn: sp } = require("node:child_process")
      sp(process.execPath, process.argv.slice(1), { stdio: "inherit", env: process.env })
        .on("exit", (code: number | null) => process.exit(code ?? 0))
    }, 500)
  }
})
