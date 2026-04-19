/**
 * Tribe autostart — probe-and-spawn helpers for zero-ceremony daemon lifecycle.
 *
 * Pairs with the daemon's own idle `--quit-timeout` exit: the daemon quits
 * itself when unused, this module spawns it back on first demand. Net effect
 * for the user: no lifecycle ceremony at all.
 *
 * The exported helpers are written so the orchestration function
 * (`ensureTribeDaemonIfConfigured`) is pure side-effect-free given its deps —
 * tests inject `spawn`/`probe` implementations rather than stubbing globals.
 *
 * Hard rule: none of this may ever block a Claude Code hook. The whole
 * end-to-end budget is ~300ms; probe failures and spawn failures are
 * swallowed with a single stderr line, and the hook proceeds to its library
 * fallback.
 *
 * km-bear.unified-daemon Phase 5c: the standalone lore daemon was deleted.
 * There is now a single daemon — the tribe daemon — that hosts both the
 * coordination and memory RPC surfaces. The legacy export names
 * (`ensureDaemonIfConfigured`, `ensureAllDaemonsIfConfigured`, ...) are kept
 * as aliases so external callers (e.g. the lore MCP proxy) don't break, but
 * they all resolve to the tribe-daemon path.
 */

import { createConnection } from "node:net"
import { existsSync, unlinkSync } from "node:fs"
import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import { resolveAutostart, type TribeAutostart } from "./autostart-config.ts"
import { resolveSocketPath as resolveTribeSocketPath } from "./socket.ts"

// ---------------------------------------------------------------------------
// Daemon liveness probe
// ---------------------------------------------------------------------------

export type DaemonProbeResult = "alive" | "dead" | "stale-socket"

/**
 * Attempt to connect to the daemon's Unix socket with a short timeout. Returns
 * `"alive"` on successful connect, `"dead"` when the socket file is absent or
 * refuses connections, `"stale-socket"` when the file exists but connect
 * fails.
 *
 * Stale sockets are cleaned up here — a leftover file from a previous daemon
 * that crashed without unlinking would otherwise block a fresh daemon from
 * binding.
 */
