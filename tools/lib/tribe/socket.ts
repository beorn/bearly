/**
 * Tribe socket utilities — re-exports the shared `@bearly/daemon-spine` IPC
 * primitives plus tribe-specific constants and the auto-start wrapper that
 * defaults to spawning `tools/tribe-daemon.ts`.
 *
 * The wire protocol, line parser, client, and reconnection logic live in
 * the spine package; this module is now a thin tribe-flavored facade.
 */

import { dirname, resolve } from "node:path"
import {
  connectOrStart as spineConnectOrStart,
  connectToDaemon as spineConnectToDaemon,
  createReconnectingClient as spineCreateReconnectingClient,
  type ConnectOrStartOpts as SpineConnectOrStartOpts,
  type ConnectToDaemonOpts,
  type DaemonClient,
  type ReconnectingClientOpts as SpineReconnectingClientOpts,
} from "@bearly/daemon-spine"

// ---------------------------------------------------------------------------
// Protocol version (tribe-specific)
// ---------------------------------------------------------------------------

export const TRIBE_PROTOCOL_VERSION = 2

// ---------------------------------------------------------------------------
// Re-exports from the spine
// ---------------------------------------------------------------------------

export {
  connectToDaemon,
  createLineParser,
  isNotification,
  isRequest,
  isResponse,
  isSocketAlive,
  makeError,
  makeNotification,
  makeRequest,
  makeResponse,
  resolvePeerSocketPath,
  resolveSocketPath,
} from "@bearly/daemon-spine"

export type {
  DaemonClient,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "@bearly/daemon-spine"

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
  // tools/lib/tribe/socket.ts → tools/tribe-daemon.ts (../../tribe-daemon.ts)
  return resolve(dirname(new URL(import.meta.url).pathname), "../../tribe-daemon.ts")
}

function toSpineOpts(opts?: ConnectOrStartOpts): SpineConnectOrStartOpts {
  return {
    daemonScript: opts?.daemonScript ?? defaultDaemonScript(),
    daemonArgs: opts?.dbPath ? ["--db", opts.dbPath] : undefined,
    callTimeoutMs: opts?.callTimeoutMs,
    noSpawn: opts?.noSpawn,
    maxStartupAttempts: opts?.maxStartupAttempts,
  }
}

export function connectOrStart(socketPath: string, opts?: ConnectOrStartOpts): Promise<DaemonClient> {
  return spineConnectOrStart(socketPath, toSpineOpts(opts))
}

export function createReconnectingClient(opts: ReconnectingClientOpts): Promise<DaemonClient> {
  const spineOpts: SpineReconnectingClientOpts = {
    socketPath: opts.socketPath,
    onConnect: opts.onConnect,
    onDisconnect: opts.onDisconnect,
    onReconnect: opts.onReconnect,
    maxAttempts: opts.maxAttempts,
    callTimeoutMs: opts.callTimeoutMs,
    daemonScript: defaultDaemonScript(),
    daemonArgs: opts.dbPath ? ["--db", opts.dbPath] : undefined,
  }
  return spineCreateReconnectingClient(spineOpts)
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
    client = await spineConnectToDaemon(socketPath)
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

// Re-export the spine's per-call options type so existing tribe callers that
// reach for `ConnectToDaemonOpts` keep working.
export type { ConnectToDaemonOpts }
