/**
 * Parse actionable items from daily summaries and create retro beads.
 *
 * After a daily summary is generated, this module extracts lessons learned,
 * memory updates, and recurring patterns, then creates a single retro bead
 * per day with all actionable items in the description.
 *
 * Idempotent: if `retro-YYYY-MM-DD` already exists, creation is skipped.
 */

import * as fs from "fs"
import * as path from "path"

// ============================================================================
// Types
// ============================================================================

export interface ActionableItem {
  section: "lesson" | "memory" | "pattern"
  text: string
}

export interface RetroBeadResult {
  created: boolean
  skipped: boolean
  itemCount: number
  beadId: string
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * Extract actionable items from a daily summary markdown string.
 *
 * Sections parsed:
 * - Lessons Learned → all bullets
 * - Memory Updates → only NEW: and OUTDATED: lines
 * - Recurring Patterns → skip "No exact recurrence" filler
 */
export function parseActionableItems(summary: string): ActionableItem[] {
  const items: ActionableItem[] = []

  const sections = extractSections(summary, ["Lessons Learned", "Memory Updates", "Recurring Patterns"])

  // Lessons Learned: all bullets (filtered for quality)
  for (const bullet of extractBullets(sections["Lessons Learned"] ?? "")) {
    const cleaned = cleanBullet(bullet)
    if (isLowValueItem(cleaned)) continue
    items.push({ section: "lesson", text: cleaned })
  }

  // Memory Updates: only NEW: and OUTDATED: lines (filtered for quality)
  for (const bullet of extractBullets(sections["Memory Updates"] ?? "")) {
    if (/^(NEW|OUTDATED):/i.test(bullet.trim())) {
      const cleaned = cleanBullet(bullet)
      if (isLowValueItem(cleaned)) continue
      items.push({ section: "memory", text: cleaned })
    }
  }

  // Recurring Patterns: skip filler
  for (const bullet of extractBullets(sections["Recurring Patterns"] ?? "")) {
    const trimmed = bullet.trim().toLowerCase()
    if (
      trimmed.includes("no exact recurrence") ||
      trimmed.includes("no exact repeat") ||
      trimmed.includes("no prior-days context")
    ) {
      continue
    }
    const cleaned = cleanBullet(bullet)
    if (isLowValueItem(cleaned)) continue
    items.push({ section: "pattern", text: cleaned })
  }

  return items
}

/** Extract named sections from markdown (content between ## headers). */
function extractSections(md: string, names: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of names) {
    // Match section header and content up to next ## or --- or end
    const pattern = new RegExp(`## ${escapeRegex(name)}\\n([\\s\\S]*?)(?=\\n## |\\n---|$)`)
    const match = md.match(pattern)
    if (match?.[1]?.trim()) {
      result[name] = match[1].trim()
    }
  }
  return result
}

/** Extract top-level bullets (handles multi-line continuation with 2-space indent). */
function extractBullets(section: string): string[] {
  const bullets: string[] = []
  const lines = section.split("\n")
  let current: string | null = null

  for (const line of lines) {
    if (line.startsWith("- ")) {
      if (current !== null) bullets.push(current)
      current = line.slice(2)
    } else if (current !== null && /^ {2}\S/.test(line)) {
      // Continuation line (2-space indent)
      current += " " + line.trim()
    } else {
      if (current !== null) bullets.push(current)
      current = null
    }
  }
  if (current !== null) bullets.push(current)

  return bullets
}

