/**
 * Tribe autostart — probe-and-spawn helpers for zero-ceremony daemon lifecycle.
 *
 * Pairs with the daemon's own idle `--quit-timeout` exit: the daemon quits
 * itself when unused, this module spawns it back on first demand. Net effect
 * for the user: no lifecycle ceremony at all.
 *
 * The exported helpers are written so the orchestration function
 * (`ensureDaemonIfConfigured`) is pure side-effect-free given its deps —
 * tests inject `spawn`/`probe` implementations rather than stubbing globals.
 *
 * Hard rule: none of this may ever block a Claude Code hook. The whole
 * end-to-end budget is ~300ms; probe failures and spawn failures are
 * swallowed with a single stderr line, and the hook proceeds to its library
 * fallback.
 */

import { createConnection } from "node:net"
import { existsSync, unlinkSync } from "node:fs"
import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import { resolveAutostart, type TribeAutostart } from "./autostart-config.ts"
import { resolveLoreSocketPath } from "../../../plugins/tribe/lore/lib/config.ts"

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

/** Location of the lore daemon script (relative to this file). */
export function resolveDaemonScriptPath(): string {
  // tools/lib/tribe/autostart.ts → plugins/tribe/lore/daemon.ts
  const thisDir = dirname(new URL(import.meta.url).pathname)
  const bearlyRoot = resolve(thisDir, "..", "..", "..")
  return resolve(bearlyRoot, "plugins/tribe/lore/daemon.ts")
}

export type SpawnResult = { ok: true; pid: number } | { ok: false; error: string }

/**
 * Spawn the lore daemon as a detached, unref'd child. Stdout/stderr are
 * discarded — the daemon writes its own log file and PID file. Returns the
 * child PID on success, an error on failure. Never throws.
 *
 * The spawn is fire-and-forget: we don't wait for the socket to be ready.
 * Hook dispatch proceeds to the library fallback for this one turn, and
 * later hooks find a live daemon. This is the whole point of "zero ceremony".
 */
export function spawnDaemonDetached(
  opts: { socketPath?: string; bunPath?: string; scriptPath?: string; log?: (msg: string) => void } = {},
): SpawnResult {
  const scriptPath = opts.scriptPath ?? resolveDaemonScriptPath()
  const bunPath = opts.bunPath ?? process.execPath
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
    logFn(`[tribe] spawned lore daemon (pid=${pid})`)
    return { ok: true, pid }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const logFn = opts.log ?? defaultLog
    logFn(`[tribe] daemon spawn failed: ${msg}`)
    return { ok: false, error: msg }
  }
}

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
 * The one call hook-dispatch (and lore/server.ts) makes on entry: if the
 * user asked for autostart and no daemon is alive, spawn a detached
 * replacement. Returns quickly — the whole operation is bounded by
 * `budgetMs` (default 300ms) so it can never delay a hook.
 *
 * Never throws. On any error, returns a structured outcome and lets the
 * caller continue its library-path fallback.
 */
export async function ensureDaemonIfConfigured(deps: EnsureDaemonDeps = {}): Promise<EnsureDaemonOutcome> {
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
  const socketPath = (deps.resolveSocketPath ?? resolveLoreSocketPath)()

  const probe = deps.probe ?? ((p: string) => isDaemonAlive(p, Math.max(50, Math.min(200, deadline - Date.now()))))
  let alive = false
  try {
    alive = await probe(socketPath)
  } catch {
    alive = false
  }

  if (alive) return { action: "noop", reason: "already-alive" }

  if (Date.now() >= deadline) return { action: "timed-out" }

  const spawnFn = deps.spawn ?? ((o: { socketPath: string }) => spawnDaemonDetached({ ...o, log: deps.log }))
  const result = spawnFn({ socketPath })
  if (result.ok) return { action: "spawned", pid: result.pid }
  return { action: "spawn-failed", error: result.error }
}
