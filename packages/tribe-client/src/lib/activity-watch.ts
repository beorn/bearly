/**
 * Activity-log watcher used by `tribe activity` / `tribe watch --activity`.
 *
 * Reads the date-stamped activity-YYYY-MM-DD.jsonl files, filters by
 * --since, prints each entry colored per source, and (with --follow)
 * polls today's file for new appends.
 *
 * Crosses day boundaries: when polling and the local date rolls, the
 * watcher reopens at the new day's filename automatically. This pairs with
 * the daily-rotation behavior in the daemon-side activity-log module.
 *
 * Ported into `@bearly/tribe-client` (Phase A.2 of
 * `@km/bearly/tribe-cli-unify-phase-a2-verbs`) from the original location at
 * `tools/lib/tribe/activity-watch.ts`. The `activityLogDir` /
 * `activityLogFilename` / `ActivityEntry` symbols were inlined here (rather
 * than re-imported from the daemon-side `activity-log.ts`) so this module
 * stays inside the published package — the daemon-side log is the writer,
 * this is the reader.
 */

import { readFileSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// Types & helpers (inlined from tools/lib/tribe/activity-log.ts — reader-side)
// ---------------------------------------------------------------------------

/** Activity kinds recorded by the daemon writer. */
export type ActivityKind = "dm" | "broadcast" | "event" | "session" | "rename" | "inject" | "gate"
export type ActivitySource = "tribe" | "recall" | "gate"

export interface ActivityEntry {
  ts: number
  source: ActivitySource
  kind: ActivityKind
  session: string
  peer?: string
  type?: string
  preview?: string
  chars?: number
  id?: string
  bead_id?: string | null
  meta?: Record<string, unknown>
}

const DEFAULT_DIR_SUFFIX = "/.local/share/tribe"

/** Return the directory containing activity-* files. */
export function activityLogDir(): string {
  const home = process.env.HOME ?? ""
  return `${home}${DEFAULT_DIR_SUFFIX}`
}

/** Per-day filename for an arbitrary date. */
export function activityLogFilename(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `activity-${y}-${m}-${d}.jsonl`
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

const COLOR = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m", // tribe
  magenta: "\x1b[35m", // recall
  yellow: "\x1b[33m", // gate
  red: "\x1b[31m", // gate=deny
  green: "\x1b[32m", // gate=allow
  white: "\x1b[37m",
}

/** Return color escape for a given source/decision pair. */
function colorFor(entry: ActivityEntry): string {
  if (entry.source === "gate") {
    if (entry.type === "deny") return COLOR.red
    if (entry.type === "allow") return COLOR.green
    return COLOR.yellow
  }
  if (entry.source === "recall") return COLOR.magenta
  if (entry.source === "tribe") return COLOR.cyan
  return COLOR.white
}

/** Format an entry as one human-readable colored line. */
export function formatActivityLine(entry: ActivityEntry, useColor: boolean = true): string {
  const ts = new Date(entry.ts).toISOString().replace("T", " ").slice(0, 19)
  const src = entry.source.toUpperCase().padEnd(6)
  const kind = entry.kind.padEnd(9)
  const session = (entry.session || "?").slice(0, 16).padEnd(16)
  const peer = entry.peer ? ` →${entry.peer.slice(0, 12)}` : ""
  const type = entry.type ? ` [${entry.type}]` : ""
  const preview = entry.preview ?? ""
  const c = useColor ? colorFor(entry) : ""
  const r = useColor ? COLOR.reset : ""
  const dim = useColor ? COLOR.dim : ""
  return `${dim}${ts}${r} ${c}${src}${r} ${kind} ${session}${peer}${type} ${preview}`
}

/** Parse "1h" / "30m" / "2d" / "45s" into milliseconds. */
export function parseSinceDuration(raw: string): number | null {
  const m = raw.trim().match(/^(\d+)\s*([smhd])$/i)
  if (!m) return null
  const n = parseInt(m[1]!, 10)
  const u = m[2]!.toLowerCase()
  const mult = u === "s" ? 1000 : u === "m" ? 60_000 : u === "h" ? 3_600_000 : 86_400_000
  return n * mult
}

/** Read one date-stamped file, parse JSONL, drop unparseable lines silently. */
function readEntriesFromFile(path: string): ActivityEntry[] {
  if (!existsSync(path)) return []
  const raw = readFileSync(path, "utf8")
  const out: ActivityEntry[] = []
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue
    try {
      out.push(JSON.parse(line) as ActivityEntry)
    } catch {
      // skip malformed line
    }
  }
  return out
}

