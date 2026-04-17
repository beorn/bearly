/**
 * Shared formatting utilities for the recall CLI.
 */

import type { ContentType } from "../history/types"

// ============================================================================
// ANSI codes
// ============================================================================

export const DIM = "\x1b[2m"
export const BOLD = "\x1b[1m"
export const CYAN = "\x1b[36m"
export const YELLOW = "\x1b[33m"
export const GREEN = "\x1b[32m"
export const RED = "\x1b[31m"
export const MAGENTA = "\x1b[35m"
export const RESET = "\x1b[0m"

export const CHECK = `${GREEN}\u2713${RESET}`
export const WARN = `${YELLOW}\u26A0${RESET}`
export const CROSS = `${RED}\u2717${RESET}`

// ============================================================================
// Time constants
// ============================================================================

export const FIVE_MINUTES_MS = 5 * 60 * 1000
export const ONE_HOUR_MS = 60 * 60 * 1000
export const ONE_DAY_MS = 24 * 60 * 60 * 1000
export const THIRTY_DAYS_MS = 30 * ONE_DAY_MS

// ============================================================================
// Formatting functions
// ============================================================================

/**
 * Parse time string to timestamp (milliseconds since epoch).
 * Supports: 1h, 2d, 3w, today, yesterday
 */
export function parseTime(timeStr: string): number | undefined {
  const now = Date.now()
  const str = timeStr.toLowerCase().trim()

  const match = str.match(/^(\d+)([hdw])$/)
  if (match) {
    const amount = parseInt(match[1]!, 10)
    const unit = match[2]
    switch (unit) {
      case "h":
        return now - amount * ONE_HOUR_MS
      case "d":
        return now - amount * ONE_DAY_MS
      case "w":
        return now - amount * 7 * ONE_DAY_MS
    }
  }

  switch (str) {
    case "today": {
      const midnight = new Date()
      midnight.setHours(0, 0, 0, 0)
      return midnight.getTime()
    }
    case "yesterday": {
      const midnight = new Date()
      midnight.setHours(0, 0, 0, 0)
      return midnight.getTime() - ONE_DAY_MS
    }
  }

  return undefined
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString()
}

export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`
  return `${Math.round(diff / 86400000)}d ago`
}

export function displayProjectPath(encoded: string): string {
  return encoded.replace(/-/g, "/").replace(/^\//, "/")
}

export function highlightMatch(text: string, regex: RegExp): string {
  return text.replace(new RegExp(`(${regex.source})`, "gi"), `${BOLD}${YELLOW}$1${RESET}`)
}

export function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const key = keyFn(item)
    let group = map.get(key)
    if (!group) {
      group = []
      map.set(key, group)
    }
    group.push(item)
  }
  return map
}

export function formatSessionId(id: string, titleMap: Map<string, string>): string {
  const title = titleMap.get(id)
  return title ? `${title} (${id.slice(0, 8)})` : `${id.slice(0, 8)}...`
}

/**
 * Parse include string to content types.
 * Short codes: p=plan, m=message, s=summary, t=todo, f=first_prompt,
 *              b=bead, e=session_memory, d=doc, c=claude_md
 */
export function parseInclude(includeStr: string): ContentType[] {
  const types: ContentType[] = []
  const parts = includeStr
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  const shortMap: Record<string, ContentType> = {
    p: "plan",
    m: "message",
    s: "summary",
    t: "todo",
    f: "first_prompt",
    b: "bead",
    e: "session_memory",
    d: "doc",
    c: "claude_md",
  }

  const longMap: Record<string, ContentType> = {
    plans: "plan",
    plan: "plan",
    messages: "message",
    message: "message",
    summaries: "summary",
    summary: "summary",
    todos: "todo",
    todo: "todo",
    first_prompt: "first_prompt",
    first_prompts: "first_prompt",
    prompts: "first_prompt",
    bead: "bead",
    beads: "bead",
    session_memory: "session_memory",
    memory: "session_memory",
    project_memory: "project_memory",
    doc: "doc",
    docs: "doc",
    claude_md: "claude_md",
    claude: "claude_md",
  }

  for (const part of parts) {
    if (part.length === 1 && shortMap[part]) {
      const ct = shortMap[part]!
      if (!types.includes(ct)) types.push(ct)
    } else if (longMap[part]) {
      const ct = longMap[part]!
      if (!types.includes(ct)) types.push(ct)
    }
  }

  return types
}

/**
 * Match a project path against a glob pattern.
 */
export function matchProjectGlob(encodedPath: string, pattern: string): boolean {
  const normalPath = encodedPath.replace(/-/g, "/")
  const regexStr = pattern
    .replace(/\*\*/g, "<<<GLOBSTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<GLOBSTAR>>>/g, ".*")
    .replace(/\?/g, ".")
  const regex = new RegExp(regexStr, "i")
  return regex.test(normalPath)
}
