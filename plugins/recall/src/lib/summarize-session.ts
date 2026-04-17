/**
 * Per-session LLM summarization with file-based caching.
 *
 * First pass of a two-pass hierarchical summarization system:
 * extract single session → send to cheap LLM → cache result.
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { extractSessionContent, type SessionExtract } from "./extract"
import { getCheapModel } from "../../../../tools/lib/llm/types"
import { queryModel } from "../../../../tools/lib/llm/research"
import { isProviderAvailable } from "../../../../tools/lib/llm/providers"

// ============================================================================
// Types
// ============================================================================

export interface SessionSummary {
  id: string
  shortId: string
  title: string | null
  time: string
  isSubAgent: boolean
  summary: string | null // null if skipped
  cached: boolean
}

// ============================================================================
// Constants
// ============================================================================

const SESSION_SUMMARY_PROMPT = `You are summarizing a single Claude Code coding session. Be specific and concise.

Produce a 3-8 line summary covering:
- What was the goal/task?
- What was done? (specific files, functions, packages)
- What was the outcome? (bugs fixed, features added, decisions made)
- Any mistakes, failed approaches, or wrong turns? Tag each with [minor], [moderate], or [major] based on time wasted (<5min, 5-30min, 30+min). Format: "[severity] Tried X because Y, but Z was the actual fix." If nothing went wrong, OMIT this line entirely.
- Any non-obvious lessons learned? (OMIT if nothing genuinely novel — routine outcomes don't count)

Rules:
- Be specific: include file names, function names, package names
- Each line should be a complete thought, 1-2 sentences
- Skip routine operations (file reads, test runs, linting)
- If truly nothing noteworthy, respond with just: NONE
- Do NOT invent information not present in the session data

Example output:
Goal: Fix race condition causing missing TUI header on startup.
Done: Added isReady state gate with 50ms mount delay in Board.tsx; updated useLayoutEffect to defer first render.
Outcome: Header now renders consistently; verified with createBoardDriver test.
[moderate] Tried adjusting getPathSegments and renderPath logic assuming a layout bug, but root cause was a timing race — the mount delay was the actual fix.
Lesson: Short deterministic delays can stabilize race-prone UI init more reliably than chasing layout hypotheses.`

const MIN_CONTENT_LENGTH = 100

// ============================================================================
// Cache
// ============================================================================

function getCacheDir(): string {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const encodedPath = projectDir.replace(/\//g, "-")
  return path.join(os.homedir(), ".claude", "projects", encodedPath, "memory", "session-summaries")
}

function getCachePath(shortId: string): string {
  return path.join(getCacheDir(), `${shortId}.md`)
}

export function getSessionSummaryCache(sessionId: string): string | null {
  const shortId = sessionId.slice(0, 8)
  const cachePath = getCachePath(shortId)
  try {
    return fs.readFileSync(cachePath, "utf8")
  } catch {
    return null
  }
}

function writeCache(shortId: string, content: string): void {
  const cacheDir = getCacheDir()
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(getCachePath(shortId), content)
}

// ============================================================================
// Summarize a single session
// ============================================================================

export async function summarizeSession(
  sessionId: string,
  opts?: { title?: string | null; createdAt?: number; verbose?: boolean },
): Promise<SessionSummary> {
  const log = opts?.verbose ? (msg: string) => console.error(`[summarize-session] ${msg}`) : () => {}

  // Extract content first (needed for metadata even if cached)
  const extract = extractSessionContent(sessionId, {
    title: opts?.title,
    createdAt: opts?.createdAt,
  })

  if (!extract) {
    log(`${sessionId.slice(0, 8)}: no content extracted`)
    return {
      id: sessionId,
      shortId: sessionId.slice(0, 8),
      title: opts?.title ?? null,
      time: "",
      isSubAgent: false,
      summary: null,
      cached: false,
    }
  }

  // Check cache (sessions are immutable after ending)
  const cached = getSessionSummaryCache(sessionId)
  if (cached) {
    log(`${extract.shortId}: cached`)
    return {
      id: extract.id,
      shortId: extract.shortId,
      title: extract.title,
      time: extract.time,
      isSubAgent: extract.isSubAgent,
      summary: cached,
      cached: true,
    }
  }

  // Skip sub-agent sessions
  if (extract.isSubAgent) {
    log(`${extract.shortId}: sub-agent, skipping`)
    return {
      id: extract.id,
      shortId: extract.shortId,
      title: extract.title,
      time: extract.time,
      isSubAgent: true,
      summary: null,
      cached: false,
    }
  }

  // Skip content that's too short
  if (extract.content.length < MIN_CONTENT_LENGTH) {
    log(`${extract.shortId}: content too short (${extract.content.length} chars)`)
    return {
      id: extract.id,
      shortId: extract.shortId,
      title: extract.title,
      time: extract.time,
      isSubAgent: false,
      summary: null,
      cached: false,
    }
  }

  // Check LLM availability
  const model = getCheapModel()
  if (!model || !isProviderAvailable(model.provider)) {
    log(`${extract.shortId}: no LLM provider available`)
    return {
      id: extract.id,
      shortId: extract.shortId,
      title: extract.title,
      time: extract.time,
      isSubAgent: false,
      summary: null,
      cached: false,
    }
  }

  // Build context for LLM
  let context = extract.content
  if (context.length > 30000) {
    context = context.slice(0, 30000) + "\n\n[...truncated]"
  }

  log(`${extract.shortId}: sending to LLM (${context.length} chars)`)
  const startTime = Date.now()

  const result = await queryModel({
    question: context,
    model,
    systemPrompt: SESSION_SUMMARY_PROMPT,
  })

  const summary = result.response.content
  log(`${extract.shortId}: LLM responded in ${Date.now() - startTime}ms`)

  // Handle empty / NONE responses
  if (!summary || /^NONE$/im.test(summary.trim())) {
    log(`${extract.shortId}: nothing noteworthy`)
    return {
      id: extract.id,
      shortId: extract.shortId,
      title: extract.title,
      time: extract.time,
      isSubAgent: false,
      summary: null,
      cached: false,
    }
  }

  // Cache the result
  writeCache(extract.shortId, summary)
  log(`${extract.shortId}: cached summary`)

  return {
    id: extract.id,
    shortId: extract.shortId,
    title: extract.title,
    time: extract.time,
    isSubAgent: false,
    summary,
    cached: false,
  }
}

// ============================================================================
// Batch summarize
// ============================================================================

export async function summarizeSessionBatch(
  sessions: Array<{ id: string; title?: string | null; createdAt?: number }>,
  opts?: { verbose?: boolean; concurrency?: number },
): Promise<SessionSummary[]> {
  const log = opts?.verbose ? (msg: string) => console.error(`[summarize-session] ${msg}`) : () => {}
  const concurrency = opts?.concurrency ?? 8

  log(`processing ${sessions.length} sessions (concurrency=${concurrency})`)

  // Run with bounded concurrency
  const results = new Array<SessionSummary>(sessions.length)
  let nextIdx = 0
  let completed = 0

  async function worker(): Promise<void> {
    while (nextIdx < sessions.length) {
      const idx = nextIdx++
      const session = sessions[idx]!
      log(`[${idx + 1}/${sessions.length}] ${session.id.slice(0, 8)}`)
      results[idx] = await summarizeSession(session.id, {
        title: session.title,
        createdAt: session.createdAt,
        verbose: opts?.verbose,
      })
      completed++
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, sessions.length) }, () => worker())
  await Promise.all(workers)

  const summarized = results.filter((r) => r.summary !== null).length
  const cached = results.filter((r) => r.cached).length
  log(`done: ${summarized} summarized (${cached} from cache), ${results.length - summarized} skipped`)

  return results
}
