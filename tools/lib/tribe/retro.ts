/**
 * Tribe Retro — Retrospective report generator for tribe sessions
 *
 * Analyzes tribe message history and generates observability reports
 * with per-member activity, coordination health, and timeline.
 *
 * Used by: tribe-cli.ts `retro` subcommand, tribe MCP tool `tribe_retro`
 */

import type { Database } from "bun:sqlite"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DURATION_MULTIPLIERS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** Parse a duration string like "2h", "30m", "1d" into milliseconds */
export function parseDuration(s: string): number {
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/)
  if (!match) throw new Error(`Invalid duration: "${s}" — use e.g. "2h", "30m", "1d"`)
  return parseFloat(match[1]!) * DURATION_MULTIPLIERS[match[2]!]!
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000)
    const s = Math.round((ms % 60_000) / 1_000)
    return s > 0 ? `${m}m ${s}s` : `${m}m`
  }
  const h = Math.floor(ms / 3_600_000)
  const m = Math.round((ms % 3_600_000) / 60_000)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

const formatTime = (ts: number) =>
  new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
const formatDate = (ts: number) => new Date(ts).toISOString().slice(0, 10)
const snippet = (s: string, n = 80) => (s.length > n ? s.slice(0, n) + "..." : s)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Message {
  id: string
  type: string
  sender: string
  recipient: string
  content: string
  bead_id: string | null
  ref: string | null
  ts: number
}

interface Session {
  id: string
  name: string
  role: string
  domains: string
  started_at: number
  updated_at: number
}

interface MemberMetrics {
  name: string
  role: string
  domains: string[]
  sent: number
  received: number
  byType: Record<string, number>
  beads: Set<string>
  avgResponseMs: number | null
}

