/**
 * HTTP MCP adapter — local loopback bridge from MCP Streamable HTTP to the
 * tribe daemon Unix-socket protocol.
 *
 * Silvercode uses this for SSH-hosted ACP agents: the agent sees a remote
 * `http://127.0.0.1:<port>/mcp` MCP server, while SSH forwards that remote
 * loopback port back to this local process. No tribe socket, daemon, bunx, or
 * npx needs to exist on the SSH host.
 */

import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { createHash, randomUUID } from "node:crypto"
import { TOOLS_LIST } from "./lib/tools-list.ts"
import { resolveSocketPath, createReconnectingClient, TRIBE_PROTOCOL_VERSION, type DaemonClient } from "./lib/socket.ts"

export type TribeHttpMcpServer = {
  readonly port: number
  readonly url: string
  close(): void
}

export type StartTribeHttpMcpServerOptions = {
  readonly port?: number
  readonly socketPath?: string
  readonly name?: string
  readonly role?: string
  readonly domains?: readonly string[]
  readonly delivery?: "push" | "pull"
  readonly project?: string
  readonly projectName?: string
  readonly projectId?: string
  readonly requireJoin?: boolean
}

export async function startTribeHttpMcpServer(opts: StartTribeHttpMcpServerOptions = {}): Promise<TribeHttpMcpServer> {
  const socketPath = resolveSocketPath(opts.socketPath)
  const requireJoin = opts.requireJoin !== false
  const delivery = opts.delivery ?? "pull"
  const sessionId = randomUUID()
  let myName = "pending"
  let myRole = opts.role ?? "member"
  const identityToken = createHash("sha256")
    .update(`${sessionId}|${opts.project ?? process.cwd()}|${myRole}`)
    .digest("hex")
    .slice(0, 16)

  const daemon = await createReconnectingClient({
    socketPath,
    maxAttempts: 30,
    async onConnect(client) {
      const reg = (await client.call("register", {
        ...(opts.name && !requireJoin ? { name: opts.name } : {}),
        role: myRole,
        domains: [...(opts.domains ?? [])],
        project: opts.project ?? process.cwd(),
        projectName: opts.projectName ?? process.cwd().split("/").pop() ?? "silvercode",
        projectId: opts.projectId,
        protocolVersion: TRIBE_PROTOCOL_VERSION,
        peerSocket: null,
        pid: process.pid,
        identityToken,
        delivery: requireJoin ? "pull" : delivery,
      })) as { name?: string; role?: string }
      if (reg.name) myName = reg.name
      if (reg.role) myRole = reg.role
    },
  })

  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/health") return Response.json({ ok: true, name: myName })
      if (url.pathname !== "/mcp") return new Response("not found", { status: 404 })

      const mcp = createMcpServer({
        daemon,
        identityToken,
        defaultDelivery: delivery,
        getName: () => myName,
        setName: (name) => {
          myName = name
        },
        setRole: (role) => {
          myRole = role
        },
      })
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      await mcp.connect(transport)
      const response = await transport.handleRequest(req)
      await mcp.close()
      return response
    },
  })

  const port = http.port
  if (port === undefined) throw new Error("tribe HTTP MCP bridge failed to bind a loopback port")

  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    close() {
      http.stop(true)
      daemon.close()
    },
  }
}

function createMcpServer(opts: {
  readonly daemon: DaemonClient
  readonly identityToken: string
  readonly defaultDelivery: "push" | "pull"
  readonly getName: () => string
  readonly setName: (name: string) => void
  readonly setRole: (role: string) => void
}): McpServer {
  const mcp = new McpServer(
    { name: "tribe", version: "0.14.1" },
    {
      capabilities: { tools: {} },
      instructions:
        "Tribe coordination is available through MCP tools. Call tribe.join(name, delivery) before relying on tribe notifications or inbox routing.",
    },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS_LIST }))
  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: toolArgs } = req.params
    const a = (toolArgs ?? {}) as Record<string, unknown>
    const payload = name === "join" ? { delivery: opts.defaultDelivery, ...a, identity_token: opts.identityToken } : a
    try {
      const result = await opts.daemon.call(`tribe.${name}`, payload)
      if (name === "join" || name === "rename") {
        const r = result as { content?: Array<{ text?: string }> }
        try {
          const data = JSON.parse(r.content?.[0]?.text ?? "{}") as { name?: string; role?: string }
          if (data.name) opts.setName(data.name)
          if (data.role) opts.setRole(data.role)
        } catch {
          /* ignore malformed daemon response */
        }
      }
      return result as { content: Array<{ type: string; text: string }> }
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }] }
    }
  })

  return mcp
}
