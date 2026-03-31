/**
 * Tribe configuration — CLI args, env vars, path resolution, role/name detection.
 */

import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { parseArgs } from "node:util"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TribeRole = "chief" | "member"

export type TribeConfig = {
  name: string
  role: TribeRole
  domains: string[]
  dbPath: string
  beadsDir: string | null
  autoReport: boolean
  claudeSessionId: string | null
  claudeSessionName: string | null
  sessionId: string
}

export type TribeArgs = {
  name?: string
  role?: string
  domains?: string
  db?: string
  socket?: string
  "auto-report"?: boolean
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export function parseTribeArgs(): TribeArgs {
  const { values } = parseArgs({
    options: {
      name: { type: "string", default: process.env.TRIBE_NAME },
      role: { type: "string", default: process.env.TRIBE_ROLE },
      domains: { type: "string", default: process.env.TRIBE_DOMAINS ?? "" },
      db: { type: "string", default: process.env.TRIBE_DB },
      socket: { type: "string", default: process.env.TRIBE_SOCKET },
      "auto-report": { type: "boolean", default: (process.env.TRIBE_AUTO_REPORT ?? "1") === "1" },
    },
    strict: false,
  })
  return values as TribeArgs
}

export function parseSessionDomains(args: TribeArgs): string[] {
  return String(args.domains ?? "")
    .split(",")
    .filter(Boolean)
}

/** Find .beads/ directory by walking up from cwd (returns null if not found) */
export function findBeadsDir(from?: string): string | null {
  let dir = from ?? process.cwd()
  while (dir !== "/") {
    const candidate = resolve(dir, ".beads")
    if (existsSync(candidate)) return candidate
    dir = dirname(dir)
  }
  return null
}

/** Resolve project name from .beads/ config or directory name.
 *  Returns a short lowercase slug (e.g. "km", "decker") for namespacing sessions. */
export function resolveProjectName(cwd?: string): string {
  const dir = cwd ?? process.cwd()
  const beadsDir = findBeadsDir(dir)
  if (beadsDir) {
    const projectRoot = dirname(beadsDir)
    // Only use .beads/ if it's nearby (skip ~/.beads/ found far up the tree)
    const depth = dir.replace(projectRoot, "").split("/").filter(Boolean).length
    if (depth <= 2) {
      const configPath = resolve(beadsDir, "config.yaml")
      if (existsSync(configPath)) {
        try {
          const content = readFileSync(configPath, "utf-8")
          const match = content.match(/^project:\s*["']?(\w+)["']?/m)
          if (match) return match[1].toLowerCase()
        } catch { /* fallback */ }
      }
      return basename(projectRoot).toLowerCase()
    }
  }
  // No nearby .beads/ — use cwd directory name
  return basename(dir).toLowerCase()
}

/** DB location: --db flag > TRIBE_DB env > .beads/tribe.db > ~/.local/share/tribe/tribe.db */
export function resolveDbPath(args: TribeArgs, beadsDir: string | null): string {
  if (args.db) return String(args.db)
  if (process.env.TRIBE_DB) return process.env.TRIBE_DB
  if (beadsDir) return resolve(beadsDir, "tribe.db")
  // No .beads/ found — use XDG data dir
  const xdgData = process.env.XDG_DATA_HOME ?? resolve(process.env.HOME ?? "~", ".local/share")
  const tribeDir = resolve(xdgData, "tribe")
  mkdirSync(tribeDir, { recursive: true })
  return resolve(tribeDir, "tribe.db")
}

/** Auto-detect role: if a valid leader lease or live chief exists, become member; otherwise chief */
export function detectRole(db: Database, args: TribeArgs): TribeRole {
  if (args.role) return args.role as TribeRole
  // Check leader lease first (authoritative — survives heartbeat gaps)
  try {
    const lease = db
      .prepare("SELECT holder_name FROM leadership WHERE role = 'chief' AND lease_until > $now")
      .get({ $now: Date.now() }) as { holder_name: string } | null
    if (lease) return "member"
  } catch {
    // leadership table may not exist yet (first run) — fall through to heartbeat check
  }
  // Fallback: check for live chief by heartbeat
  const threshold = Date.now() - 30_000
  const liveChief = db
    .prepare("SELECT name FROM sessions WHERE role = 'chief' AND heartbeat > ? AND pruned_at IS NULL")
    .get(threshold)
  return liveChief ? "member" : "chief"
}

/** Auto-generate name: chief gets "chief", members get "member-<N>" */
export function detectName(db: Database, role: TribeRole, args: TribeArgs): string {
  if (args.name) return String(args.name)
  if (role === "chief") return "chief"
  // Use PID-based name to avoid race conditions (max+1 can collide)
  const pidName = `member-${process.pid}`
  const taken = db.prepare("SELECT id FROM sessions WHERE name = ? AND pruned_at IS NULL").get(pidName)
  if (!taken) return pidName
  // PID collision (unlikely) — fall back to random suffix
  return `member-${process.pid}-${Math.random().toString(36).slice(2, 5)}`
}

/** Resolve the Claude Code session ID from env vars */
export function resolveClaudeSessionId(): string | null {
  return process.env.CLAUDE_SESSION_ID ?? process.env.BD_ACTOR?.replace("claude:", "") ?? null
}

export function resolveClaudeSessionName(): string | null {
  return process.env.CLAUDE_SESSION_NAME ?? null
}
