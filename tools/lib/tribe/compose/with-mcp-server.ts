/**
 * withMCPServer — native MCP-spec surface on the tribe daemon.
 *
 * Reads the tool registry (`t.tools`) and registers MCP-spec method handlers
 * on the dispatcher (`t.dispatcher.register`). After this factory, the daemon
 * answers `initialize`, `tools/list`, and `tools/call` over its Unix socket
 * directly — the stdio adapter (proxy) becomes a transport bridge instead of
 * an MCP translator.
 *
 * The registry is the single source of truth for callable tools; this factory
 * is the one MCP surface among the many that could consume the same registry
 * (REST, raw JSON-RPC, agent-protocol, etc.).
 *
 * # Tool metadata
 *
 * Registry tools carry `name`, `handler`, and optionally `description` /
 * `schema`. MCP's `tools/list` response shape requires `name` +
 * `inputSchema` (+ optional `description`). When a registry entry doesn't
 * carry rich metadata, the factory looks it up in `opts.metadata` keyed by
 * tool name. Anything missing falls back to `inputSchema: { type: "object" }`
 * — valid MCP, but minimal.
 *
 * # tools/call dispatch — two paths
 *
 * Tools can be invoked two ways:
 *
 * 1. **Via the dispatcher** — every `tribe.*` method has an explicit case in
 *    `with-dispatcher.ts` that already wires up the per-connection
 *    `TribeContext` + `HandlerOpts`. When `opts.dispatch` is provided,
 *    `tools/call` forwards through it — that's the canonical path because it
 *    reuses the dispatcher's existing connection-aware setup.
 * 2. **Via the registry handler directly** — for tools whose registry entry
 *    carries a self-contained handler (no per-connection context needed),
 *    we call `tool.handler(args, ctx)` directly. `opts.buildContext` lets
 *    the daemon plug per-connection state into `ctx.extra` for this path.
 *
 * The factory tries (1) first, then falls back to (2). When neither
 * succeeds, returns an MCP error result.
 *
 * @see hub/composition.md § "Tool registry — the load-bearing decoupling"
 * @see hub/architecture.md § "Tools and surfaces"
 */

import type { BaseTribe } from "./base.ts"
import type { WithDispatcher } from "./with-dispatcher.ts"
import type { WithTools } from "@bearly/tribe-client"

/** MCP `tools/list` entry (matches @modelcontextprotocol/sdk shape). */
export interface McpToolMetadata {
  readonly name: string
  readonly description?: string
  readonly inputSchema: {
    readonly type: "object"
    readonly properties?: Record<string, unknown>
    readonly required?: readonly string[]
  } & Record<string, unknown>
}

/** Minimal capabilities surface — extend if/when the daemon adds resources etc. */
export interface McpServerCapabilities {
  readonly tools?: Record<string, unknown>
  readonly experimental?: Record<string, unknown>
  readonly [key: string]: unknown
}

export interface McpServerInfo {
  readonly name: string
  readonly version: string
}

export interface WithMCPServerOpts {
  /** Server identity for `initialize` response. Defaults to `{ name: "tribe", version: t.daemonVersion }`. */
  serverInfo?: McpServerInfo
  /** Negotiated MCP protocol version. Default: `"2025-03-26"` (MCP SDK default). */
  protocolVersion?: string
  /** `initialize` capabilities object. Default: `{ tools: {} }`. */
  capabilities?: McpServerCapabilities
  /**
   * Optional rich tool metadata (description + inputSchema). Looked up by
   * name when a registry entry lacks `description`/`schema`. Intended for
   * existing TOOLS_LIST migration — registry-native metadata is preferred.
   */
  metadata?: readonly McpToolMetadata[]
  /**
   * Optional `instructions` string surfaced via `initialize` response. Used
   * by clients (Claude Code) to render a behavioral preamble.
   */
  instructions?: string
  /**
   * Bridge protocol-agnostic tool calls to the per-connection state the
   * tribe handlers expect. Called for every `tools/call` (registry path) to
   * populate `ctx.extra`. Returning `undefined` falls back to no `extra`.
   */
  buildContext?: (connId: string, toolName: string) => Record<string, unknown> | undefined
  /**
   * If provided, `tools/call` forwards to the dispatcher's existing
   * JSON-RPC handler (which has the per-connection context already wired
   * up by `with-dispatcher.ts`). The dispatch function takes the tool name
   * and arguments and returns the raw result the handler produced.
   *
   * This is the canonical path for tools (`tribe.*`, lore methods) whose
   * dispatcher cases set up `ctx` and `opts` from the connection. Falls
   * back to direct registry-handler invocation when omitted or when
   * `dispatch` returns `undefined` (signaling the tool isn't dispatcher-
   * mounted).
   */
  dispatch?: (
    toolName: string,
    args: Record<string, unknown>,
    ctx: { connId: string },
  ) => Promise<unknown> | undefined
}

