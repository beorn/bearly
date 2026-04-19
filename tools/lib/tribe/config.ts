/**
 * Tribe configuration — CLI args, env vars, path resolution, role/name detection.
 */

import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { parseArgs } from "node:util"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Session role — a typed tag on the session (stored in `sessions.role`) that
 * replaces the old name-prefix magic for eligibility checks.
 *
 *   - "daemon"  — the daemon itself; never a chief, never a member.
 *   - "chief"   — the coordinating session (derived from connection order,
 *                 or explicitly claimed via `tribe.claim-chief`).
 *   - "member"  — a regular worker session. Default for newly-joined sessions.
 *   - "watch"   — a dashboard / observer (e.g. `tribe watch`). Never eligible
 *                 for chief; receives every message on its wire.
 *   - "pending" — half-registered placeholder used between socket accept and
 *                 the client's first `register` call.
 */
export type TribeRole = "daemon" | "chief" | "member" | "watch" | "pending"

/** Subset of roles that participate as regular tribe members (chief pool). */
export type TribeParticipantRole = "chief" | "member"

export const TRIBE_ROLES: readonly TribeRole[] = ["daemon", "chief", "member", "watch", "pending"] as const

export function isValidRole(r: unknown): r is TribeRole {
  return typeof r === "string" && (TRIBE_ROLES as readonly string[]).includes(r)
}

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
          if (match?.[1]) return match[1].toLowerCase()
        } catch {
          /* fallback */
        }
      }
      return basename(projectRoot).toLowerCase()
    }
  }
  // No nearby .beads/ — use cwd directory name
  return basename(dir).toLowerCase()
}

/**
 * DB location. Priority:
 *   1. `--db` flag
 *   2. `TRIBE_DB` env var
 *   3. User-global `~/.local/share/tribe/tribe.db` (new default, matches
 *      the socket at `~/.local/share/tribe/tribe.sock`)
 *   4. Legacy `.beads/tribe.db` — if present and step 3 doesn't exist, migrate
 *      it forward by moving the files to the XDG path. This unblocks retiring
 *      `.beads/` in projects that moved off bd for issue tracking.
 *
 * See km-tribe.decouple-db-location. Pre-0.11.2 the priority order was
 * `--db > TRIBE_DB > .beads/tribe.db > XDG`, which conflated tribe with bd:
 * a repo couldn't delete `.beads/` without taking tribe down with it.
 */
export function resolveDbPath(args: TribeArgs): string {
  if (args.db) return String(args.db)
  if (process.env.TRIBE_DB) return process.env.TRIBE_DB

  const xdgData = process.env.XDG_DATA_HOME ?? resolve(process.env.HOME ?? "~", ".local/share")
  const tribeDir = resolve(xdgData, "tribe")
  const xdgDbPath = resolve(tribeDir, "tribe.db")

  // Migration: if an XDG DB doesn't exist yet but a legacy `.beads/tribe.db`
  // does, move it forward. This is a one-time copy — subsequent startups find
  // the XDG path and skip.
  if (!existsSync(xdgDbPath)) {
    const beadsDir = findBeadsDir()
    if (beadsDir) {
      const legacyDb = resolve(beadsDir, "tribe.db")
      if (existsSync(legacyDb)) {
        mkdirSync(tribeDir, { recursive: true })
        migrateLegacyTribeDb(legacyDb, xdgDbPath)
        return xdgDbPath
      }
    }
  }

  mkdirSync(tribeDir, { recursive: true })
  return xdgDbPath
}

/**
 * Move a legacy `.beads/tribe.db` (+ its WAL/SHM sidecars) to the XDG path.
 * Best-effort: if rename fails (e.g. cross-device), fall through and let the
 * caller fall back to creating a fresh DB at the XDG location.
 */
function migrateLegacyTribeDb(legacyPath: string, xdgPath: string): void {
  try {
    renameSync(legacyPath, xdgPath)
    // Sidecars may or may not exist — best-effort.
    for (const suffix of ["-wal", "-shm"]) {
      const src = `${legacyPath}${suffix}`
      if (existsSync(src)) {
        try {
          renameSync(src, `${xdgPath}${suffix}`)
        } catch {
          /* leave it — SQLite will rebuild the sidecar */
        }
      }
    }
    // Drop a breadcrumb so users discovering the old path understand.
    try {
      writeFileSync(
        `${legacyPath}.moved`,
        `Moved to ${xdgPath} on ${new Date().toISOString()} — see km-tribe.decouple-db-location.\n`,
        "utf-8",
      )
    } catch {
      /* best-effort */
    }
  } catch {
    /* cross-device or perms — leave the legacy DB in place; caller opens a fresh XDG DB. */
  }
}

/** Auto-detect role: if a live chief exists in the sessions table, become member; otherwise chief.
 *  Chief is derived from connection order at runtime (see tribe-daemon `deriveChiefId`), so this
 *  role flag is only an initial hint — the daemon reconciles the actual chief from the client set. */
export function detectRole(db: Database, args: TribeArgs): TribeRole {
  if (args.role && isValidRole(args.role)) return args.role
  // "watch" and "pending" are always explicit — they're never the result of
  // auto-detection. The daemon's own ctx is constructed with role="daemon"
  // directly (bypassing this helper). For regular proxy clients the choice
  // is chief vs member:
  //
  // Phase 2 of km-tribe.plateau: there's no heartbeat timer any more, so a
  // DB-only query can't tell "currently connected" from "stale row". The
  // daemon reconciles the actual chief at runtime (see `deriveChiefId`);
  // this hint is best-effort — if any row claims chief role, default to
  // member so we don't stomp. The daemon will fix us up on register.
  const anyChief = db.prepare("SELECT name FROM sessions WHERE role = 'chief' LIMIT 1").get()
  return anyChief ? "member" : "chief"
}

/** Auto-generate name: chief gets "chief", members get "member-<N>" */
export function detectName(db: Database, role: TribeRole, args: TribeArgs): string {
  if (args.name) return String(args.name)
  if (role === "chief") return "chief"
  // Use PID-based name to avoid race conditions (max+1 can collide)
  const pidName = `member-${process.pid}`
  const taken = db.prepare("SELECT id FROM sessions WHERE name = ?").get(pidName)
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

/** Canonical project identity — deterministic hash of the resolved project root path.
 *  Handles symlinks, worktrees, and avoids collisions (two repos both named "api"). */
export function resolveProjectId(cwd?: string): string {
  const dir = cwd ?? process.cwd()
  try {
    const real = realpathSync(dir)
    return createHash("sha256").update(real).digest("hex").slice(0, 12)
  } catch {
    return createHash("sha256").update(dir).digest("hex").slice(0, 12)
  }
}
