/**
 * Fleet-wide failure-rate read — @i/1-instruments/24546.
 *
 * The failure-rate rule was never wrong. `buildDiagnostics` has computed
 * `warn: failRate > 30% AND calls >= 20` since Phase 1D. It has never fired for
 * the thing it exists to catch, because the log it reads is keyed per project
 * DIRECTORY while the signal is fleet-wide: the store is
 * `~/.claude/projects/<encoded-cwd>/memory/ab-pro.jsonl`, and the reader opened
 * exactly one of them. Run it from a fresh worktree and it printed "No
 * ab-pro.jsonl entries yet" — which reads as *nothing is wrong* and means *I
 * looked in one of 106 places*. Two models were retired as dead (deepseek-r1 on
 * 2026-08-19, kimi-k3 on 2026-09-11) while the evidence that they were merely
 * being asked for an impossible output budget (@hh/tooling/22972) sat unread in
 * these files.
 *
 * ## Why the statistic is a call count, not a time window
 *
 * 24546 originally specified a 14-day trailing window. Measured against the real
 * corpus on 2026-09-11, a 14-day window catches NEITHER retirement, so it could
 * not have satisfied the bead's own acceptance:
 *
 *                          deepseek-r1            kimi-k3
 *     trailing  7d         absent                 174 calls  37.4%  WARN
 *     trailing 14d         absent                 283 calls  27.9%  ----
 *     trailing 30d          33 calls 100.0% WARN  350 calls  24.6%  ----
 *     last 30 calls         30 calls 100.0% WARN   30 calls 100.0%  WARN
 *
 * A trailing window fails in both directions at once. A model retired weeks ago
 * has no recent calls and vanishes from the window entirely. A model that is
 * failing NOW but has a long healthy history gets its burst diluted by its own
 * volume — kimi-k3's rate falls as the window widens precisely because 22972
 * landed and it stopped failing, so the more history you admit the healthier the
 * broken model looks.
 *
 * The last N calls FOR EACH MODEL is immune to both. It cannot be diluted by a
 * model's volume, it cannot age out, and it is bounded by construction. The
 * replay is in tests/fleet-failure-rate.test.ts: as of each retirement date, and
 * again today, the rule fires on both.
 *
 * The day window survives as a bound on the READ, not as the statistic — it is
 * what lets the tail reader stop, and it is why cost tracks entries-in-window
 * rather than the size of the corpus.
 */

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from "node:fs"
import { join } from "node:path"

import type { AbProEntry } from "./dual-pro"
import { legsOf } from "./dual-pro"

/** One call's outcome. The only three fields the fleet read keeps in memory. */
export interface FleetCall {
  /** Epoch ms of the entry that produced this leg. */
  at: number
  model: string
  ok: boolean
}

/** A model's recent record, and whether it trips the rule. */
export interface FleetFailureRow {
  model: string
  /** Calls considered — at most `recentCalls`, newest first. */
  calls: number
  successCalls: number
  failureRate: number
  warn: boolean
  /** Epoch ms of the newest call considered. Lets a caller say how stale this is. */
  newestAt: number
  /** Epoch ms of the oldest call considered. */
  oldestAt: number
}

/**
 * What the read actually covered. Every consumer must state this before
 * reporting "no data" — the whole defect was a reader that said nothing is
 * wrong when it meant it had looked in one place.
 */
export interface FleetFailureReport {
  rows: FleetFailureRow[]
  filesFound: number
  filesRead: number
  callsRead: number
  windowDays: number
  recentCalls: number
}

/** Bounds the READ so cost tracks entries-in-window, not the size of history. */
export const FLEET_READ_WINDOW_DAYS = 60
/** The statistic: a model's last N calls, newest first. */
export const FLEET_RECENT_CALLS = 30
/** Unchanged from `buildDiagnostics` — this bead never touched the rule. */
export const FLEET_WARN_RATE = 0.3
export const FLEET_WARN_MIN_CALLS = 20

const DAY_MS = 86_400_000

/**
 * Every ab-pro.jsonl this user writes.
 *
 * An explicit memory-dir override is honoured as an override: it names ONE
 * store, and aggregating past it would ignore what the caller asked for. With
 * no override the corpus is every per-project store plus the standalone
 * default, which is exactly the set `getMemoryDir` can return over a fleet's
 * lifetime.
 */
export function listFleetLogFiles(
  opts: { env?: NodeJS.ProcessEnv; projectsRoot?: string; standaloneDir?: string } = {},
): string[] {
  const env = opts.env ?? process.env

  const override = env.BEARLY_LLM_MEMORY_DIR || env.LLM_DIR
  if (override) {
    const one = join(override, "ab-pro.jsonl")
    return existsSync(one) ? [one] : []
  }

  const home = env.HOME || ""
  const projectsRoot = opts.projectsRoot ?? join(home, ".claude", "projects")
  const standaloneDir = opts.standaloneDir ?? join(home, ".config", "llm")

  const out: string[] = []
  if (existsSync(projectsRoot)) {
    for (const dir of readdirSync(projectsRoot).sort()) {
      const file = join(projectsRoot, dir, "memory", "ab-pro.jsonl")
      if (existsSync(file)) out.push(file)
    }
  }
  const standalone = join(standaloneDir, "ab-pro.jsonl")
  if (existsSync(standalone) && !out.includes(standalone)) out.push(standalone)
  return out
}

/**
 * Read one log BACKWARDS from its tail, newest entry first, stopping at the
 * first entry older than `cutoffMs`.
 *
 * The file is append-only and chronological, so the first old line ends the
 * file — there is nothing newer behind it. Entries average ~24 KB because they
 * carry the question and the response text; this keeps only three fields per
 * leg, so memory tracks calls-in-window and never the corpus.
 *
 * An mtime prefilter was measured instead of assumed and is NOT sufficient: it
 * skips 11 files of 106, because the busy logs are all recent.
 */
