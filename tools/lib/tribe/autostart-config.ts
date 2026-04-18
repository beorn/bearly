/**
 * Tribe autostart config — persistent file-based config for the daemon lifecycle.
 *
 * Lives at `~/.claude/tribe/config.json`. Controls whether the tribe hook
 * dispatch layer (and the MCP server) should auto-spawn the lore daemon
 * when it isn't running.
 *
 * Schema:
 *   { "autostart": "daemon" | "library" | "never" }
 *
 *   - "daemon" (default): on first hook after the daemon dies, auto-spawn a
 *     detached replacement. Pairs with the daemon's own idle --quit-timeout
 *     for zero-ceremony lifecycle.
 *   - "library": never spawn; hooks always use the in-process library path.
 *     Persistent equivalent of TRIBE_NO_DAEMON=1.
 *   - "never": hooks skip the daemon entirely — even if one is running.
 *     Escape hatch for users who hit daemon bugs.
 *
 * Env override: TRIBE_NO_DAEMON=1 forces library mode regardless of config.
 *
 * Reads never throw — a missing / unparseable / malformed file yields the
 * default. Writes are atomic (write to .tmp, rename).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TribeAutostart = "daemon" | "library" | "never"

export type TribeAutostartConfig = {
  autostart: TribeAutostart
}

export const DEFAULT_AUTOSTART: TribeAutostart = "daemon"

/** Canonical config path (literal — `~` is resolved at read time). */
export const DEFAULT_CONFIG_PATH = "~/.claude/tribe/config.json"

export const VALID_AUTOSTART_MODES: readonly TribeAutostart[] = ["daemon", "library", "never"] as const

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective config path. Expands a leading `~` to the user's home
 * directory. Accepts an optional `homeDir` override for tests.
 */
export function resolveConfigPath(homeDir?: string): string {
  const home = homeDir ?? homedir()
  return resolve(home, ".claude", "tribe", "config.json")
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function isAutostart(value: unknown): value is TribeAutostart {
  return typeof value === "string" && (VALID_AUTOSTART_MODES as readonly string[]).includes(value)
}

/**
 * Load the tribe config from disk. Returns the default `{ autostart: "daemon" }`
 * when the file is missing, unreadable, malformed, or contains an unknown
 * `autostart` value. Never throws — hooks must never crash on a bad config.
 */
export function readTribeConfig(path?: string): TribeAutostartConfig {
  const p = path ?? resolveConfigPath()
  if (!existsSync(p)) return { autostart: DEFAULT_AUTOSTART }
  try {
    const raw = readFileSync(p, "utf-8")
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const v = (parsed as Record<string, unknown>).autostart
      if (isAutostart(v)) return { autostart: v }
    }
  } catch {
    /* fall through to default */
  }
  return { autostart: DEFAULT_AUTOSTART }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Atomically write the config file. Creates parent directories as needed.
 * Writes to `<path>.tmp` first, then renames — so a concurrent reader never
 * sees a half-written file.
 */
export function writeTribeConfig(path: string, config: TribeAutostartConfig): void {
  if (!isAutostart(config.autostart)) {
    throw new Error(`Invalid autostart mode: ${String(config.autostart)}`)
  }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf-8")
  renameSync(tmp, path)
}

// ---------------------------------------------------------------------------
// Effective resolution (env override > file > default)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective autostart mode for this process.
 *
 * Priority:
 *   1. `TRIBE_NO_DAEMON=1` env var → "library" (existing contract preserved)
 *   2. On-disk config (~/.claude/tribe/config.json)
 *   3. Default ("daemon")
 */
export function resolveAutostart(path?: string): TribeAutostart {
  if (process.env.TRIBE_NO_DAEMON === "1") return "library"
  return readTribeConfig(path).autostart
}
