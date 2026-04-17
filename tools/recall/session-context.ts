/**
 * session-context.ts — Read the CURRENT Claude Code session transcript.
 *
 * Biggest quality lever for vague queries: the planner needs to know
 * what the user is actually doing right now. "That link thing" is
 * unambiguous if the last 200 lines of conversation show work on
 * storage/links.ts and discussion of host_id/href/rel.
 *
 * Fails silently if no session is active (CI, scripts, cron).
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { execSync } from "child_process"

// ============================================================================
// Types
// ============================================================================

export interface SessionContext {
  sessionId: string
  /** Age of the last message in milliseconds — used to decide if context is fresh. */
  ageMs: number | null
  /** Most recent user+assistant text content, flattened, truncated to maxChars. */
  recentMessages: string
  /** Number of exchanges captured. */
  exchangeCount: number
  /** File paths mentioned in the tail. */
  mentionedPaths: string[]
  /** Bead IDs (km-* pattern) mentioned in the tail. */
  mentionedBeads: string[]
  /** Distinctive tokens (camelCase, snake_case, dotted paths) from the tail. */
  mentionedTokens: string[]
}

// ============================================================================
// Options
// ============================================================================

export interface BuildSessionContextOptions {
  /** Max lines to read from the tail of the JSONL (default 400). */
  tailLines?: number
  /** Max chars to keep from flattened message text (default 6000). */
  maxChars?: number
  /** Max tokens to return in `mentionedTokens` (default 40). */
  maxTokens?: number
  /** Skip session context if the last message is older than this (default 30 min). */
  maxAgeMs?: number
  /** Override session id (for testing). */
  sessionIdOverride?: string
  /** Override cwd (for testing). */
  cwdOverride?: string
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Read the current Claude Code session context.
 * Returns null if no session is active, the file is missing, or the session
 * is stale (> maxAgeMs).
 */
export function getCurrentSessionContext(opts: BuildSessionContextOptions = {}): SessionContext | null {
  const {
    tailLines = 400,
    maxChars = 6000,
    maxTokens = 40,
    maxAgeMs = 30 * 60_000,
    sessionIdOverride,
    cwdOverride,
  } = opts

  const cwd = cwdOverride ?? process.cwd()

  // Detection priority (best to fallback):
  //   1. Explicit override (tests)
  //   2. CLAUDE_SESSION_ID env var (ideal, but Claude Code doesn't set this
  //      in Bash subprocess env today)
  //   3. Sentinel file written by the UserPromptSubmit hook, keyed by the
  //      ancestor claude PID — deterministic even with parallel sessions
  //   4. Most-recently-modified JSONL for this cwd — last-resort heuristic
  const explicitId = sessionIdOverride ?? process.env.CLAUDE_SESSION_ID
  let sessionId = explicitId
  let jsonlPath: string | null = null

  if (sessionId) {
    jsonlPath = resolveSessionJsonl(sessionId, cwd)
  }
  if (!jsonlPath) {
    const viaSentinel = readSessionSentinel()
    if (viaSentinel) {
      sessionId = viaSentinel.sessionId
      jsonlPath = viaSentinel.transcriptPath ?? resolveSessionJsonl(viaSentinel.sessionId, viaSentinel.cwd ?? cwd)
    }
  }
  if (!jsonlPath) {
    // Last-resort fallback: most-recently-modified JSONL. Works for typical
    // single-session use but can misidentify under concurrent sessions.
    const found = findMostRecentJsonl(cwd)
    if (found) {
      jsonlPath = found.path
      sessionId = found.sessionId
    }
  }
  if (!jsonlPath || !sessionId) return null

  let lines: string[]
  try {
    lines = readLastLines(jsonlPath, tailLines)
  } catch {
    return null
  }
  if (lines.length === 0) return null

  const messages = extractUserAssistantText(lines)
  if (messages.length === 0) return null

  const lastTimestamp = findLastTimestamp(lines)
  const ageMs = lastTimestamp !== null ? Date.now() - lastTimestamp : null

  // Stale sessions: drop. The user has moved on; context will mislead the planner.
  if (ageMs !== null && ageMs > maxAgeMs) return null

  // Flatten, keep the TAIL (most recent) within budget
  const flat = messages.map(formatExchange).join("\n\n")
  const recentMessages = flat.length > maxChars ? flat.slice(-maxChars) : flat

  const mentionedPaths = extractPaths(recentMessages)
  const mentionedBeads = extractBeadIds(recentMessages)
  const mentionedTokens = extractTechTokens(recentMessages).slice(0, maxTokens)

  return {
    sessionId,
    ageMs,
    recentMessages,
    exchangeCount: messages.length,
    mentionedPaths,
    mentionedBeads,
    mentionedTokens,
  }
}

/**
 * Render a compact, human-friendly summary of the session context.
 * Used by `bun recall current-brief` so the /recall skill can embed
 * it as speculative context before Claude reasons about the query.
 */
export function renderSessionBrief(ctx: SessionContext | null): string {
  if (!ctx) return "(no active Claude Code session — skipping session context)"

  const lines: string[] = []
  const age = ctx.ageMs === null ? "unknown age" : `${Math.round(ctx.ageMs / 60_000)}m ago`
  lines.push(`Session ${ctx.sessionId.slice(0, 8)} — ${age}, ${ctx.exchangeCount} recent exchanges`)

  if (ctx.mentionedPaths.length > 0) {
    lines.push(`Paths: ${ctx.mentionedPaths.slice(0, 10).join(", ")}`)
  }
  if (ctx.mentionedBeads.length > 0) {
    lines.push(`Beads: ${ctx.mentionedBeads.slice(0, 10).join(", ")}`)
  }
  if (ctx.mentionedTokens.length > 0) {
    lines.push(`Distinctive tokens: ${ctx.mentionedTokens.slice(0, 20).join(", ")}`)
  }

  // Last 800 chars of the conversation tail as a preview
  const preview = ctx.recentMessages.slice(-800)
  if (preview.length > 0) {
    lines.push("")
    lines.push("Recent conversation tail:")
    lines.push(indent(preview, "  "))
  }

  return lines.join("\n")
}

/**
 * Render the session context as a section for the planner prompt.
 * Distinct from the brief: more structured, intended for an LLM to read.
 */
export function renderSessionContextForPlanner(ctx: SessionContext): string {
  const parts: string[] = []
  parts.push(
    `CURRENT WORKING SESSION (last activity ${ctx.ageMs === null ? "unknown" : `${Math.round(ctx.ageMs / 60_000)}m ago`}):`,
  )
  parts.push("(The user's query below may or may not relate to this recent work — use only if relevant.)")
  parts.push("")

  if (ctx.mentionedPaths.length > 0) {
    parts.push(`Files touched in this session: ${ctx.mentionedPaths.slice(0, 15).join(", ")}`)
  }
  if (ctx.mentionedBeads.length > 0) {
    parts.push(`Beads mentioned: ${ctx.mentionedBeads.slice(0, 10).join(", ")}`)
  }
  if (ctx.mentionedTokens.length > 0) {
    parts.push(`Distinctive tokens: ${ctx.mentionedTokens.slice(0, 25).join(", ")}`)
  }
  parts.push("")
  parts.push("Recent conversation tail:")
  parts.push(ctx.recentMessages)

  return parts.join("\n")
}

// ============================================================================
// Focus extraction — path-based (used by the bear daemon's focus poller)
// ============================================================================

export interface SessionFocus {
  sessionId: string | null
  transcriptPath: string
  ageMs: number | null
  lastActivityTs: number | null
  exchangeCount: number
  mentionedPaths: string[]
  mentionedBeads: string[]
  mentionedTokens: string[]
  /** Flattened tail of recent exchanges, truncated to maxChars. */
  tail: string
}

/**
 * Extract focus from a JSONL transcript path. Pure — no detection, no env
 * lookups, no sentinel reads. The caller supplies the path. Used by the
 * bear daemon to poll each registered session's current activity.
 *
 * Unlike `getCurrentSessionContext`, this does NOT drop stale sessions —
 * the caller decides staleness policy. Returns null only if the file is
 * unreadable or empty.
 */
export function extractSessionFocus(
  transcriptPath: string,
  opts: { tailLines?: number; maxChars?: number; maxTokens?: number; sessionId?: string } = {},
): SessionFocus | null {
  const { tailLines = 400, maxChars = 6000, maxTokens = 40, sessionId = null } = opts
  let lines: string[]
  try {
    lines = readLastLines(transcriptPath, tailLines)
  } catch {
    return null
  }
  if (lines.length === 0) return null

  const messages = extractUserAssistantText(lines)
  const lastTimestamp = findLastTimestamp(lines)
  const ageMs = lastTimestamp !== null ? Date.now() - lastTimestamp : null

  const flat = messages.map(formatExchange).join("\n\n")
  const tail = flat.length > maxChars ? flat.slice(-maxChars) : flat

  return {
    sessionId,
    transcriptPath,
    ageMs,
    lastActivityTs: lastTimestamp,
    exchangeCount: messages.length,
    mentionedPaths: extractPaths(tail),
    mentionedBeads: extractBeadIds(tail),
    mentionedTokens: extractTechTokens(tail).slice(0, maxTokens),
    tail,
  }
}

// ============================================================================
// JSONL reading
// ============================================================================

// ============================================================================
// Session sentinel reader
// ============================================================================

const SENTINEL_DIR = path.join(os.homedir(), ".claude", "bearly-sessions")

interface SessionSentinelRead {
  claudePid: number
  sessionId: string
  transcriptPath?: string
  cwd?: string
  ts: number
}

/**
 * Read the sentinel written by the UserPromptSubmit hook. Walks up the
 * process tree to find the ancestor `claude` process, then reads
 * `~/.claude/bearly-sessions/pid-<pid>.json`.
 *
 * Returns null if no ancestor claude PID is found or no sentinel exists
 * for it. Silent on all errors — sentinel is an optimization, not required.
 */
function readSessionSentinel(): SessionSentinelRead | null {
  // First try: any ancestor PID has a sentinel. Walk up cheaply.
  const ancestors = walkProcessAncestors(6)
  for (const pid of ancestors) {
    const file = path.join(SENTINEL_DIR, `pid-${pid}.json`)
    try {
      if (!fs.existsSync(file)) continue
      const raw = fs.readFileSync(file, "utf8")
      const parsed = JSON.parse(raw) as SessionSentinelRead
      if (!parsed.sessionId) continue
      // Stale sentinel check: hook may not have run recently if the session
      // is idle. 2h is generous for "still the active session".
      if (Date.now() - parsed.ts > 2 * 60 * 60 * 1000) continue
      return parsed
    } catch {
      /* try next ancestor */
    }
  }
  return null
}

/**
 * Walk up the process tree, returning ancestor PIDs up to `maxDepth`.
 * Uses `ps` because macOS doesn't expose /proc. Returns empty on failure.
 */
function walkProcessAncestors(maxDepth: number): number[] {
  const pids: number[] = []
  let pid = process.ppid
  for (let i = 0; i < maxDepth; i++) {
    if (!pid || pid === 1) break
    pids.push(pid)
    try {
      const out = execSync(`ps -o ppid= -p ${pid}`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 500,
      }).trim()
      const next = parseInt(out, 10)
      if (!Number.isFinite(next) || next === pid) break
      pid = next
    } catch {
      break
    }
  }
  return pids
}