export interface WithMCPServer {
  readonly mcpServer: {
    /** Protocol version negotiated in `initialize`. */
    readonly protocolVersion: string
    /** Server identity reported by `initialize`. */
    readonly serverInfo: McpServerInfo
    /** Tool names currently exposed (snapshot at registration time). */
    readonly toolNames: readonly string[]
  }
}

/** MCP `tools/call` content shape. */
interface McpToolCallResult {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

const DEFAULT_PROTOCOL_VERSION = "2025-03-26"

function buildToolListEntry(
  name: string,
  description: string | undefined,
  schema: unknown,
  metadata: McpToolMetadata | undefined,
): McpToolMetadata {
  // Prefer registry-native metadata; fall back to the passed-in catalog;
  // last resort is a permissive empty-object schema.
  if (description !== undefined && schema !== undefined) {
    return { name, description, inputSchema: schema as McpToolMetadata["inputSchema"] }
  }
  if (metadata) {
    return {
      name,
      description: description ?? metadata.description,
      inputSchema: (schema as McpToolMetadata["inputSchema"] | undefined) ?? metadata.inputSchema,
    }
  }
  return {
    name,
    description,
    inputSchema: (schema as McpToolMetadata["inputSchema"] | undefined) ?? { type: "object" },
  }
}

function isMcpContentResult(value: unknown): value is McpToolCallResult {
  if (value === null || typeof value !== "object") return false
  const v = value as { content?: unknown }
  if (!Array.isArray(v.content)) return false
  return v.content.every(
    (entry): entry is { type: "text"; text: string } =>
      typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "text",
  )
}

export function withMCPServer<T extends BaseTribe & WithDispatcher & WithTools>(
  opts: WithMCPServerOpts = {},
): (t: T) => T & WithMCPServer {
  return (t) => {
    const protocolVersion = opts.protocolVersion ?? DEFAULT_PROTOCOL_VERSION
    const serverInfo: McpServerInfo = opts.serverInfo ?? {
      name: "tribe",
      version: t.daemonVersion,
    }
    const capabilities: McpServerCapabilities = opts.capabilities ?? { tools: {} }
    const metadataByName = new Map<string, McpToolMetadata>(
      (opts.metadata ?? []).map((m) => [m.name, m]),
    )

    // initialize — minimal MCP handshake.
    t.dispatcher.register("initialize", () => {
      return {
        protocolVersion,
        capabilities,
        serverInfo,
        ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}),
      }
    })

    // tools/list — read the registry at call time so late-registered tools
    // (lore tools added after the pipe completes) are visible.
    t.dispatcher.register("tools/list", () => {
      const tools: McpToolMetadata[] = []
      for (const tool of t.tools.values()) {
        tools.push(
          buildToolListEntry(tool.name, tool.description, tool.schema, metadataByName.get(tool.name)),
        )
      }
      return { tools }
    })

    // tools/call — try dispatcher first (per-connection context wired up
    // by with-dispatcher.ts), fall back to direct registry handler.
    t.dispatcher.register("tools/call", async (params, ctx) => {
      const name = String(params.name ?? "")
      const args = (params.arguments as Record<string, unknown> | undefined) ?? {}

      // Path 1: dispatcher-mounted method. dispatch() returns a Promise<unknown>
      // when the method exists, or undefined to signal "not dispatcher-mounted."
      try {
        const dispatchPromise = opts.dispatch?.(name, args, ctx)
        if (dispatchPromise !== undefined) {
          const result = await dispatchPromise
          if (isMcpContentResult(result)) return result
          return { content: [{ type: "text", text: JSON.stringify(result) }] }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        }
      }

      // Path 2: registry handler.
      const tool = t.tools.get(name)
      if (!tool) {
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        }
      }
      const extra = opts.buildContext?.(ctx.connId, name)
      try {
        const result = await tool.handler(args, { connId: ctx.connId, extra })
        if (isMcpContentResult(result)) return result
        return { content: [{ type: "text", text: JSON.stringify(result) }] }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        }
      }
    })

    // Snapshot tool names at registration time for the handle. Late-bound
    // additions to the registry are still served by tools/list (which
    // reads live), but the handle reflects what was visible when withMCPServer
    // was applied.
    const toolNames = Array.from(t.tools.keys())

    return {
      ...t,
      mcpServer: {
        protocolVersion,
        serverInfo,
        toolNames,
      },
    }
  }
}
