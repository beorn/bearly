/**
 * Daily and weekly summary rollups from per-session summaries.
 *
 * Hierarchical summarization (3 tiers):
 * 1. summarize-session.ts produces cached per-session summaries
 * 2. Daily rollups synthesize sessions with beads activity, git commits,
 *    prior-day mistakes, and MEMORY.md cross-reference
 * 3. Weekly rollups synthesize daily summaries into themes and trends
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { getDb, closeDb } from "../lib/history/db"
import { summarizeSessionBatch, type SessionSummary } from "./summarize-session"
import { findSessionJsonl } from "./extract"
import { getCheapModel } from "../lib/llm/types"
import { queryModel } from "../lib/llm/research"
import { isProviderAvailable } from "../lib/llm/providers"
import { createRetroBeads } from "./summarize-beads"

// ============================================================================
// Types
// ============================================================================

export interface DailySummaryResult {
  date: string
  sessionsCount: number
  summary: string | null
  memoryFile: string | null
  skipped: boolean
  reason?: string
  beadsCreated?: number
}

interface SessionRecord {
  id: string
  title: string
  project_path: string
  message_count: number
  created_at: number
  updated_at: number
}

// ============================================================================
// Constants
// ============================================================================

const DAILY_SUMMARY_PROMPT = `You are summarizing a full day of Claude Code development sessions. Your audience is the developer reviewing what happened and an AI search index for future recall.

Produce a concise daily summary with these sections (skip empty sections):

## Key Decisions
Decisions made and their rationale. Be specific — include file names, function names, package names.

## Bugs Found
Bugs discovered, their root causes, and fixes applied.

## Mistakes & Dead Ends
Wrong approaches tried, debugging dead ends, misconceptions. For each: what was tried, why it failed, what the fix was. Preserve any [minor]/[moderate]/[major] severity tags from session data. OMIT this section entirely if no real mistakes occurred.

## Lessons Learned
Insights gained, patterns discovered, non-obvious things that worked. OMIT this section if nothing genuinely novel was learned.

Each lesson must be:
- FORWARD-LOOKING: A rule or check for future sessions, not a description of what was done today
- SPECIFIC: Name the file, function, or pattern — not "centralizing things is good"
- NOVEL: Not already obvious from CLAUDE.md, skill docs, or common engineering practice
- ACTIONABLE: Phrased as "When X, do Y" or "Always Z before W"
Bad: "Centralizing UI assets reduces duplication" (too generic)
Bad: "Implemented fullscreen-ink" (past tense, already done)
Good: "When editing TreeNode rendering, always test with HR nodes — they use content-based detection (HR_PATTERN) not node.type"

## Architecture Changes
Structural changes, new patterns adopted, refactoring done.

## Open Questions
Unresolved issues, things to revisit, potential follow-up work.

## Recurring Patterns
Compare today's mistakes with the prior-days mistakes provided (if any). If ANY mistake repeats (same root cause, same tool/workflow):
- State what recurs and how many times (e.g., "3rd occurrence in 4 days")
- Give a concrete, actionable prevention (a specific check, script, or workflow change — not "be more careful")
OMIT this section if no prior-days context was provided or no patterns detected.

## Memory Updates
Compare today's lessons with the current MEMORY.md provided (if any). Only flag items that would save 10+ minutes if remembered next time:
- NEW: A lesson not already in MEMORY.md. Write a ready-to-paste entry (heading + 1-3 lines). Must be forward-looking ("When X, do Y"), not a description of today's work ("Added X to Y").
- OUTDATED: Quote the specific MEMORY.md text that today's work contradicts, and explain why.
Maximum 2 items. Quality over quantity. OMIT if no MEMORY.md was provided or no updates needed.

NEW items must pass these filters:
- Contains a specific file path, function name, or concrete pattern (not generic advice)
- Is phrased as a future instruction, not a past-tense description
- Would actually prevent a mistake or save time — not just "X is good practice"

Rules:
- Be concise: 3-6 bullets per section maximum
- Each bullet should be 1-2 sentences
- Include specific file paths, function names, and package names when mentioned
- Tag each bullet with [session-ref:SHORT_ID] where SHORT_ID is the first 8 chars of the session that produced it
- If multiple sessions contribute to the same point, list all refs: [session-ref:AAA,BBB]
- Tag each bullet with one topic: [ui], [testing], [infra], [storage], [tooling], [docs], or [design]
- Skip routine operations (file reads, test runs, linting)
- If truly nothing noteworthy happened, respond with just: NONE
- Do NOT invent information not present in the session data`

// ============================================================================
// Core: summarize a single day
// ============================================================================

export async function summarizeDay(
  date: string,
  opts: { projectFilter?: string; verbose?: boolean } = {},
): Promise<DailySummaryResult> {
  const log = opts.verbose ? (msg: string) => console.error(`[summarize] ${msg}`) : () => {}

  log(`summarizing ${date}...`)

  // Parse date to get day boundaries (local time)
  const dayStart = new Date(`${date}T00:00:00`)
  const dayEnd = new Date(`${date}T23:59:59.999`)
  if (isNaN(dayStart.getTime())) {
    return {
      date,
      sessionsCount: 0,
      summary: null,
      memoryFile: null,
      skipped: true,
      reason: "invalid_date",
    }
  }

  const startMs = dayStart.getTime()
  const endMs = dayEnd.getTime()

  // Query sessions for this day
  const db = getDb()
  let rows: SessionRecord[]
  try {
    const query = opts.projectFilter
      ? `SELECT id, title, project_path, message_count, created_at, updated_at
         FROM sessions WHERE updated_at >= ? AND updated_at <= ? AND project_path LIKE ?
         ORDER BY created_at ASC`
      : `SELECT id, title, project_path, message_count, created_at, updated_at
         FROM sessions WHERE updated_at >= ? AND updated_at <= ?
         ORDER BY created_at ASC`

    const params = opts.projectFilter ? [startMs, endMs, `%${opts.projectFilter}%`] : [startMs, endMs]

    rows = db.prepare(query).all(...params) as SessionRecord[]
  } finally {
    closeDb()
  }

  if (rows.length === 0) {
    log(`no sessions found for ${date}`)
    return {
      date,
      sessionsCount: 0,
      summary: null,
      memoryFile: null,
      skipped: true,
      reason: "no_sessions",
    }
  }

  // Filter meaningful sessions (> 5KB JSONL)
  const meaningfulSessions = rows.filter((s) => {
    const jsonlPath = findSessionJsonl(s.id)
    if (!jsonlPath) return false
    try {
      return fs.statSync(jsonlPath).size > 5_000
    } catch {
      return false
    }
  })
  log(`${rows.length} total sessions, ${meaningfulSessions.length} meaningful (>5KB)`)

  if (meaningfulSessions.length === 0) {
    log(`no meaningful sessions for ${date}`)
    return {
      date,
      sessionsCount: rows.length,
      summary: null,
      memoryFile: null,
      skipped: true,
      reason: "no_meaningful_sessions",
    }
  }

  // Get per-session summaries (cached via summarize-session)
  const sessionSummaries = await summarizeSessionBatch(
    meaningfulSessions.map((s) => ({
      id: s.id,
      title: s.title ?? null,
      createdAt: s.created_at,
    })),
    { verbose: opts.verbose },
  )

  // Filter out sub-agent sessions and sessions with null summary
  const usableSummaries = sessionSummaries.filter((s) => !s.isSubAgent && s.summary != null)
  log(`${sessionSummaries.length} session summaries, ${usableSummaries.length} usable (non-sub-agent with content)`)

  if (usableSummaries.length === 0) {
    log(`no usable session summaries for ${date}`)
    return {
      date,
      sessionsCount: rows.length,
      summary: null,
      memoryFile: null,
      skipped: true,
      reason: "no_content",
    }
  }

  // Extract beads activity + git commits
  const beadsContent = await extractBeadsActivity(startMs, endMs, log)
  const gitContent = await extractGitCommits(date, log)

  // Build LLM context from per-session summaries
  const totalMessages = meaningfulSessions.reduce((s, sess) => s + (sess.message_count || 0), 0)
  const projects = [...new Set(meaningfulSessions.map((s) => s.project_path))]

  let context = `# Daily Development Summary: ${date}\n\n`
  context += `${meaningfulSessions.length} sessions, ${totalMessages} messages across ${projects.length} project(s): ${projects.map(displayProject).join(", ")}\n\n`

  // Add cross-reference context first (survives truncation)
  const priorMistakes = extractPriorMistakes(date, log)
  if (priorMistakes) {
    context += `${priorMistakes}\n\n`
  }

  const memoryMd = loadMemoryMd(log)
  if (memoryMd) {
    context += `${memoryMd}\n\n`
  }

  if (beadsContent) {
    context += `${beadsContent}\n`
  }
  if (gitContent) {
    context += `${gitContent}\n`
  }

  // Session summaries last (largest, most expendable under truncation)
  for (const s of usableSummaries) {
    const titlePart = s.title ? ` — ${s.title}` : ""
    context += `### Session ${s.shortId} (${s.time})${titlePart}\n\n${s.summary}\n\n`
  }

  // Truncate to ~30KB for LLM context
  if (context.length > 30000) {
    context = context.slice(0, 30000) + "\n\n[...truncated]"
  }

  log(`LLM context: ${context.length} chars from ${usableSummaries.length} sessions`)

  // Check LLM availability
  const model = getCheapModel()
  if (!model || !isProviderAvailable(model.provider)) {
    log(`no LLM provider available`)
    return {
      date,
      sessionsCount: rows.length,
      summary: null,
      memoryFile: null,
      skipped: true,
      reason: "no_llm_provider",
    }
  }

  // Synthesize
  const llmStart = Date.now()
  const result = await queryModel({
    question: context,
    model,
    systemPrompt: DAILY_SUMMARY_PROMPT,
  })
  const synthesis = result.response.content
  log(`LLM responded in ${Date.now() - llmStart}ms`)

  if (!synthesis || /^NONE$/im.test(synthesis.trim())) {
    log(`nothing noteworthy for ${date}`)
    return {
      date,
      sessionsCount: rows.length,
      summary: null,
      memoryFile: null,
      skipped: true,
      reason: "nothing_noteworthy",
    }
  }

  // Write the daily summary file
  const memoryDir = getSessionMemoryDir()
  fs.mkdirSync(memoryDir, { recursive: true })

  const memoryFile = path.join(memoryDir, `${date}.md`)
  const msgInfo = totalMessages > 0 ? `, ${totalMessages} messages` : ""
  const header = `# ${date}\n\n${meaningfulSessions.length} sessions${msgInfo} | ${projects.map(displayProject).join(", ")}\n\n`
  const sessionsIndex = buildSessionIndex(usableSummaries)

  fs.writeFileSync(memoryFile, header + synthesis + "\n\n" + sessionsIndex)

  log(`wrote ${memoryFile}`)

  // Create retro bead with actionable items
  let beadsCreated: number | undefined
  const beadResult = await createRetroBeads(synthesis, {
    date,
    summaryFile: memoryFile,
    verbose: opts.verbose,
  })
  if (beadResult?.created) {
    beadsCreated = beadResult.itemCount
    log(`retro bead: ${beadResult.beadId} with ${beadResult.itemCount} items`)
  }

  return {
    date,
    sessionsCount: rows.length,
    summary: synthesis,
    memoryFile,
    skipped: false,
    beadsCreated,
  }
}

// ============================================================================
// Detect unprocessed days and summarize them
// ============================================================================

export async function summarizeUnprocessedDays(
  opts: { limit?: number; verbose?: boolean; projectFilter?: string } = {},
): Promise<DailySummaryResult[]> {
  const limit = opts.limit ?? 10
  const log = opts.verbose ? (msg: string) => console.error(`[summarize] ${msg}`) : () => {}

  const memoryDir = getSessionMemoryDir()
  const existingSummaries = new Set<string>()

  if (fs.existsSync(memoryDir)) {
    for (const entry of fs.readdirSync(memoryDir)) {
      if (entry.endsWith(".md")) {
        existingSummaries.add(entry.replace(/\.md$/, ""))
      }
    }
  }

  // Get distinct days from sessions table (90-day lookback — the limit param caps results)
  const db = getDb()
  let days: string[]
  try {
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000
    const dbRows = db
      .prepare(
        `SELECT DISTINCT date(updated_at / 1000, 'unixepoch', 'localtime') as day
         FROM sessions WHERE updated_at >= ?
         ORDER BY day DESC`,
      )
      .all(ninetyDaysAgo) as { day: string }[]
    days = dbRows.map((r) => r.day)
  } finally {
    closeDb()
  }

  // Filter out today (still in progress) and already-summarized days
  const today = localDateStr(new Date())
  const unprocessed = days.filter((d) => d !== today && !existingSummaries.has(d)).slice(0, limit)

  if (unprocessed.length === 0) {
    log(`no unprocessed days found`)
    return []
  }

  log(`${unprocessed.length} unprocessed day(s): ${unprocessed.join(", ")}`)

  const results: DailySummaryResult[] = []
  for (const day of unprocessed) {
    const r = await summarizeDay(day, opts)
    results.push(r)
  }

  return results
}

// ============================================================================
// CLI command
// ============================================================================

export async function cmdSummarize(
  dateArg?: string,
  opts: { verbose?: boolean; project?: string } = {},
): Promise<void> {
  if (dateArg) {
    const resolved = resolveDate(dateArg)
    const result = await summarizeDay(resolved, {
      verbose: true,
      projectFilter: opts.project,
    })

    if (result.skipped) {
      console.error(`Skipped ${resolved}: ${result.reason}`)
      return
    }

    console.log(result.summary)
    console.error(`\nWrote: ${result.memoryFile}`)
    if (result.beadsCreated) {
      console.error(`Retro bead created (${result.beadsCreated} items)`)
    }
  } else {
    const results = await summarizeUnprocessedDays({
      verbose: true,
      projectFilter: opts.project,
    })

    if (results.length === 0) {
      console.log("All recent days are already summarized.")
      return
    }

    for (const result of results) {
      if (result.skipped) {
        console.error(`${result.date}: skipped (${result.reason})`)
      } else {
        console.error(`${result.date}: ${result.sessionsCount} sessions → ${result.memoryFile}`)
      }
    }

    const latest = results.find((r) => !r.skipped)
    if (latest?.summary) {
      console.log(`\n${"=".repeat(60)}`)
      console.log(`Daily Summary: ${latest.date}`)
      console.log(`${"=".repeat(60)}\n`)
      console.log(latest.summary)
    }
  }
}

// ============================================================================
// Weekly rollup
// ============================================================================

const WEEKLY_SUMMARY_PROMPT = `You are summarizing a full week of software development from daily summaries. Your audience is the developer reviewing weekly progress and an AI search index.

Produce a concise weekly summary with these sections (skip empty sections):

## Themes
What were the main areas of work this week? Group related daily work into 3-5 themes with a 1-2 sentence description each.

## Key Accomplishments
The most significant things completed this week: features shipped, bugs squashed, architecture improvements landed.

## Recurring Problems
Mistakes or issues that appeared on multiple days. State frequency and whether the root cause was addressed or still open.

## Lessons Worth Keeping
The 2-3 most valuable insights from the week — things that should be remembered long-term. Only genuinely novel or high-impact lessons.

## Next Week
Unresolved issues, open questions, and follow-up work carried forward.

Rules:
- Be concise: 3-5 bullets per section
- Tag each bullet with the day(s) it came from: [day:YYYY-MM-DD] or [day:YYYY-MM-DD,YYYY-MM-DD]
- Tag each bullet with one topic: [ui], [testing], [infra], [storage], [tooling], [docs], or [design]
- Do NOT invent information not present in the daily summaries
- If truly nothing noteworthy happened, respond with just: NONE`

export interface WeeklySummaryResult {
  weekStart: string
  weekEnd: string
  daysIncluded: number
  summary: string | null
  memoryFile: string | null
  skipped: boolean
  reason?: string
}

export async function summarizeWeek(weekOf: string, opts: { verbose?: boolean } = {}): Promise<WeeklySummaryResult> {
  const log = opts.verbose ? (msg: string) => console.error(`[weekly] ${msg}`) : () => {}

  // Parse the date and find the Monday of that week
  const target = new Date(`${weekOf}T12:00:00`)
  const dayOfWeek = target.getDay()
  const monday = new Date(target)
  monday.setDate(target.getDate() - ((dayOfWeek + 6) % 7))
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)

  const weekStart = localDateStr(monday)
  const weekEnd = localDateStr(sunday)
  log(`week: ${weekStart} to ${weekEnd}`)

  // Read daily summaries for this week
  const memoryDir = getSessionMemoryDir()
  const dailySummaries: string[] = []
  const daysIncluded: string[] = []

  for (let i = 0; i < 7; i++) {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    const dayStr = localDateStr(d)
    const filePath = path.join(memoryDir, `${dayStr}.md`)

    try {
      let content = fs.readFileSync(filePath, "utf8")
      // Strip the sessions index (everything after "---\n## Sessions")
      // which can be 50%+ of the file and isn't useful for weekly synthesis
      content = content.replace(/\n---\n## Sessions[\s\S]*$/, "")
      dailySummaries.push(content)
      daysIncluded.push(dayStr)
    } catch {
      // No summary for this day
    }
  }

  if (dailySummaries.length === 0) {
    log(`no daily summaries found for week ${weekStart}`)
    return {
      weekStart,
      weekEnd,
      daysIncluded: 0,
      summary: null,
      memoryFile: null,
      skipped: true,
      reason: "no_daily_summaries",
    }
  }

  log(`found ${dailySummaries.length} daily summaries: ${daysIncluded.join(", ")}`)

  // Build context — budget each day equally to avoid skew
  const WEEKLY_BUDGET = 28000 // leave room for header
  const perDayBudget = Math.floor(WEEKLY_BUDGET / dailySummaries.length)

  let context = `# Weekly Development Summary: ${weekStart} to ${weekEnd}\n\n`
  context += `${dailySummaries.length} days with activity\n\n`
  for (const content of dailySummaries) {
    if (content.length > perDayBudget) {
      context += `${content.slice(0, perDayBudget)}\n[...day truncated]\n\n---\n\n`
    } else {
      context += `${content}\n\n---\n\n`
    }
  }

  log(`LLM context: ${context.length} chars`)

  const model = getCheapModel()
  if (!model || !isProviderAvailable(model.provider)) {
    log(`no LLM provider available`)
    return {
      weekStart,
      weekEnd,
      daysIncluded: dailySummaries.length,
      summary: null,
      memoryFile: null,
      skipped: true,
      reason: "no_llm_provider",
    }
  }

  const llmStart = Date.now()
  const result = await queryModel({
    question: context,
    model,
    systemPrompt: WEEKLY_SUMMARY_PROMPT,
  })
  const synthesis = result.response.content
  log(`LLM responded in ${Date.now() - llmStart}ms`)

  if (!synthesis || /^NONE$/im.test(synthesis.trim())) {
    log(`nothing noteworthy for week ${weekStart}`)
    return {
      weekStart,
      weekEnd,
      daysIncluded: dailySummaries.length,
      summary: null,
      memoryFile: null,
      skipped: true,
      reason: "nothing_noteworthy",
    }
  }

  // Write weekly summary
  fs.mkdirSync(memoryDir, { recursive: true })
  const memoryFile = path.join(memoryDir, `week-${weekStart}.md`)
  const header = `# Week of ${weekStart}\n\n${dailySummaries.length} days | ${daysIncluded.join(", ")}\n\n`
  fs.writeFileSync(memoryFile, header + synthesis + "\n")

  log(`wrote ${memoryFile}`)

  return {
    weekStart,
    weekEnd,
    daysIncluded: dailySummaries.length,
    summary: synthesis,
    memoryFile,
    skipped: false,
  }
}

export async function cmdWeekly(weekOf?: string, opts: { verbose?: boolean } = {}): Promise<void> {
  // Default to last week (most recent complete week)
  if (!weekOf) {
    const lastWeek = new Date()
    lastWeek.setDate(lastWeek.getDate() - 7)
    weekOf = localDateStr(lastWeek)
  } else {
    weekOf = resolveDate(weekOf)
  }

  const result = await summarizeWeek(weekOf, { verbose: true })

  if (result.skipped) {
    console.error(`Skipped week of ${result.weekStart}: ${result.reason}`)
    return
  }

  console.log(result.summary)
  console.error(`\nWrote: ${result.memoryFile}`)
}

// ============================================================================
// Show existing summaries
// ============================================================================

export async function cmdShow(dateArg?: string): Promise<void> {
  const memoryDir = getSessionMemoryDir()

  if (!fs.existsSync(memoryDir)) {
    console.error("No summaries found. Run `bun recall summarize` first.")
    return
  }

  // "week" → show latest weekly summary
  if (dateArg === "week") {
    const weekFiles = fs
      .readdirSync(memoryDir)
      .filter((f) => f.startsWith("week-") && f.endsWith(".md"))
      .sort()
    if (weekFiles.length === 0) {
      console.error("No weekly summaries found. Run `bun recall weekly` first.")
      return
    }
    const latest = weekFiles[weekFiles.length - 1]!
    console.log(fs.readFileSync(path.join(memoryDir, latest), "utf8"))
    return
  }

  // Specific date → show that day
  if (dateArg) {
    dateArg = resolveDate(dateArg)
    const filePath = path.join(memoryDir, `${dateArg}.md`)
    if (!fs.existsSync(filePath)) {
      console.error(`No summary for ${dateArg}. Run \`bun recall summarize ${dateArg}\` to generate.`)
      return
    }
    console.log(fs.readFileSync(filePath, "utf8"))
    return
  }

  // No arg → list available summaries
  const files = fs
    .readdirSync(memoryDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse()

  const dailies = files.filter((f) => !f.startsWith("week-"))
  const weeklies = files.filter((f) => f.startsWith("week-"))

  if (weeklies.length > 0) {
    console.log("Weekly summaries:")
    for (const f of weeklies) {
      console.log(`  ${f.replace(".md", "")}`)
    }
    console.log()
  }

  console.log("Daily summaries:")
  for (const f of dailies.slice(0, 14)) {
    console.log(`  ${f.replace(".md", "")}`)
  }
  if (dailies.length > 14) {
    console.log(`  ... and ${dailies.length - 14} more`)
  }

  console.log(`\nUsage: bun recall show <date>     # e.g. bun recall show 2026-02-06`)
  console.log(`       bun recall show week       # latest weekly summary`)
}

// ============================================================================
// Helpers
// ============================================================================

function getSessionMemoryDir(): string {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const encodedPath = projectDir.replace(/\//g, "-")
  return path.join(os.homedir(), ".claude", "projects", encodedPath, "memory", "sessions")
}

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/** Resolve date keywords (today, yesterday, N-days-ago) to YYYY-MM-DD strings. */
function resolveDate(dateArg: string): string {
  const lower = dateArg.toLowerCase()
  if (lower === "today") return localDateStr(new Date())
  if (lower === "yesterday") {
    const d = new Date()
    d.setDate(d.getDate() - 1)
    return localDateStr(d)
  }
  // "3d" or "3-days-ago" style
  const daysAgoMatch = lower.match(/^(\d+)(?:d|-days?-ago)$/)
  if (daysAgoMatch) {
    const d = new Date()
    d.setDate(d.getDate() - Number(daysAgoMatch[1]))
    return localDateStr(d)
  }
  return dateArg
}

