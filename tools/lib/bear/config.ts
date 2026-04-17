/**
 * Bear configuration — path resolution for socket, PID, and DB.
 */

import { existsSync, mkdirSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Resolve daemon socket path. Priority: arg > BEAR_SOCKET env > XDG_RUNTIME_DIR > ~/.local/share/bear */
export function resolveBearSocketPath(socketArg?: string): string {
  if (socketArg) return socketArg
  if (process.env.BEAR_SOCKET) return process.env.BEAR_SOCKET
  const xdg = process.env.XDG_RUNTIME_DIR
  if (xdg) return resolve(xdg, "bear.sock")
  const home = process.env.HOME ?? "/tmp"
  return resolve(home, ".local/share/bear/bear.sock")
}

/** Resolve PID file path (derived from socket path) */
export function resolveBearPidPath(socketPath: string): string {
  const base = basename(socketPath).replace(/\.sock$/, "")
  return resolve(dirname(socketPath), `${base}.pid`)
}

/** DB location: arg > BEAR_DB env > ~/.local/share/bear/bear.db */
export function resolveBearDbPath(dbArg?: string): string {
  if (dbArg) return dbArg
  if (process.env.BEAR_DB) return process.env.BEAR_DB
  const xdgData = process.env.XDG_DATA_HOME ?? resolve(process.env.HOME ?? "~", ".local/share")
  const bearDir = resolve(xdgData, "bear")
  if (!existsSync(bearDir)) mkdirSync(bearDir, { recursive: true })
  return resolve(bearDir, "bear.db")
}

/** Ensure parent directory for a file path exists */
export function ensureParentDir(path: string): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}
