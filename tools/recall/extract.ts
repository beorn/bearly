/**
 * Extract content from Claude Code session JSONL files.
 *
 * Provides structured extraction of session transcripts for summarization
 * and indexing. Samples from beginning, middle, and end of sessions to
 * capture goals, work, and outcomes.
 */

import * as fs from "fs"
import * as path from "path"
import { getDb, closeDb, PROJECTS_DIR } from "../lib/history/db"

// ============================================================================
// Types
// ============================================================================

export interface SessionExtract {
  id: string
  shortId: string // first 8 chars
  title: string | null
  time: string // formatted time string
  isSubAgent: boolean
  content: string // extracted text content
  sizeBytes: number // JSONL file size
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Find the JSONL file path for a session ID using the DB's jsonl_path.
 * Returns full path if the file exists, null otherwise.
 */
export function findSessionJsonl(sessionId: string): string | null {
  const db = getDb()
  try {
    const row = db.prepare("SELECT jsonl_path FROM sessions WHERE id = ?").get(sessionId) as
      | { jsonl_path: string }
      | undefined

    if (!row?.jsonl_path) return null

    const fullPath = row.jsonl_path.startsWith("/") ? row.jsonl_path : path.join(PROJECTS_DIR, row.jsonl_path)

    return fs.existsSync(fullPath) ? fullPath : null
  } catch {
    return null
  } finally {
    closeDb()
  }
}

/**
 * Extract structured content from a session's JSONL transcript.
 * Samples from beginning (40 lines), middle (40), and end (40) to
 * capture initial goals, mid-session work, and final outcomes.
 */
export function extractSessionContent(
  sessionId: string,
  opts?: { title?: string | null; createdAt?: number },
): SessionExtract | null {
  const jsonlPath = findSessionJsonl(sessionId)
  if (!jsonlPath) return null

  let sizeBytes: number
  try {
    sizeBytes = fs.statSync(jsonlPath).size
  } catch {
    return null
  }

  try {
    const raw = fs.readFileSync(jsonlPath, "utf8")
    const lines = raw.split("\n").filter(Boolean)

    const sampled = sampleLines(lines, 40)

    const messages: string[] = []
    let hasUserText = false

    for (const line of sampled) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entry = JSON.parse(line) as any
        if (entry.type !== "user" && entry.type !== "assistant") continue

        const parts: string[] = []
        const content = entry.message?.content
        if (!Array.isArray(content)) continue

        for (const block of content) {
          if (typeof block === "string") {
            if (block.length > 20) parts.push(block)
            continue
          }
          if (!block || typeof block !== "object") continue

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const b = block as any
          if (b.type === "text" && b.text && b.text.length > 20) {
            parts.push(truncStr(b.text, 1500))
            if (entry.type === "user") hasUserText = true
          } else if (b.type === "tool_use") {
            const summary = summarizeToolUse(b)
            if (summary) parts.push(summary)
          }
          // Skip tool_result (large file dumps, noise)
        }

        if (parts.length > 0) {
          messages.push(`[${entry.type}]: ${parts.join(" | ")}`)
        }
      } catch {
        // Skip unparseable lines
      }
    }

    if (messages.length === 0) return null

    // Limit total to ~4KB
    let joined = messages.join("\n")
    if (joined.length > 4000) {
      joined = joined.slice(-4000)
    }

    const shortId = sessionId.slice(0, 8)
    const time = opts?.createdAt
      ? new Date(opts.createdAt).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
        })
      : ""

    return {
      id: sessionId,
      shortId,
      title: opts?.title ?? null,
      time,
      isSubAgent: !hasUserText,
      content: joined,
      sizeBytes,
    }
  } catch {
    return null
  }
}

/**
 * Quick check if a session is likely a sub-agent (no user text content).
 * Reads only the first 50 lines for speed.
 */
export function isSubAgent(sessionId: string): boolean {
  const jsonlPath = findSessionJsonl(sessionId)
  if (!jsonlPath) return false

  try {
    const raw = fs.readFileSync(jsonlPath, "utf8")
    const lines = raw.split("\n").filter(Boolean).slice(0, 50)

    for (const line of lines) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entry = JSON.parse(line) as any
        if (entry.type !== "user") continue

        const content = entry.message?.content
        if (!Array.isArray(content)) continue

        for (const block of content) {
          if (typeof block === "string" && block.length > 0) return false
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (block && typeof block === "object" && (block as any).type === "text" && (block as any).text) {
            return false
          }
        }
      } catch {
        // Skip unparseable lines
      }
    }

    return true
  } catch {
    return false
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Sample lines from beginning, middle, and end of array. */
function sampleLines(lines: string[], perSection: number): string[] {
  if (lines.length <= perSection * 3) return lines
  const start = lines.slice(0, perSection)
  const midPoint = Math.floor(lines.length / 2)
  const half = Math.floor(perSection / 2)
  const middle = lines.slice(midPoint - half, midPoint + half)
  const end = lines.slice(-perSection)
  return [...start, ...middle, ...end]
}

/** Truncate text to max length. */
function truncStr(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "..." : text
}

/** Summarize a tool_use block into a brief description. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summarizeToolUse(block: any): string | null {
  const name = block.name as string | undefined
  const input = block.input as Record<string, unknown> | undefined
  if (!name || !input) return null

  switch (name) {
    case "Edit":
    case "MultiEdit":
      return `[Edit] ${fileBasename(input.file_path as string)}`
    case "Write":
      return `[Write] ${fileBasename(input.file_path as string)}`
    case "Read":
      return null // too noisy
    case "Bash": {
      const cmd = input.command as string | undefined
      return cmd ? `[Bash] ${truncStr(cmd, 120)}` : null
    }
    case "Grep":
      return `[Search] "${truncStr(String(input.pattern || ""), 50)}"`
    case "Glob":
      return null // too noisy
    case "Task":
      return `[Task] ${truncStr(String(input.description || input.prompt || ""), 80)}`
    default:
      return `[${name}]`
  }
}

function fileBasename(filePath: string | undefined): string {
  if (!filePath) return "?"
  return filePath.split("/").pop() || filePath
}
