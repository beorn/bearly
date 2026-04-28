/**
 * Tribe socket utilities — re-exports the shared `@bearly/tribe-client` IPC
 * primitives plus tribe-specific constants and the auto-start wrapper that
 * defaults to spawning `tools/tribe-daemon.ts`.
 *
 * The wire protocol, line parser, client, and reconnection logic live in
 * `@bearly/tribe-client`; this module is now a thin tribe-flavored facade.
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
} from "@bearly/tribe-client"

// ---------------------------------------------------------------------------
// Protocol version (tribe-specific)
// ---------------------------------------------------------------------------

/**
 * Wire-protocol version. Bump on any payload-shape change a client cares about.
 * v4 (current) carries channel notifications with `pluginKind` only — the
 * per-event reply hint is derived at delivery time, not pushed on the wire.
 * RPCs: `tribe.send` / `tribe.broadcast` / `tribe.members` / `tribe.history` /
 * `tribe.rename` / `tribe.health` / `tribe.join` / `tribe.reload` /
 * `tribe.retro` / `tribe.chief` / `tribe.claim-chief` / `tribe.release-chief` /
 * `tribe.debug` / `tribe.inbox` / `tribe.filter`. See plugins/tribe/CHANGELOG.md
 * for the full history (v3 → v4 was the filter-collapse breaking change).
 *
 * 0.14.0 added two OPTIONAL fields on `assign`-typed channel envelopes —
 * `bead_state` (fresh snapshot from `.beads/backup/issues.jsonl`) and
 * `reissue_count`. Purely additive: pre-0.14 clients ignore them. No protocol
 * bump (v4 unchanged). See km-tribe.task-assignment-stale-snapshot.
 */
export const TRIBE_PROTOCOL_VERSION = 4

// ---------------------------------------------------------------------------
// Re-exports from @bearly/tribe-client
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
} from "@bearly/tribe-client"

export type {
  DaemonClient,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "@bearly/tribe-client"

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