export interface RetroReport {
  generated_at: string
  window: { start: number; end: number; duration_ms: number }
  summary: { duration: string; members: number; total_messages: number; by_type: Record<string, number> }
  members: Array<{
    name: string
    role: string
    domains: string[]
    sent: number
    received: number
    beads_mentioned: string[]
    avg_response: string | null
  }>
  timeline: Array<{ time: string; event: string }>
  coordination: {
    unanswered_queries: number
    avg_response_time: string | null
    longest_response: string | null
    longest_response_member: string | null
  }
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

function makeMember(name: string, role: string, domains: string[]): MemberMetrics {
  return { name, role, domains, sent: 0, received: 0, byType: {}, beads: new Set(), avgResponseMs: null }
}

function getOrCreateMember(map: Map<string, MemberMetrics>, name: string): MemberMetrics {
  let m = map.get(name)
  if (!m) {
    m = makeMember(name, "unknown", [])
    map.set(name, m)
  }
  return m
}

/** Match queries to responses: first by explicit ref, then by proximity (next response from recipient) */
function computeResponseTimes(messages: Message[]): { times: Map<string, number[]>; answeredIds: Set<string> } {
  const times = new Map<string, number[]>()
  const answeredIds = new Set<string>()
  const queryMap = new Map<string, { sender: string; ts: number }>()
  const pendingByRecipient = new Map<string, Array<{ id: string; ts: number }>>()

  for (const msg of messages) {
    if (msg.type === "query") {
      queryMap.set(msg.id, { sender: msg.sender, ts: msg.ts })
      if (msg.recipient !== "*") {
        const arr = pendingByRecipient.get(msg.recipient) ?? []
        arr.push({ id: msg.id, ts: msg.ts })
        pendingByRecipient.set(msg.recipient, arr)
      }
    }
    if (msg.type === "response") {
      let queryTs: number | undefined
      // Match by ref
      if (msg.ref && queryMap.has(msg.ref)) {
        queryTs = queryMap.get(msg.ref)!.ts
        answeredIds.add(msg.ref)
      } else {
        // Match by proximity
        const pending = pendingByRecipient.get(msg.sender)
        if (pending && pending.length > 0) {
          const q = pending.shift()!
          queryTs = q.ts
          answeredIds.add(q.id)
        }
      }
      if (queryTs !== undefined) {
        const arr = times.get(msg.sender) ?? []
        arr.push(msg.ts - queryTs)
        times.set(msg.sender, arr)
      }
    }
  }
  return { times, answeredIds }
}

export function generateRetro(db: Database, sinceMs?: number): RetroReport {
  const now = Date.now()
  const windowStart = sinceMs ? now - sinceMs : getEarliestTimestamp(db)
  const windowEnd = now

  // Regular messages only — event rows live in the same table (kind='event')
  // but are handled separately in the timeline section below.
  const messages = db
    .prepare("SELECT * FROM messages WHERE ts >= ? AND kind != 'event' ORDER BY ts ASC")
    .all(windowStart) as Message[]
  const sessions = db
    .prepare("SELECT * FROM sessions WHERE started_at <= ? AND updated_at >= ?")
    .all(windowEnd, windowStart) as Session[]

  // Include sessions that sent messages but might have expired
  const sessionNames = new Set(sessions.map((s) => s.name))
  for (const sender of new Set(messages.map((m) => m.sender))) {
    if (!sessionNames.has(sender)) {
      const s = db.prepare("SELECT * FROM sessions WHERE name = ?").get(sender) as Session | null
      if (s) {
        sessions.push(s)
        sessionNames.add(s.name)
      }
    }
  }

  // Initialize per-member metrics from sessions
  const memberMap = new Map<string, MemberMetrics>()
  for (const s of sessions) memberMap.set(s.name, makeMember(s.name, s.role, JSON.parse(s.domains) as string[]))

  // Count messages and extract beads
  const byType: Record<string, number> = {}
  for (const msg of messages) {
    byType[msg.type] = (byType[msg.type] ?? 0) + 1
    const sender = getOrCreateMember(memberMap, msg.sender)
    sender.sent++
    sender.byType[msg.type] = (sender.byType[msg.type] ?? 0) + 1
    if (msg.bead_id) sender.beads.add(msg.bead_id)
    const beadRefs = msg.content.match(/\bkm-[\w.-]+/g)
    if (beadRefs) for (const ref of beadRefs) sender.beads.add(ref)

    if (msg.recipient === "*") {
      for (const [name, m] of memberMap) {
        if (name !== msg.sender) m.received++
      }
    } else {
      getOrCreateMember(memberMap, msg.recipient).received++
    }
  }

  // Response latencies
  const { times: responseTimes, answeredIds } = computeResponseTimes(messages)
  for (const [name, t] of responseTimes) {
    const member = memberMap.get(name)
    if (member && t.length > 0) member.avgResponseMs = t.reduce((a, b) => a + b, 0) / t.length
  }

  const unansweredQueries = messages.filter((m) => m.type === "query" && !answeredIds.has(m.id)).length
  const allTimes = [...responseTimes.values()].flat()
  const avgResponseTime = allTimes.length > 0 ? allTimes.reduce((a, b) => a + b, 0) / allTimes.length : null
  const longestResponse = allTimes.length > 0 ? Math.max(...allTimes) : null
  let longestResponseMember: string | null = null
  if (longestResponse !== null) {
    for (const [name, t] of responseTimes)
      if (t.includes(longestResponse)) {
        longestResponseMember = name
        break
      }
  }

  // Timeline: events + notable messages. Events now live in `messages` with
  // type `event.<orig-type>`, sender = session name, content = JSON data.
  const timeline: Array<{ time: string; event: string; ts: number }> = []
  const events = db
    .prepare("SELECT type, sender, content, ts FROM messages WHERE kind = 'event' AND ts >= ? ORDER BY ts ASC")
    .all(windowStart) as Array<{
    type: string
    sender: string
    content: string
    ts: number
  }>

  const eventFormatters: Record<string, (ev: (typeof events)[0], data: Record<string, string>) => string | null> = {
    "session.joined": (ev, data) => `${ev.sender} joined (${data.role ?? "member"})`,
    "session.left": (ev) => `${ev.sender} left`,
    "session.renamed": (_, data) => `${data.old_name} renamed to ${data.new_name}`,
    "message.broadcast": (ev) => `${ev.sender} broadcast a message`,
  }
  for (const ev of events) {
    const origType = ev.type.slice("event.".length)
    const fmt = eventFormatters[origType]
    if (fmt) {
      const text = fmt(ev, (ev.content ? JSON.parse(ev.content) : {}) as Record<string, string>)
      if (text) timeline.push({ time: formatTime(ev.ts), event: text, ts: ev.ts })
    }
  }

  const msgFormatters: Record<string, (msg: Message) => string> = {
    assign: (m) => `${m.sender} assigned to ${m.recipient}: ${snippet(m.content)}`,
    request: (m) => `${m.sender} requested from ${m.recipient}: ${snippet(m.content)}`,
    verdict: (m) => `${m.recipient} received verdict: ${snippet(m.content)}`,
  }
  for (const msg of messages) {
    const fmt = msgFormatters[msg.type]
    if (fmt) timeline.push({ time: formatTime(msg.ts), event: fmt(msg), ts: msg.ts })
  }
  timeline.sort((a, b) => a.ts - b.ts)

  const memberList = [...memberMap.values()]
    .filter((m) => m.sent > 0 || m.received > 0)
    .sort((a, b) => b.sent - a.sent)
    .map((m) => ({
      name: m.name,
      role: m.role,
      domains: m.domains,
      sent: m.sent,
      received: m.received,
      beads_mentioned: [...m.beads].sort(),
      avg_response: m.avgResponseMs !== null ? formatDuration(m.avgResponseMs) : null,
    }))

  const durationMs = windowEnd - windowStart
  return {
    generated_at: new Date().toISOString(),
    window: { start: windowStart, end: windowEnd, duration_ms: durationMs },
    summary: {
      duration: formatDuration(durationMs),
      members: memberList.length,
      total_messages: messages.length,
      by_type: byType,
    },
    members: memberList,
    timeline: timeline.map(({ time, event }) => ({ time, event })),
    coordination: {
      unanswered_queries: unansweredQueries,
      avg_response_time: avgResponseTime !== null ? formatDuration(avgResponseTime) : null,
      longest_response: longestResponse !== null ? formatDuration(longestResponse) : null,
      longest_response_member: longestResponseMember,
    },
  }
}

function getEarliestTimestamp(db: Database): number {
  const row = db.prepare("SELECT MIN(ts) as min_ts FROM messages").get() as { min_ts: number | null } | null
  if (row?.min_ts) return row.min_ts
  const session = db.prepare("SELECT MIN(started_at) as min_ts FROM sessions").get() as { min_ts: number | null } | null
  return session?.min_ts ?? Date.now()
}

// ---------------------------------------------------------------------------
// Markdown formatter
// ---------------------------------------------------------------------------

export function formatMarkdown(report: RetroReport): string {
  const lines: string[] = []
  lines.push(`# Tribe Retro — ${formatDate(report.window.start)}`, "")
  lines.push("## Summary")
  lines.push(`- Duration: ${report.summary.duration}`)
  lines.push(`- Members: ${report.summary.members} active (${report.members.map((m) => m.name).join(", ")})`)
  const typeBreakdown = Object.entries(report.summary.by_type)
    .map(([t, c]) => `${c} ${t}`)
    .join(", ")
  lines.push(`- Messages: ${report.summary.total_messages} total (${typeBreakdown})`, "")

  if (report.members.length > 0) {
    lines.push("## Per-Member Activity")
    lines.push("| Member | Sent | Received | Beads Mentioned | Avg Response |")
    lines.push("|--------|------|----------|-----------------|--------------|")
    for (const m of report.members)
      lines.push(
        `| ${m.name} | ${m.sent} | ${m.received} | ${m.beads_mentioned.length} | ${m.avg_response ?? "\u2014"} |`,
      )
    lines.push("")
  }

  if (report.timeline.length > 0) {
    lines.push("## Timeline")
    for (const ev of report.timeline) lines.push(`- ${ev.time} \u2014 ${ev.event}`)
    lines.push("")
  }

  lines.push("## Coordination Health")
  lines.push(`- Unanswered queries: ${report.coordination.unanswered_queries}`)
  lines.push(`- Average response time: ${report.coordination.avg_response_time ?? "\u2014"}`)
  if (report.coordination.longest_response)
    lines.push(
      `- Longest response: ${report.coordination.longest_response} (${report.coordination.longest_response_member})`,
    )
  lines.push("")
  return lines.join("\n")
}