/** Strip session-ref tags and topic tags, trim whitespace. */
function cleanBullet(text: string): string {
  return text
    .replace(/\[session-ref:[^\]]*\]/g, "")
    .replace(/\[(ui|testing|infra|storage|tooling|docs|design|memory)\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Past-tense verbs that indicate a description of completed work, not a forward-looking lesson. */
const PAST_TENSE_STARTS =
  /^(implemented|added|fixed|moved|created|refactored|removed|updated|migrated|extracted|centralized|consolidated|introduced|switched|converted|replaced|enabled|disabled)\b/i

/**
 * Filter out low-value items:
 * - Starts with past-tense verb (describes what was done, not what to do next)
 * - Too short (<20 chars) to be specific
 * - No concrete reference (file path, function name, or specific action)
 */
function isLowValueItem(text: string): boolean {
  if (text.length < 20) return true
  if (PAST_TENSE_STARTS.test(text)) return true
  return false
}

// ============================================================================
// Bead creation
// ============================================================================

/**
 * Create a single retro bead for a day's summary.
 *
 * Skips if:
 * - No `.beads/beads.db` in project dir
 * - `bd` binary not on PATH
 * - `retro-YYYY-MM-DD` bead already exists (idempotent)
 * - No actionable items found
 */
export async function createRetroBeads(
  summary: string,
  opts: { date: string; summaryFile: string; verbose?: boolean },
): Promise<RetroBeadResult | null> {
  const log = opts.verbose ? (msg: string) => console.error(`[retro-beads] ${msg}`) : () => {}

  // Check prerequisites
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const beadsDb = path.join(projectDir, ".beads", "beads.db")
  if (!fs.existsSync(beadsDb)) {
    log("no .beads/beads.db found, skipping retro beads")
    return null
  }

  if (!(await isBdAvailable())) {
    log("bd binary not on PATH, skipping retro beads")
    return null
  }

  // Detect project bead prefix from .beads config
  const beadPrefix = await detectBeadPrefix()
  const beadId = beadPrefix ? `${beadPrefix}-retro.${opts.date}` : `retro-${opts.date}`

  // Idempotency: check if bead already exists
  if (await beadExists(beadId)) {
    log(`${beadId} already exists, skipping`)
    return { created: false, skipped: true, itemCount: 0, beadId }
  }

  // Parse actionable items
  const items = parseActionableItems(summary)
  if (items.length === 0) {
    log("no actionable items found, skipping")
    return { created: false, skipped: true, itemCount: 0, beadId }
  }

  // Cap at 5 items
  const capped = items.slice(0, 5)
  log(`${items.length} actionable items found, using ${capped.length}`)

  // Build bead description
  const title = `Retro: ${opts.date}`
  const description = buildDescription(capped, opts.summaryFile)

  // Create the bead
  await bdCreate(beadId, title, description)
  log(`created ${beadId} with ${capped.length} items`)

  return { created: true, skipped: false, itemCount: capped.length, beadId }
}

function buildDescription(items: ActionableItem[], summaryFile: string): string {
  const grouped: Record<string, ActionableItem[]> = {}
  for (const item of items) {
    ;(grouped[item.section] ??= []).push(item)
  }

  const lines: string[] = ["Review and apply these learnings to skills/docs/MEMORY.md:", ""]

  if (grouped.memory?.length) {
    lines.push("**Update MEMORY.md:**")
    for (const item of grouped.memory) {
      lines.push(`- [ ] ${item.text}`)
    }
    lines.push("")
  }

  if (grouped.lesson?.length) {
    lines.push("**Add to skills/docs:**")
    for (const item of grouped.lesson) {
      lines.push(`- [ ] ${item.text}`)
    }
    lines.push("")
  }

  if (grouped.pattern?.length) {
    lines.push("**Prevent recurring patterns:**")
    for (const item of grouped.pattern) {
      lines.push(`- [ ] ${item.text}`)
    }
    lines.push("")
  }

  lines.push(`Source: ${summaryFile}`)

  return lines.join("\n")
}

// ============================================================================
// bd CLI helpers
// ============================================================================

async function detectBeadPrefix(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["bd", "config", "get", "prefix"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    const prefix = stdout.trim()
    return prefix || null
  } catch {
    return null
  }
}

async function isBdAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", "bd"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.exited
    return proc.exitCode === 0
  } catch {
    return false
  }
}

async function beadExists(id: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["bd", "show", id], {
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.exited
    return proc.exitCode === 0
  } catch {
    return false
  }
}

async function bdCreate(id: string, title: string, description: string): Promise<void> {
  const proc = Bun.spawn(
    [
      "bd",
      "create",
      "--id",
      id,
      "--type",
      "task",
      "--priority",
      "3",
      "--title",
      title,
      "--description",
      description,
      "--label",
      "retro",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`bd create failed (exit ${exitCode}): ${stderr}`)
  }
}
