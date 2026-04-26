/**
 * @bearly/daemon-spine
 *
 * Shared Unix-socket IPC primitives — JSON-RPC 2.0 wire, line parser,
 * daemon client, auto-start, reconnection, and deadline-bounded call.
 *
 * Consumers (tribe daemon, lore plugin, future per-domain daemons) import
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