/**
 * Read the union of date-stamped files needed to cover [`since`, now].
 *
 * Returns entries in (file-order, line-order) — i.e., chronological assuming
 * the daemon writes monotonically into each day's file.
 */
export function readEntriesSince(sinceMs: number, now: Date = new Date()): ActivityEntry[] {
  const dir = activityLogDir()
  // Walk from the day containing `sinceMs` up to today, in forward order.
  const startDay = new Date(sinceMs)
  startDay.setHours(0, 0, 0, 0)
  const endDay = new Date(now)
  endDay.setHours(0, 0, 0, 0)
  const out: ActivityEntry[] = []
  for (let d = new Date(startDay); d.getTime() <= endDay.getTime(); d.setDate(d.getDate() + 1)) {
    const path = join(dir, activityLogFilename(d))
    for (const e of readEntriesFromFile(path)) {
      if (e.ts >= sinceMs) out.push(e)
    }
  }
  return out
}

export interface ActivityWatchOptions {
  /** ISO duration like "1h", "30m". Defaults to today's events. */
  since?: string
  /** When false, print and exit. When true, tail forever. */
  follow?: boolean
  /** Disable ANSI colors (for piping). */
  noColor?: boolean
  /** Polling interval for follow mode, ms. Default 500. */
  pollMs?: number
  /**
   * Output sink. Defaults to console.log. Tests can capture lines via this hook.
   */
  out?: (line: string) => void
}

/**
 * Tail the activity log. When `follow` is false, prints all entries from
 * `since` (or today midnight) up to now and exits. When `follow` is true,
 * also polls today's file for appends and prints new entries as they land.
 */
export async function watchActivity(opts: ActivityWatchOptions = {}): Promise<void> {
  const out = opts.out ?? ((line: string) => console.log(line))
  const useColor = !opts.noColor
  const pollMs = opts.pollMs ?? 500

  const now = new Date()
  let sinceMs: number
  if (opts.since) {
    const dur = parseSinceDuration(opts.since)
    if (dur === null) {
      throw new Error(`invalid --since duration: ${opts.since} (expected e.g. "1h", "30m", "2d")`)
    }
    sinceMs = now.getTime() - dur
  } else {
    // Default: today midnight local time
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    sinceMs = midnight.getTime()
  }

  // Initial replay — emit everything since the cutoff
  const initial = readEntriesSince(sinceMs, now)
  for (const e of initial) out(formatActivityLine(e, useColor))

  if (!opts.follow) return

  // Follow mode — poll today's file for size change, print new lines.
  // Reopens at the new day's path when the local date rolls.
  let currentPath = join(activityLogDir(), activityLogFilename(now))
  let lastSize = existsSync(currentPath) ? statSync(currentPath).size : 0

  while (true) {
    await new Promise((r) => setTimeout(r, pollMs))
    const currentDate = new Date()
    const expectedPath = join(activityLogDir(), activityLogFilename(currentDate))
    if (expectedPath !== currentPath) {
      // Day rolled. Don't replay yesterday's tail; just re-anchor on today's file.
      currentPath = expectedPath
      lastSize = existsSync(currentPath) ? statSync(currentPath).size : 0
      continue
    }
    if (!existsSync(currentPath)) continue
    const size = statSync(currentPath).size
    if (size === lastSize) continue
    if (size < lastSize) {
      // File was truncated / rotated under us — reset.
      lastSize = 0
    }
    const buf = readFileSync(currentPath, "utf8")
    // Read only the tail bytes since lastSize
    const tail = buf.slice(lastSize)
    lastSize = size
    for (const line of tail.split("\n")) {
      if (line.length === 0) continue
      try {
        const entry = JSON.parse(line) as ActivityEntry
        out(formatActivityLine(entry, useColor))
      } catch {
        // skip malformed
      }
    }
  }
}
