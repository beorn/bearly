/**
 * Lore configuration — path resolution for socket and DB. Pidfile plumbing
 * was deleted in Phase 5 of km-tribe.plateau — the unified tribe daemon owns
 * liveness via socket connectability (mirror of Phase 3 for tribe proper).
 */

import { existsSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Resolve daemon socket path. Priority: arg > TRIBE_LORE_SOCKET env > XDG_RUNTIME_DIR > ~/.local/share/lore */
export function resolveLoreSocketPath(socketArg?: string): string {
  if (socketArg) return socketArg
  const fromEnv = process.env.TRIBE_LORE_SOCKET
  if (fromEnv) return fromEnv
  const xdg = process.env.XDG_RUNTIME_DIR
  if (xdg) return resolve(xdg, "lore.sock")
  const home = process.env.HOME ?? "/tmp"
  return resolve(home, ".local/share/lore/lore.sock")
}

/** DB location: arg > TRIBE_LORE_DB env > ~/.local/share/lore/lore.db */
export function resolveLoreDbPath(dbArg?: string): string {
  if (dbArg) return dbArg
  const fromEnv = process.env.TRIBE_LORE_DB
  if (fromEnv) return fromEnv
  const xdgData = process.env.XDG_DATA_HOME ?? resolve(process.env.HOME ?? "~", ".local/share")
  const loreDir = resolve(xdgData, "lore")
  if (!existsSync(loreDir)) mkdirSync(loreDir, { recursive: true })
  return resolve(loreDir, "lore.db")
}

/** Ensure parent directory for a file path exists */
export function ensureParentDir(path: string): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}