export function readRecentCalls(file: string, cutoffMs: number, chunkSize = 256 * 1024): FleetCall[] {
  const fd = openSync(file, "r")
  try {
    let pos = fstatSync(fd).size
    let carry = ""
    const out: FleetCall[] = []
    while (pos > 0) {
      const len = Math.min(chunkSize, pos)
      pos -= len
      const buf = Buffer.allocUnsafe(len)
      readSync(fd, buf, 0, len, pos)
      const lines = (buf.toString("utf8") + carry).split("\n")
      // The first element is a partial line until we reach the start of file.
      carry = pos > 0 ? (lines.shift() ?? "") : ""
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]
        if (!line) continue
        let entry: AbProEntry
        try {
          entry = JSON.parse(line) as AbProEntry
        } catch {
          // Readers tolerate format drift; a torn line is not a reason to
          // abandon the window. It is NOT treated as the window edge.
          continue
        }
        const at = Date.parse(entry.timestamp ?? "")
        if (!Number.isFinite(at)) continue
        if (at < cutoffMs) return out
        for (const leg of legsOf(entry)) {
          if (leg.model) out.push({ at, model: leg.model, ok: !!leg.ok })
        }
      }
    }
    return out
  } finally {
    closeSync(fd)
  }
}

/**
 * Reduce raw calls to one row per model over that model's last N calls.
 *
 * Sorting is by time descending, so "last N" means the N most recent calls for
 * that model wherever in the fleet they were made.
 */
export function fleetFailureRows(
  calls: readonly FleetCall[],
  opts: { recentCalls?: number; warnRate?: number; warnMinCalls?: number } = {},
): FleetFailureRow[] {
  const recentCalls = opts.recentCalls ?? FLEET_RECENT_CALLS
  const warnRate = opts.warnRate ?? FLEET_WARN_RATE
  const warnMinCalls = opts.warnMinCalls ?? FLEET_WARN_MIN_CALLS

  const byModel = new Map<string, FleetCall[]>()
  for (const call of calls) {
    const bucket = byModel.get(call.model)
    if (bucket) bucket.push(call)
    else byModel.set(call.model, [call])
  }

  const rows: FleetFailureRow[] = []
  for (const [model, all] of byModel) {
    const recent = [...all].sort((a, b) => b.at - a.at).slice(0, recentCalls)
    const successCalls = recent.filter((c) => c.ok).length
    const failureRate = (recent.length - successCalls) / recent.length
    rows.push({
      model,
      calls: recent.length,
      successCalls,
      failureRate,
      warn: failureRate > warnRate && recent.length >= warnMinCalls,
      newestAt: recent[0]!.at,
      oldestAt: recent[recent.length - 1]!.at,
    })
  }
  rows.sort((a, b) => b.failureRate - a.failureRate || b.calls - a.calls)
  return rows
}

/** Read the fleet corpus and reduce it. The one entry point callers want. */
export function readFleetFailureReport(
  opts: {
    env?: NodeJS.ProcessEnv
    projectsRoot?: string
    standaloneDir?: string
    now?: number
    windowDays?: number
    recentCalls?: number
    warnRate?: number
    warnMinCalls?: number
  } = {},
): FleetFailureReport {
  const windowDays = opts.windowDays ?? FLEET_READ_WINDOW_DAYS
  const recentCalls = opts.recentCalls ?? FLEET_RECENT_CALLS
  const cutoff = (opts.now ?? Date.now()) - windowDays * DAY_MS

  const files = listFleetLogFiles(opts)
  const calls: FleetCall[] = []
  let filesRead = 0
  for (const file of files) {
    // A log we cannot read is a fact about the population, not a reason to
    // report health — `filesFound` vs `filesRead` is how a caller sees it.
    let some: FleetCall[]
    try {
      some = readRecentCalls(file, cutoff)
    } catch {
      continue
    }
    filesRead += 1
    for (const call of some) calls.push(call)
  }

  return {
    rows: fleetFailureRows(calls, { recentCalls, warnRate: opts.warnRate, warnMinCalls: opts.warnMinCalls }),
    filesFound: files.length,
    filesRead,
    callsRead: calls.length,
    windowDays,
    recentCalls,
  }
}

/**
 * The rows a dispatch should shout about: the models this call is actually
 * using that trip the rule. A split-test leg is EXPECTED to fail sometimes —
 * that is what split-testing is for — so only the configured mainstays qualify.
 */
export function failingMainstays(report: FleetFailureReport, mainstays: readonly string[]): FleetFailureRow[] {
  const wanted = new Set(mainstays)
  return report.rows.filter((row) => row.warn && wanted.has(row.model))
}

/**
 * One line a reader can act on. Names the population, because a rate with no
 * denominator is the failure mode this whole bead is about.
 */
export function formatFleetWarning(row: FleetFailureRow, report: FleetFailureReport, now = Date.now()): string {
  const pct = (row.failureRate * 100).toFixed(0)
  const ageDays = Math.round((now - row.newestAt) / DAY_MS)
  const freshness = ageDays >= 1 ? `, newest ${ageDays}d old` : ""
  return (
    `⚠️  mainstay "${row.model}" failed ${pct}% of its last ${row.calls} calls ` +
    `across the fleet (${report.filesRead} of ${report.filesFound} logs, ${report.windowDays}d window${freshness}). ` +
    `Check \`bun llm pro --diagnostics\` before trusting this leg.`
  )
}
