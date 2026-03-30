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
import { parseTribeArgs, parseSessionDomains, resolveClaudeSessionId, resolveClaudeSessionName } from "./lib/tribe/config.ts"
import { resolveSocketPath, connectOrStart, type DaemonClient } from "./lib/tribe/socket.ts"
import { TOOLS_LIST } from "./lib/tribe/tools-list.ts"

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const args = parseTribeArgs()
const SOCKET_PATH = resolveSocketPath(args.socket)
const SESSION_NAME = args.name ?? undefined
const SESSION_ROLE = args.role ?? "member"
const SESSION_DOMAINS = parseSessionDomains(args)
const CLAUDE_SESSION_ID = resolveClaudeSessionId()
const CLAUDE_SESSION_NAME = resolveClaudeSessionName()

process.stderr.write(`[tribe-proxy] Connecting to daemon at ${SOCKET_PATH}\n`)

// Connect to daemon (auto-start if not running)
let daemon: DaemonClient
try {
  daemon = await connectOrStart(SOCKET_PATH)
  process.stderr.write(`[tribe-proxy] Connected to daemon\n`)
} catch (err) {
  process.stderr.write(`[tribe-proxy] Failed to connect to daemon: ${err instanceof Error ? err.message : err}\n`)
  process.stderr.write(`[tribe-proxy] Falling back to standalone mode is not supported yet.\n`)
  process.exit(1)
}

// Register with daemon
const registration = await daemon.call("register", {
  name: SESSION_NAME,
  role: SESSION_ROLE,
  domains: SESSION_DOMAINS,
  project: process.cwd(),
  pid: process.pid,
  claudeSessionId: CLAUDE_SESSION_ID,
  claudeSessionName: CLAUDE_SESSION_NAME,
}) as { sessionId: string; name: string; role: string; chief: string }

const myName = registration.name
const myRole = registration.role

process.stderr.write(`[tribe-proxy] Registered as ${myName} (${myRole})\n`)

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

Message format rules:
- Keep messages SHORT — 1-3 lines max. No essays.
- Use plain text only — no markdown (**bold**, headers, bullets). It renders as ugly escaped text.
- Batch-acknowledge: if you receive many messages at once, one summary covers all.`

const memberInstructions = `Messages from other Claude Code sessions arrive as <channel source="tribe" from="..." type="..." bead="...">.

You are a tribe member — a worker session coordinated by the chief.

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

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS_LIST }))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: toolArgs } = req.params
  const a = (toolArgs ?? {}) as Record<string, unknown>

  try {
    const result = await daemon.call(name, a)
    return result as { content: Array<{ type: string; text: string }> }
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : err}` }],
    }
  }
})

// ---------------------------------------------------------------------------
// Notifications — receive from daemon, forward to Claude Code
// ---------------------------------------------------------------------------

daemon.onNotification((method, params) => {
  if (method === "channel") {
    // Forward tribe channel notification to Claude Code
    mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: String(params?.content ?? ""),
        meta: {
          from: String(params?.from ?? "unknown"),
          type: String(params?.type ?? "notify"),
          bead: params?.bead_id ? String(params.bead_id) : undefined,
          message_id: params?.message_id ? String(params.message_id) : undefined,
        },
      },
    }).catch(() => {
      // MCP notification failed — Claude Code may have disconnected
    })
  } else if (method === "session.joined" || method === "session.left") {
    // Optionally notify about session changes
    const name = params?.name ?? "unknown"
    const action = method === "session.joined" ? "joined" : "left"
    mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: `${name} ${action} the tribe`,
        meta: { from: "daemon", type: "status" },
      },
    }).catch(() => {})
  } else if (method === "reload") {
    process.stderr.write(`[tribe-proxy] Daemon requests reload: ${params?.reason}\n`)
    // Re-exec proxy to pick up code changes
    setTimeout(() => {
      daemon.close()
      const { spawn } = require("node:child_process")
      const child = spawn(process.execPath, process.argv.slice(1), {
        stdio: "inherit",
        env: process.env,
      })
      child.on("exit", (code: number | null) => process.exit(code ?? 0))
    }, 500)
  }
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Reconnect on daemon disconnect
daemon.socket.on("close", () => {
  process.stderr.write(`[tribe-proxy] Daemon connection lost. Exiting.\n`)
  process.exit(1)
})

process.on("SIGINT", () => {
  daemon.close()
  process.exit(0)
})
process.on("SIGTERM", () => {
  daemon.close()
  process.exit(0)
})

// Connect MCP to Claude Code
await mcp.connect(new StdioServerTransport())