/**
 * Fallback when CLAUDE_SESSION_ID isn't set: find the most recently modified
 * JSONL file for the current project. Walks up the directory tree so callers
 * in a subdirectory still find their root project's session.
 */
function findMostRecentJsonl(cwd: string): { path: string; sessionId: string } | null {
  const home = os.homedir()
  let dir: string = cwd

  for (let i = 0; i < 6; i++) {
    const slug = dir.replaceAll("/", "-")
    const projectDir = path.resolve(home, ".claude/projects", slug)
    if (fs.existsSync(projectDir)) {
      try {
        const entries = fs.readdirSync(projectDir, { withFileTypes: true })
        let best: { path: string; mtime: number } | null = null
        for (const e of entries) {
          if (!e.isFile() || !e.name.endsWith(".jsonl")) continue
          const full = path.join(projectDir, e.name)
          const mtime = fs.statSync(full).mtimeMs
          if (!best || mtime > best.mtime) best = { path: full, mtime }
        }
        if (best) {
          const sessionId = path.basename(best.path, ".jsonl")
          return { path: best.path, sessionId }
        }
      } catch {
        /* skip */
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function resolveSessionJsonl(sessionId: string, cwd: string): string | null {
  const home = os.homedir()
  const slug = cwd.replaceAll("/", "-")
  const candidate = path.resolve(home, ".claude/projects", slug, `${sessionId}.jsonl`)
  if (fs.existsSync(candidate)) return candidate

  // Also try parent directories — a user may be in a subdir of the session root
  let parent = path.dirname(cwd)
  for (let i = 0; i < 4; i++) {
    const slug2 = parent.replaceAll("/", "-")
    const candidate2 = path.resolve(home, ".claude/projects", slug2, `${sessionId}.jsonl`)
    if (fs.existsSync(candidate2)) return candidate2
    const next = path.dirname(parent)
    if (next === parent) break
    parent = next
  }
  return null
}

/**
 * Read the last N lines of a file efficiently. For JSONL transcripts this
 * avoids loading a 40MB session into memory when we only need the tail.
 */
function readLastLines(filepath: string, n: number): string[] {
  const stat = fs.statSync(filepath)
  const size = stat.size
  if (size === 0) return []

  // Read a tail window — 200 lines ≈ ~40KB for Claude transcripts; be generous
  const windowBytes = Math.min(size, Math.max(64 * 1024, n * 300))
  const start = size - windowBytes

  const fd = fs.openSync(filepath, "r")
  try {
    const buf = Buffer.alloc(windowBytes)
    fs.readSync(fd, buf, 0, windowBytes, start)
    const text = buf.toString("utf8")
    const allLines = text.split("\n").filter(Boolean)
    // Drop the first line if we started mid-line (partial JSON)
    const startedMidLine = start > 0 && text[0] !== "\n"
    const lines = startedMidLine ? allLines.slice(1) : allLines
    return lines.slice(-n)
  } finally {
    fs.closeSync(fd)
  }
}

// ============================================================================
// Message extraction
// ============================================================================

interface Exchange {
  role: "user" | "assistant"
  text: string
  timestamp: number | null
}

function extractUserAssistantText(lines: string[]): Exchange[] {
  const out: Exchange[] = []

  for (const raw of lines) {
    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch {
      continue
    }
    if (!obj || typeof obj !== "object") continue

    const rec = obj as {
      type?: string
      timestamp?: string | number
      message?: { role?: string; content?: unknown }
    }

    // Claude Code transcripts have type="user" or type="assistant" (or "human")
    const t = rec.type
    if (t !== "user" && t !== "assistant" && t !== "human") continue

    const role: "user" | "assistant" = t === "assistant" ? "assistant" : "user"
    const content = rec.message?.content
    const text = extractText(content)
    if (!text || text.length < 3) continue

    const ts =
      typeof rec.timestamp === "number"
        ? rec.timestamp
        : typeof rec.timestamp === "string"
          ? Date.parse(rec.timestamp) || null
          : null

    out.push({ role, text, timestamp: ts })
  }

  return out
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: string; text?: unknown; content?: unknown }
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text)
    } else if (b.type === "tool_use" && typeof b.content === "string") {
      // Skip tool invocations — they inflate tokens and rarely have query intent
    }
  }
  return parts.join("\n")
}

