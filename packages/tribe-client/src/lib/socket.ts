/**
 * Tribe socket utilities — tribe-flavored facade on top of the package's IPC
 * primitives. Adds the tribe-specific protocol version and `probeDaemonPid`
 * helper, plus a `createReconnectingClient` wrapper that resolves a default
 * daemon script path for monorepo dev.
 *
 * The wire protocol, line parser, client, and reconnection logic live in
 * the surrounding tribe-client package; this module just adds the
 * tribe-flavored ergonomics.
 */

import { dirname, resolve } from "node:path"
import {
  connectOrStart as clientConnectOrStart,
  connectToDaemon as clientConnectToDaemon,
  createReconnectingClient as clientCreateReconnectingClient,
  type ConnectOrStartOpts as ClientConnectOrStartOpts,
  type ConnectToDaemonOpts,
  type DaemonClient,
  type ReconnectingClientOpts as ClientReconnectingClientOpts,
} from "../client.ts"

// ---------------------------------------------------------------------------
// Protocol version (tribe-specific)
// ---------------------------------------------------------------------------

/**
 * Wire-protocol version. Bump on any payload-shape change a client cares about.
 * v5 (current) carries channel notifications with `topic`; the
 * per-event reply hint is derived at delivery time, not pushed on the wire.
 * RPCs: `tribe.send` / `tribe.fetch` / `tribe.members` / `tribe.filter` /
 * `tribe.rename` / `tribe.health` / `tribe.join` / `tribe.reload` /
 * `tribe.retro` / `tribe.chief` / `tribe.claim-chief` / `tribe.release-chief` /
 * `tribe.debug`. See plugins/tribe/CHANGELOG.md for the full history.
 *
 * 0.14.0 added two OPTIONAL fields on `assign`-typed channel envelopes —
 * `bead_state` (fresh snapshot from `.beads/backup/issues.jsonl`) and
 * `reissue_count`. Purely additive: pre-0.14 clients ignore them. No protocol
 * bump then (v4 unchanged). See km-tribe.task-assignment-stale-snapshot.
 */
export const TRIBE_PROTOCOL_VERSION = 5

// ---------------------------------------------------------------------------
// Re-exports from the surrounding tribe-client package
// ---------------------------------------------------------------------------

export { connectToDaemon, isSocketAlive } from "../client.ts"
export { createLineParser } from "../parser.ts"
export {
  isNotification,
  isRequest,
  isResponse,
  makeError,
  makeNotification,
  makeRequest,
  makeResponse,
} from "../rpc.ts"
export { resolvePeerSocketPath, resolveSocketPath } from "../paths.ts"

export type { DaemonClient } from "../client.ts"
export type { JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "../rpc.ts"

// ---------------------------------------------------------------------------
// Tribe-flavored connectOrStart / createReconnectingClient
//
// These wrap the spine versions so callers don't need to know about the
// tribe-daemon.ts script path. Behavior matches the legacy implementation:
// `--db <dbPath>` is appended after `--socket <socketPath>` when provided.
// ---------------------------------------------------------------------------

export type ConnectOrStartOpts = {
  daemonScript?: string
  dbPath?: string
  callTimeoutMs?: number
  noSpawn?: boolean
  maxStartupAttempts?: number
}

export type ReconnectingClientOpts = {
  socketPath: string
  onConnect: (client: DaemonClient) => Promise<void>
  onDisconnect?: () => void
  onReconnect?: () => void
  maxAttempts?: number
  callTimeoutMs?: number
  dbPath?: string
}

function defaultDaemonScript(): string {
  if (process.env.TRIBE_DAEMON_SCRIPT) return process.env.TRIBE_DAEMON_SCRIPT
  // Monorepo dev fallback: packages/tribe-client/src/lib/socket.ts → tools/tribe-daemon.ts
  return resolve(dirname(new URL(import.meta.url).pathname), "../../../../tools/tribe-daemon.ts")
}

function toClientOpts(opts?: ConnectOrStartOpts): ClientConnectOrStartOpts {
  return {
    daemonScript: opts?.daemonScript ?? defaultDaemonScript(),
    daemonArgs: opts?.dbPath ? ["--db", opts.dbPath] : undefined,
    callTimeoutMs: opts?.callTimeoutMs,
    noSpawn: opts?.noSpawn,
    maxStartupAttempts: opts?.maxStartupAttempts,
  }
}

export function connectOrStart(socketPath: string, opts?: ConnectOrStartOpts): Promise<DaemonClient> {
  return clientConnectOrStart(socketPath, toClientOpts(opts))
}

export function createReconnectingClient(opts: ReconnectingClientOpts): Promise<DaemonClient> {
  const clientOpts: ClientReconnectingClientOpts = {
    socketPath: opts.socketPath,
    onConnect: opts.onConnect,
    onDisconnect: opts.onDisconnect,
    onReconnect: opts.onReconnect,
    maxAttempts: opts.maxAttempts,
    callTimeoutMs: opts.callTimeoutMs,
    daemonScript: defaultDaemonScript(),
    daemonArgs: opts.dbPath ? ["--db", opts.dbPath] : undefined,
  }
  return clientCreateReconnectingClient(clientOpts)
}

// ---------------------------------------------------------------------------
// Liveness probe (tribe-specific: speaks `cli_daemon` to grab the PID)
// ---------------------------------------------------------------------------

/**
 * Probe the daemon's liveness by connecting to its socket and asking for its PID.
 * Replaces the old pidfile-based check: if a client can open + speak to the
 * socket, the daemon is alive (kernel owns the liveness proof — no on-disk
 * state to go stale). Returns the daemon's own PID, or null if not reachable.
 */
export async function probeDaemonPid(socketPath: string): Promise<number | null> {
  let client: DaemonClient
  try {
    client = await clientConnectToDaemon(socketPath)
  } catch {
    return null
  }
  try {
    const result = (await client.call("cli_daemon")) as { pid?: number }
    return typeof result.pid === "number" ? result.pid : null
  } catch {
    return null
  } finally {
    try {
      client.close()
    } catch {
      /* ignore */
    }
  }
}

// Re-export the per-call options type so existing tribe callers that reach
// for `ConnectToDaemonOpts` keep working.
export type { ConnectToDaemonOpts }
