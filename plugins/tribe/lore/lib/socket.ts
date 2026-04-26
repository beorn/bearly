/**
 * Lore socket utilities — re-exports `@bearly/daemon-spine` IPC primitives
 * plus the lore-specific auto-start wrapper.
 *
 * The wire format is shared with the unified tribe daemon (the standalone
 * lore daemon was retired in 2026-04-17 Phase 5c); this module exists so
 * lore-side callers can keep their existing imports while the spine owns
 * the wire/client implementation.
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
// Re-exports from the spine
// ---------------------------------------------------------------------------

export {
  createLineParser,
  isNotification,
  isRequest,
  isResponse,
  makeError,
  makeNotification,
  makeRequest,
  makeResponse,
  withDaemonCall,
} from "@bearly/daemon-spine"

export type {
  DaemonCallOutcome,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "@bearly/daemon-spine"

// ---------------------------------------------------------------------------
// LoreClient — historical alias of the spine's DaemonClient
// ---------------------------------------------------------------------------

export type LoreClient = DaemonClient

// ---------------------------------------------------------------------------
// connectToDaemon — defaults to lore's 30s call timeout (kept as a separate
// wrapper rather than a re-export so callers don't accidentally pick up the
// spine's 10s default).
// ---------------------------------------------------------------------------

const LORE_DEFAULT_CALL_TIMEOUT_MS = 30_000

export function connectToDaemon(socketPath: string, opts?: ConnectToDaemonOpts): Promise<LoreClient> {
  return spineConnectToDaemon(socketPath, {
    callTimeoutMs: opts?.callTimeoutMs ?? LORE_DEFAULT_CALL_TIMEOUT_MS,
  })
}

// ---------------------------------------------------------------------------
// Lore-flavored connectOrStart / createReconnectingClient
//
// km-bear.unified-daemon Phase 5c: the standalone lore daemon is gone.
// Auto-start spawns the unified tribe daemon at tools/tribe-daemon.ts; the
// lore-specific db path is forwarded via `--lore-db <path>`.
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
  onConnect?: (client: LoreClient) => Promise<void>
  onDisconnect?: () => void
  onReconnect?: () => void
  maxAttempts?: number
  callTimeoutMs?: number
  dbPath?: string
}

function defaultDaemonScript(): string {
  // plugins/tribe/lore/lib/socket.ts → tools/tribe-daemon.ts
  return resolve(dirname(new URL(import.meta.url).pathname), "../../../../tools/tribe-daemon.ts")
}

function toSpineOpts(opts?: ConnectOrStartOpts): SpineConnectOrStartOpts {
  return {
    daemonScript: opts?.daemonScript ?? defaultDaemonScript(),
    daemonArgs: opts?.dbPath ? ["--lore-db", opts.dbPath] : undefined,
    callTimeoutMs: opts?.callTimeoutMs ?? LORE_DEFAULT_CALL_TIMEOUT_MS,
    noSpawn: opts?.noSpawn,
    maxStartupAttempts: opts?.maxStartupAttempts,
  }
}

export function connectOrStart(socketPath: string, opts?: ConnectOrStartOpts): Promise<LoreClient> {
  return spineConnectOrStart(socketPath, toSpineOpts(opts))
}

export function createReconnectingClient(opts: ReconnectingClientOpts): Promise<LoreClient> {
  const spineOpts: SpineReconnectingClientOpts = {
    socketPath: opts.socketPath,
    onConnect: opts.onConnect,
    onDisconnect: opts.onDisconnect,
    onReconnect: opts.onReconnect,
    maxAttempts: opts.maxAttempts,
    callTimeoutMs: opts.callTimeoutMs ?? LORE_DEFAULT_CALL_TIMEOUT_MS,
    daemonScript: defaultDaemonScript(),
    daemonArgs: opts.dbPath ? ["--lore-db", opts.dbPath] : undefined,
  }
  return spineCreateReconnectingClient(spineOpts)
}

export type { ConnectToDaemonOpts }
