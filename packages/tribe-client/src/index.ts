/**
 * @bearly/tribe-client
 *
 * Tribe client library — Unix-socket IPC primitives, JSON-RPC 2.0 wire
 * protocol, line parser, daemon client, auto-start, reconnection,
 * deadline-bounded call, and composition primitives (pipe, Scope, tool
 * registry).
 *
 * Consumers (tribe daemon, lore plugin, MCP proxy, agent shells) import
 * from here instead of duplicating the wire protocol per package.
 */

// JSON-RPC wire protocol
export type { JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./rpc.ts"
export { isNotification, isRequest, isResponse, makeError, makeNotification, makeRequest, makeResponse } from "./rpc.ts"

// Line-delimited JSON parser
export { createLineParser } from "./parser.ts"

// Daemon client
export type { ConnectOrStartOpts, ConnectToDaemonOpts, DaemonClient, ReconnectingClientOpts } from "./client.ts"
export { connectOrStart, connectToDaemon, createReconnectingClient, isSocketAlive } from "./client.ts"

// Deadline-bounded call (hook-friendly)
export type { DaemonCallOutcome, WithDaemonCallOpts } from "./util.ts"
export { withDaemonCall } from "./util.ts"

// Socket path discovery
export { resolvePeerSocketPath, resolveSocketPath } from "./paths.ts"

// Composition — pipe + Scope + tool registry. See `hub/composition.md`.
export type { Plugin, Tool, ToolContext, ToolHandler, ToolRegistry, WithTools } from "./composition/index.ts"
export { Scope, createScope, disposable, pipe, withTool, withTools } from "./composition/index.ts"