function displayProject(projectPath: string): string {
  return projectPath.replace(/^-Users-beorn-/, "~/").replace(/-/g, "/")
}

function buildSessionIndex(sessions: SessionSummary[]): string {
  const lines = ["---", "## Sessions\n"]
  for (const s of sessions) {
    const title = s.title || "untitled"
    const cached = s.cached ? " (cached)" : ""
    lines.push(`- \`${s.shortId}\` ${s.time} — ${title}${cached}`)
  }
  return lines.join("\n") + "\n"
}

async function extractBeadsActivity(
  startMs: number,
  endMs: number,
  log: (msg: string) => void,
): Promise<string | null> {
  const db = getDb()
  try {
    const beadRows = db
      .prepare(
        `SELECT title, content, source_id FROM content
         WHERE content_type = 'bead' AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp ASC LIMIT 20`,
      )
      .all(startMs, endMs) as {
      title: string
      content: string
      source_id: string
    }[]

    if (beadRows.length === 0) return null

    log(`${beadRows.length} beads active on this day`)

    const lines = ["### Beads Activity\n"]
    for (const r of beadRows) {
      const snippet = r.content.length > 500 ? r.content.slice(0, 500) + "..." : r.content
      lines.push(`**${r.title}** (${r.source_id})\n${snippet}\n`)
    }
    return lines.join("\n")
  } catch {
    return null
  } finally {
    closeDb()
  }
}