function formatExchange(e: Exchange): string {
  const label = e.role === "user" ? "USER" : "ASSISTANT"
  // Trim each message to a reasonable length to keep the tail diverse.
  // Prefer more exchanges of medium length over fewer of full length.
  const trimmed = e.text.length > 1200 ? e.text.slice(0, 1100) + " …" : e.text
  return `[${label}] ${trimmed}`
}

function findLastTimestamp(lines: string[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    try {
      const obj = JSON.parse(line) as { timestamp?: string | number }
      const ts =
        typeof obj.timestamp === "number"
          ? obj.timestamp
          : typeof obj.timestamp === "string"
            ? Date.parse(obj.timestamp) || null
            : null
      if (ts !== null) return ts
    } catch {
      /* skip */
    }
  }
  return null
}

// ============================================================================
// Entity extraction (regex-based, cheap)
// ============================================================================

// File paths: /abs/path.ext or relative like src/foo/bar.ts or vendor/silvery/x.tsx
const PATH_RE = /(?:\/[\w.-]+)+\.[a-zA-Z0-9]{1,8}|(?<![\w./])[\w.-]+\/[\w./-]+\.[a-zA-Z0-9]{1,8}/g
// Bead IDs: km-<scope> or km-<scope>.<suffix>
const BEAD_RE = /\bkm-[a-z0-9]+(?:\.[a-zA-Z0-9_-]+)?\b/g
// Technical-looking tokens: camelCase, snake_case, kebab-case (>=2 chars between separators)
const TECH_TOKEN_RE = /[A-Za-z][a-zA-Z0-9]*(?:[_-][a-zA-Z0-9]+)+|[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*/g

function extractPaths(text: string): string[] {
  return uniqueCapped(text.match(PATH_RE) ?? [], 20)
}

function extractBeadIds(text: string): string[] {
  return uniqueCapped(text.match(BEAD_RE) ?? [], 15)
}

function extractTechTokens(text: string): string[] {
  const matches = text.match(TECH_TOKEN_RE) ?? []
  // Dedupe case-insensitive but preserve first spelling
  const seen = new Map<string, string>()
  for (const m of matches) {
    if (m.length < 4) continue
    const key = m.toLowerCase()
    if (!seen.has(key)) seen.set(key, m)
  }
  // Sort by rarity proxy: longer + has both case classes first
  return [...seen.values()].sort(techTokenPriority).slice(0, 80)
}

function techTokenPriority(a: string, b: string): number {
  // Prefer tokens with separators (kebab/snake) + mixed case over plain ones
  const score = (t: string) => (/[._-]/.test(t) ? 2 : 0) + (/[A-Z]/.test(t) && /[a-z]/.test(t) ? 1 : 0) + t.length / 20
  return score(b) - score(a)
}

function uniqueCapped(arr: string[], cap: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of arr) {
    if (seen.has(x)) continue
    seen.add(x)
    out.push(x)
    if (out.length >= cap) break
  }
  return out
}

// ============================================================================
// Small helpers
// ============================================================================

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((l) => prefix + l)
    .join("\n")
}
