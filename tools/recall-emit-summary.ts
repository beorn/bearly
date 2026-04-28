#!/usr/bin/env bun
/**
 * recall-emit-summary — measure Tier-2 ambient injection useful-rate.
 *
 * Reads the JSONL log written by `@bearly/injection-envelope` debug.ts
 * (default `~/.cache/recall-emit-log.jsonl`, configured via the
 * `INJECTION_DEBUG_LOG` env var inside `~/.claude/hooks/user-prompt-submit.sh`).
 *
 * Each row is one emit-or-skip decision. We bucket by action / reason and
 * print a compact dashboard plus the recent emits for eyeball review.
 *
 * Usage:
 *   bun tools/recall-emit-summary.ts                       # default log
 *   bun tools/recall-emit-summary.ts --log <path>
 *   bun tools/recall-emit-summary.ts --since 1d            # last 24h
 *   bun tools/recall-emit-summary.ts --recent 10           # last N emits with content
 *   bun tools/recall-emit-summary.ts --json                # machine-readable
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

interface LogRow {
  ts: string
  namespace: string
  level: string
  msg: string
  source?: string
  action: "emit" | "skip" | "empty"
  reason?: string
  prompt?: string
  itemCount?: number
  chars?: number
  additionalContext?: string
}

interface Args {
  logPath: string
  since: number | null
  recent: number
  json: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    logPath: process.env.INJECTION_DEBUG_LOG ?? path.join(os.homedir(), ".cache", "recall-emit-log.jsonl"),
    since: null,
    recent: 5,
    json: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--log") args.logPath = argv[++i] ?? args.logPath
    else if (a === "--since") args.since = parseSince(argv[++i] ?? "")
    else if (a === "--recent") args.recent = parseInt(argv[++i] ?? "5", 10)
    else if (a === "--json") args.json = true
    else if (a === "--help" || a === "-h") {
      console.log(`recall-emit-summary [--log <path>] [--since 1h|1d|1w] [--recent N] [--json]`)
      process.exit(0)
    }
  }
  return args
}

function parseSince(s: string): number {
  const m = s.match(/^(\d+)([hdw])$/)
  if (!m) return Date.now() - 24 * 60 * 60 * 1000
  const n = parseInt(m[1]!, 10)
  const unit = m[2] === "h" ? 60 * 60 * 1000 : m[2] === "d" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000
  return Date.now() - n * unit
}

function loadRows(p: string, sinceMs: number | null): LogRow[] {
  if (!fs.existsSync(p)) return []
  const raw = fs.readFileSync(p, "utf8")
  const rows: LogRow[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const row = JSON.parse(trimmed) as LogRow
      if (sinceMs !== null && new Date(row.ts).getTime() < sinceMs) continue
      rows.push(row)
    } catch {
      // skip malformed lines
    }
  }
  return rows
}

interface Summary {
  total: number
  emits: number
  skips: number
  skipReasons: Record<string, number>
  emitItemCounts: Record<string, number>
  meanChars: number
  windowStart: string | null
  windowEnd: string | null
}

function summarize(rows: LogRow[]): Summary {
  const skipReasons: Record<string, number> = {}
  const emitItemCounts: Record<string, number> = {}
  let emits = 0
  let skips = 0
  let totalChars = 0
  let charSamples = 0
  for (const r of rows) {
    if (r.action === "emit") {
      emits++
      const k = String(r.itemCount ?? 0)
      emitItemCounts[k] = (emitItemCounts[k] ?? 0) + 1
      if (r.chars) {
        totalChars += r.chars
        charSamples++
      }
    } else if (r.action === "skip" || r.action === "empty") {
      skips++
      const reason = r.reason ?? "unknown"
      skipReasons[reason] = (skipReasons[reason] ?? 0) + 1
    }
  }
  return {
    total: rows.length,
    emits,
    skips,
    skipReasons,
    emitItemCounts,
    meanChars: charSamples > 0 ? Math.round(totalChars / charSamples) : 0,
    windowStart: rows[0]?.ts ?? null,
    windowEnd: rows.at(-1)?.ts ?? null,
  }
}

function printDashboard(s: Summary, recent: LogRow[]): void {
  const emitRate = s.total > 0 ? ((s.emits / s.total) * 100).toFixed(1) : "0.0"
  const skipRate = s.total > 0 ? ((s.skips / s.total) * 100).toFixed(1) : "0.0"
  const window =
    s.windowStart && s.windowEnd ? `${s.windowStart.slice(0, 16)} → ${s.windowEnd.slice(0, 16)}` : "no events"
  console.log(`Tier-2 ambient injection — emit dashboard`)
  console.log(`Window: ${window}`)
  console.log(``)
  console.log(`Decisions: ${s.total} total — ${s.emits} emit (${emitRate}%) | ${s.skips} skip (${skipRate}%)`)
  if (s.emits > 0) {
    console.log(`Mean chars per emit: ${s.meanChars}`)
    const items = Object.entries(s.emitItemCounts).sort()
    console.log(`Emits by snippet count: ${items.map(([k, v]) => `${k}=${v}`).join("  ")}`)
  }
  if (Object.keys(s.skipReasons).length > 0) {
    console.log(``)
    console.log(`Skip reasons:`)
    const sorted = Object.entries(s.skipReasons).sort((a, b) => b[1] - a[1])
    for (const [reason, n] of sorted) {
      const pct = ((n / s.skips) * 100).toFixed(1)
      console.log(`  ${reason.padEnd(15)} ${String(n).padStart(5)}  (${pct}%)`)
    }
  }
  if (recent.length > 0) {
    console.log(``)
    console.log(`Recent ${recent.length} emit(s):`)
    for (const r of recent) {
      const ts = r.ts.slice(0, 19).replace("T", " ")
      const prompt = (r.prompt ?? "").slice(0, 80).replace(/\s+/g, " ")
      console.log(`  ${ts}  items=${r.itemCount ?? 0}  chars=${r.chars ?? 0}`)
      console.log(`    prompt: ${prompt}`)
      const ctx = r.additionalContext ?? ""
      const firstSnippet =
        ctx
          .match(/<snippet[^>]*>([\s\S]*?)<\/snippet>/)?.[1]
          ?.trim()
          .slice(0, 200) ?? ""
      if (firstSnippet) console.log(`    snippet: ${firstSnippet.replace(/\s+/g, " ")}`)
    }
  }
  console.log(``)
  console.log(
    `Useful-rate target: ≥60% useful AND ≥40% silent. Inspect "Recent emits" above and tally useful/noise/redundant.`,
  )
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const rows = loadRows(args.logPath, args.since)
  const summary = summarize(rows)
  const emits = rows.filter((r) => r.action === "emit").slice(-args.recent)
  if (args.json) {
    process.stdout.write(JSON.stringify({ summary, recentEmits: emits }, null, 2) + "\n")
    return
  }
  if (rows.length === 0) {
    console.log(`No events in ${args.logPath} (since=${args.since ? new Date(args.since).toISOString() : "ever"}).`)
    console.log(`The log fills as you use Claude Code — try a few prompts then re-run.`)
    return
  }
  printDashboard(summary, emits)
}

main()