function extractPriorMistakes(date: string, log: (msg: string) => void): string | null {
  const memoryDir = getSessionMemoryDir()
  if (!fs.existsSync(memoryDir)) return null

  // Parse the target date and look back 3 days
  const targetDate = new Date(`${date}T12:00:00`)
  const priorMistakes: string[] = []

  for (let i = 1; i <= 3; i++) {
    const d = new Date(targetDate)
    d.setDate(d.getDate() - i)
    const dayStr = localDateStr(d)
    const filePath = path.join(memoryDir, `${dayStr}.md`)

    try {
      const content = fs.readFileSync(filePath, "utf8")
      // Extract "## Mistakes & Dead Ends" section
      const match = content.match(/## Mistakes & Dead Ends\n([\s\S]*?)(?=\n## |\n---|\n$)/)
      if (match?.[1]?.trim()) {
        priorMistakes.push(`**${dayStr}:**\n${match[1].trim()}`)
      }
    } catch {
      // File doesn't exist — skip
    }
  }

  if (priorMistakes.length === 0) return null

  log(`found prior mistakes from ${priorMistakes.length} recent day(s)`)
  return `### Prior Mistakes (recent days)\n\n${priorMistakes.join("\n\n")}`
}

function loadMemoryMd(log: (msg: string) => void): string | null {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const encodedPath = projectDir.replace(/\//g, "-")
  const memoryPath = path.join(os.homedir(), ".claude", "projects", encodedPath, "memory", "MEMORY.md")

  try {
    let content = fs.readFileSync(memoryPath, "utf8")
    // Truncate to ~4KB to fit within context budget
    if (content.length > 4000) {
      content = content.slice(0, 4000) + "\n\n[...truncated]"
    }
    log(`loaded MEMORY.md (${content.length} chars)`)
    return `### Current MEMORY.md\n\n${content}`
  } catch {
    return null
  }
}

async function extractGitCommits(date: string, log: (msg: string) => void): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      ["git", "log", `--after=${date}T00:00:00`, `--before=${date}T23:59:59`, "--oneline", "--no-merges", "-30"],
      {
        cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const stdout = await new Response(proc.stdout).text()
    await proc.exited

    if (!stdout.trim()) return null

    const lines = stdout.trim().split("\n")
    log(`${lines.length} git commits on ${date}`)

    return `### Git Commits\n\n\`\`\`\n${stdout.trim()}\n\`\`\``
  } catch {
    return null
  }
}
