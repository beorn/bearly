/**
 * Render helpers for `bg-recall status` and `bg-recall explain`.
 *
 * Plain string rendering — no terminal escape codes. The CLI wraps the output
 * with formatting if it wants colors. Keeps this module testable.
 */

import type { DaemonStatus, Decision } from "./types.ts"

const HOME = process.env.HOME ?? ""
const shortPath = (p: string): string => (HOME && p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p)

export function formatStatus(status: DaemonStatus): string {
  const lines: string[] = []
  const upMs = Date.now() - status.startedAt
  lines.push(`bg-recall — ${status.state} (up ${fmtDur(upMs)})`)
  lines.push(
    `totals: ${status.totals.toolCalls} tool calls · ${status.totals.queries} queries · ${status.totals.hintsFired} hints fired · ${status.totals.rejected} rejected`,
  )
  lines.push("")
  lines.push("sessions:")
  if (status.sessions.length === 0) {
    lines.push("  (none active)")
  } else {
    for (const s of status.sessions) {
      const lastActive = s.lastActivityMs > 0 ? `${fmtDur(Date.now() - s.lastActivityMs)} ago` : "(never)"
      const adoption =
        s.hintsFired === 0 ? "—" : `${s.hintsAdopted}/${s.hintsFired} (${pct(s.hintsAdopted, s.hintsFired)})`
      const rate = s.toolCalls === 0 ? 0 : (s.hintsFired / s.toolCalls) * 100
      lines.push(
        `  ${s.sessionName.padEnd(20)} calls=${s.toolCalls.toString().padStart(4)} hints=${s.hintsFired.toString().padStart(3)} adoption=${adoption.padStart(8)} rate=${rate.toFixed(1)}/100 last=${lastActive}`,
      )
      if (s.topEntities.length > 0) {
        const top = s.topEntities
          .slice(0, 5)
          .map((e) => `${e.entity}×${e.count}`)
          .join(" ")
        lines.push(`    entities: ${top}`)
      }
    }
  }
  lines.push("")
  lines.push("recent hints:")
  if (status.recentHints.length === 0) {
    lines.push("  (none)")
  } else {
    for (const h of status.recentHints.slice(0, 10)) {
      lines.push(
        `  ${fmtTime(h.ts)} → ${h.to.padEnd(15)} [${h.source}] ${trimText(h.title, 50).padEnd(50)} ${h.adoption}`,
      )
    }
  }
  return lines.join("\n")
}

export function formatExplain(decision: Decision): string {
  const lines: string[] = []
  lines.push(`bg-recall explain — hint ${decision.emitted?.id ?? "(no hint)"}`)
  lines.push(`session: ${decision.sessionId} · ts: ${fmtTime(decision.ts)}`)
  lines.push("")
  lines.push("trigger tool call:")
  lines.push(`  tool: ${decision.trigger.tool}`)
  if (decision.trigger.input) lines.push(`  input: ${trimText(decision.trigger.input, 100)}`)
  lines.push("")
  lines.push(`entities (${decision.entities.length}):`)
  lines.push("  " + decision.entities.slice(0, 20).join(", "))
  lines.push("")
  lines.push(`recall queries (${decision.queries.length}):`)
  for (const q of decision.queries) {
    lines.push(`  [${q.source}] "${trimText(q.query, 80)}" → ${q.hits.length} hits (${q.durationMs}ms)`)
  }
  lines.push("")
  lines.push(`top candidates (${decision.candidates.length}):`)
  for (const c of decision.candidates.slice(0, 5)) {
    const reject = c.rejectReason ? ` REJECTED:${c.rejectReason}` : ""
    lines.push(`  ${c.score.toFixed(3)} [${c.hit.source}] ${trimText(c.hit.title, 60)}${reject}`)
  }
  lines.push("")
  if (decision.emitted) {
    lines.push("emitted:")
    lines.push(`  to: ${decision.emitted.to}`)
    lines.push(`  source: ${decision.emitted.source}`)
    lines.push(`  score: ${decision.emitted.hit.score.toFixed(3)}`)
    lines.push(`  components:`)
    const c = decision.emitted.hit.components
    lines.push(
      `    rank=${c.rank.toFixed(3)} overlap=${c.entityOverlap.toFixed(3)} recency=${c.recency.toFixed(3)} reinforcement=${c.reinforcement.toFixed(3)}`,
    )
    lines.push(`  content: ${trimText(decision.emitted.content, 200)}`)
  } else if (decision.rejected) {
    lines.push(
      `rejected: ${decision.rejected.reason}${decision.rejected.detail ? ` (${decision.rejected.detail})` : ""}`,
    )
  }
  return lines.join("\n")
}

function fmtDur(ms: number): string {
  if (!Number.isFinite(ms)) return "?"
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function trimText(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + "…"
}

function pct(num: number, denom: number): string {
  if (denom === 0) return "0%"
  return Math.round((num / denom) * 100) + "%"
}

export { shortPath }