export function isDaemonAlive(socketPath: string, timeoutMs = 200): Promise<boolean> {
  return new Promise((resolveFn) => {
    // If the file doesn't exist, the daemon is definitely dead — no probe needed.
    if (!existsSync(socketPath)) {
      resolveFn(false)
      return
    }

    const socket = createConnection(socketPath)
    let done = false

    const finish = (alive: boolean) => {
      if (done) return
      done = true
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
      clearTimeout(timer)
      if (!alive) cleanupStaleSocket(socketPath)
      resolveFn(alive)
    }

    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}

function cleanupStaleSocket(socketPath: string): void {
  // Only unlink if there's no live listener — isDaemonAlive already confirmed
  // that. We still guard with existsSync in case two probes race.
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath)
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Detached spawn
// ---------------------------------------------------------------------------

/** Location of the tribe coordination daemon script (relative to this file). */
export function resolveTribeDaemonScriptPath(): string {
  // tools/lib/tribe/autostart.ts → tools/tribe-daemon.ts
  const thisDir = dirname(new URL(import.meta.url).pathname)
  const bearlyRoot = resolve(thisDir, "..", "..", "..")
  return resolve(bearlyRoot, "tools/tribe-daemon.ts")
}

/**
 * Legacy alias — pre-Phase-5c callers expected a lore-specific daemon script.
 * The unified daemon hosts both surfaces, so this resolves to the tribe
 * daemon script. Kept for the autostart-config/install tests that still
 * reference it; remove once those are rewritten.
 */
export function resolveDaemonScriptPath(): string {
  return resolveTribeDaemonScriptPath()
}

export type SpawnResult = { ok: true; pid: number } | { ok: false; error: string }

/**
 * Spawn the tribe daemon as a detached, unref'd child. Stdout/stderr are
 * discarded. Returns the child PID on success, an error on failure. Never
 * throws.
 *
 * The spawn is fire-and-forget: we don't wait for the socket to be ready.
 * Hook dispatch proceeds to the library fallback for this one turn, and
 * later hooks find a live daemon. This is the whole point of "zero ceremony".
 */
export function spawnTribeDaemonDetached(
  opts: {
    socketPath?: string
    bunPath?: string
    scriptPath?: string
    label?: string
    log?: (msg: string) => void
  } = {},
): SpawnResult {
  const scriptPath = opts.scriptPath ?? resolveTribeDaemonScriptPath()
  const bunPath = opts.bunPath ?? process.execPath
  const label = opts.label ?? "tribe"
  const args = [scriptPath]
  if (opts.socketPath) args.push("--socket", opts.socketPath)

  try {
    const child = spawn(bunPath, args, {
      detached: true,
      stdio: "ignore",
      env: process.env,
    })
    child.unref()
    const pid = child.pid
    if (typeof pid !== "number") {
      return { ok: false, error: "spawn returned no pid" }
    }
    const logFn = opts.log ?? defaultLog
    logFn(`[tribe] spawned ${label} daemon (pid=${pid})`)
    return { ok: true, pid }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const logFn = opts.log ?? defaultLog
    logFn(`[tribe] ${label} daemon spawn failed: ${msg}`)
    return { ok: false, error: msg }
  }
}

/**
 * Legacy alias — callers that asked for `spawnDaemonDetached` (lore-specific)
 * now get the unified tribe daemon. Kept so external imports don't break.
 */
export const spawnDaemonDetached = spawnTribeDaemonDetached

function defaultLog(msg: string): void {
  try {
    process.stderr.write(`${msg}\n`)
  } catch {
    /* ignore — must never crash the hook */
  }
}

// ---------------------------------------------------------------------------
// Orchestration — "if configured and daemon dead, spawn"
// ---------------------------------------------------------------------------

export type EnsureDaemonDeps = {
  /** Override the config lookup (test hook). */
  resolveMode?: () => TribeAutostart
  /** Override the socket-path resolver (test hook). */
  resolveSocketPath?: () => string
  /** Override the liveness probe (test hook). */
  probe?: (socketPath: string) => Promise<boolean>
  /** Override the spawner (test hook). */
  spawn?: (opts: { socketPath: string }) => SpawnResult
  /** Override the logger (test hook). */
  log?: (msg: string) => void
  /** Hard overall budget in ms (default 300ms). */
  budgetMs?: number
}

export type EnsureDaemonOutcome =
  | { action: "noop"; reason: "library-mode" | "never-mode" | "env-override" | "already-alive" }
  | { action: "spawned"; pid: number }
  | { action: "spawn-failed"; error: string }
  | { action: "timed-out" }

/**
 * Ensure the unified tribe daemon is alive. Probes the socket; if dead and
 * mode=daemon, spawns a detached replacement. Returns quickly — the whole
 * operation is bounded by `budgetMs` (default 300ms) so it can never delay
 * a hook. Never throws.
 */
export async function ensureTribeDaemonIfConfigured(deps: EnsureDaemonDeps = {}): Promise<EnsureDaemonOutcome> {
  const budgetMs = deps.budgetMs ?? 300
  const deadline = Date.now() + budgetMs

  const mode = (deps.resolveMode ?? resolveAutostart)()
  if (mode === "library") {
    // TRIBE_NO_DAEMON=1 collapses to this too via resolveAutostart's env check.
    return {
      action: "noop",
      reason: process.env.TRIBE_NO_DAEMON === "1" ? "env-override" : "library-mode",
    }
  }
  if (mode === "never") return { action: "noop", reason: "never-mode" }

  // mode === "daemon"
  const socketPath = (deps.resolveSocketPath ?? resolveTribeSocketPath)()

  const probe = deps.probe ?? ((p: string) => isDaemonAlive(p, Math.max(50, Math.min(200, deadline - Date.now()))))
  let alive = false
  try {
    alive = await probe(socketPath)
  } catch {
    alive = false
  }

  if (alive) return { action: "noop", reason: "already-alive" }

  if (Date.now() >= deadline) return { action: "timed-out" }

  const spawnFn =
    deps.spawn ?? ((o: { socketPath: string }) => spawnTribeDaemonDetached({ ...o, log: deps.log }))
  const result = spawnFn({ socketPath })
  if (result.ok) return { action: "spawned", pid: result.pid }
  return { action: "spawn-failed", error: result.error }
}

/**
 * Legacy alias — pre-Phase-5c callers spawned a lore-specific daemon. The
 * unified daemon hosts both surfaces now, so both names resolve to the same
 * function. Kept for the lore MCP proxy and any external importers.
 */
export const ensureDaemonIfConfigured = ensureTribeDaemonIfConfigured

/**
 * Legacy alias — pre-Phase-5c this spawned lore + tribe in parallel. The
 * unified daemon is the whole thing now, so this is just
 * `ensureTribeDaemonIfConfigured` returning the outcome twice (once under
 * `lore`, once under `tribe`) for back-compat with existing tests.
 */
export async function ensureAllDaemonsIfConfigured(
  deps: EnsureDaemonDeps = {},
): Promise<{ lore: EnsureDaemonOutcome; tribe: EnsureDaemonOutcome }> {
  const outcome = await ensureTribeDaemonIfConfigured(deps)
  // Return the same outcome under both keys — the daemon is unified, so
  // "lore is alive" and "tribe is alive" are the same statement.
  return { lore: outcome, tribe: outcome }
}
