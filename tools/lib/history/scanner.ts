/**
 * scanner.ts - Session file scanning, hook handling, and diagnostics
 *
 * Reads session JSONL files, parses messages, manages hook dedup state,
 * and runs memory system diagnostics/benchmarks.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  getDb,
  closeDb,
  PROJECTS_DIR,
  ftsSearchWithSnippet,
  searchAll,
  getAllSessionTitles,
  getIndexMeta,
} from "./db.ts"
import type { ContentType } from "./types.ts"
import { getCheapModels } from "../llm/types"
import { isProviderAvailable } from "../llm/providers"
import { log, ONE_HOUR_MS, THIRTY_DAYS_MS } from "./recall-shared.ts"
import type { RecallSearchResult } from "./recall-shared.ts"
import { recall, parseTimeToMs } from "./search.ts"
import { SYNTHESIS_PROMPT, raceLlmModels, formatResultsForLlm, type LlmRaceModelResult } from "./synthesize.ts"
import { ensureProjectSourcesIndexed } from "./project-sources.ts"

// ============================================================================
// Transcript extraction
// ============================================================================

/**
 * Extract user/assistant messages from a JSONL transcript file.
 * Takes the last 200 lines and extracts text content.
 */
export function extractTranscriptMessages(transcriptPath: string): string | null {
  const content = fs.readFileSync(transcriptPath, "utf8")
  const lines = content.split("\n").filter(Boolean)
  const lastLines = lines.slice(-200)

  const messages: string[] = []

  for (const line of lastLines) {
    try {
      const entry = JSON.parse(line) as {
        type?: string
        message?: { content?: Array<{ type?: string; text?: string } | string> }
        content?: string | unknown[]
      }

      if (entry.type !== "user" && entry.type !== "assistant") continue

      let text = ""
      if (entry.message?.content) {
        text = entry.message.content
          .map((c) => {
            if (typeof c === "string") return c
            if (c && typeof c === "object" && "text" in c) return c.text
            return ""
          })
          .filter(Boolean)
          .join("\n")
      } else if (typeof entry.content === "string") {
        text = entry.content
      }

      if (text) {
        messages.push(`[${entry.type}]: ${text}\n---`)
      }
    } catch {
      // Skip unparseable lines
    }
  }

  if (messages.length === 0) return null

  // Limit to ~12KB
  const joined = messages.join("\n")
  return joined.length > 12000 ? joined.slice(-12000) : joined
}

// ============================================================================
// Hook subcommand: search + return additionalContext JSON
// ============================================================================

export interface HookResult {
  skipped: boolean
  reason?: string
  hookOutput?: {
    hookSpecificOutput: {
      additionalContext: string
    }
  }
}

/**
 * Run recall for a hook context: search + synthesize, return hook-formatted output.
 * Returns { skipped: true } for trivial prompts, { hookOutput } for results.
 * Throws on actual errors (fail loud).
 */
export async function hookRecall(prompt: string): Promise<HookResult> {
  // Skip empty prompts
  if (!prompt || prompt.trim().length === 0) {
    return { skipped: true, reason: "empty" }
  }

  // Skip short prompts (< 15 chars)
  if (prompt.trim().length < 15) {
    return { skipped: true, reason: "short" }
  }

  // Skip trivial responses
  const lower = prompt.toLowerCase().trim()
  const trivial = [
    "yes",
    "no",
    "y",
    "n",
    "ok",
    "okay",
    "sure",
    "continue",
    "go ahead",
    "lgtm",
    "looks good",
    "do it",
    "proceed",
    "thanks",
    "thank you",
    "done",
    "sounds good",
    "go for it",
  ]
  if (trivial.includes(lower)) {
    return { skipped: true, reason: "trivial" }
  }

  // Skip slash commands
  if (prompt.startsWith("/")) {
    return { skipped: true, reason: "slash_command" }
  }

  // Index project sources if CLAUDE_PROJECT_DIR is set (fast mtime checks)
  ensureProjectSourcesIndexed()

  // Session-level dedup: don't re-inject the same source session+type
  // Results become eligible again after DEDUP_TTL_TURNS turns
  const DEDUP_TTL_TURNS = 10
  const claudeSessionId = process.env.CLAUDE_SESSION_ID
  const seenFile = claudeSessionId ? path.join(os.tmpdir(), `recall-hook-seen-${claudeSessionId}.json`) : null
  let seen: Record<string, number> = {} // key → turn number when last injected
  let turnNumber = 0
  if (seenFile) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = JSON.parse(fs.readFileSync(seenFile, "utf8")) as any
      seen = data.seen ?? {}
      turnNumber = (data.turn ?? 0) + 1
    } catch {
      // First call in session or corrupt file
    }
  }

  const result = await recall(prompt, {
    limit: 5, // Fetch extra to compensate for dedup filtering
    raw: true, // No LLM synthesis — just fast FTS5 search (~200ms)
    timeout: 2000,
    snippetTokens: 80,
    json: true,
  })

  if (result.results.length === 0) {
    return { skipped: true, reason: "no_results" }
  }

  // Filter out already-injected results, then format
  const snippets: string[] = []
  const newKeys: string[] = []
  for (const r of result.results) {
    const key = `${r.sessionId}:${r.type}`
    if (key in seen && turnNumber - seen[key]! < DEDUP_TTL_TURNS) continue
    let text = r.snippet.trim()
    // Strip FTS5 highlight markers (both >>> and <<<)
    text = text.replace(/>>>|<<</g, "")
    // Strip JSON-like fragments (tool calls, parameters)
    text = text
      .replace(/\{"[^"]*"[^}]*\}/g, "")
      .replace(/\{[^}]{0,50}\}?/g, "")
      .trim()
    // Strip [Assistant]/[User] prefixes and --- separators
    text = text
      .replace(/\[(?:Assistant|User)\]\s*/g, "")
      .replace(/^-{3,}\n?/gm, "")
      .trim()
    // Collapse whitespace
    text = text.replace(/\n{3,}/g, "\n\n").trim()
    if (text.length < 20) continue // Skip near-empty results
    const label = r.sessionTitle ?? r.sessionId.slice(0, 8)
    snippets.push(`[${r.type}] ${label}: ${text.slice(0, 300)}`)
    newKeys.push(key)
    if (snippets.length >= 3) break // Cap at 3 snippets
  }

  // Persist seen keys + turn counter for future calls in this session
  if (seenFile) {
    for (const k of newKeys) seen[k] = turnNumber
    try {
      fs.writeFileSync(seenFile, JSON.stringify({ turn: turnNumber, seen }))
    } catch {
      // Non-fatal
    }
  }

  if (snippets.length === 0) {
    return { skipped: true, reason: "all_seen" }
  }

  return {
    skipped: false,
    hookOutput: {
      hookSpecificOutput: {
        additionalContext: `## Session Memory\n\n${snippets.join("\n")}`,
      },
    },
  }
}

// ============================================================================
// Review / Diagnostics
// ============================================================================

export interface ReviewResult {
  indexHealth: {
    sessions: number
    messages: number
    plans: number
    summaries: number
    firstPrompts: number
    todos: number
    beads: number
    sessionMemory: number
    projectMemory: number
    docs: number
    claudeMd: number
    dbSizeBytes: number
    lastRebuild: string | null
    isStale: boolean
  }
  hookConfig: {
    userPromptSubmitConfigured: boolean
    sessionEndConfigured: boolean
    recallHookConfigured: boolean
    rememberHookConfigured: boolean
    sessionMemoryFiles: number
  }
  searchBenchmarks: {
    query: string
    resultCount: number
    latencyMs: number
    avgSnippetLength: number
    uniqueSessions: number
    hasTitles: boolean
  }[]
  recallTest: {
    query: string
    synthesisOk: boolean
    synthesisLength: number
    llmCost: number | null
    durationMs: number
    resultCount: number
    uniqueSessions: number
  } | null
  llmRaceBenchmark: {
    models: string[]
    queries: number
    results: {
      query: string
      searchMs: number
      winner: string | null
      timedOut: boolean
      totalMs: number
      perModel: LlmRaceModelResult[]
      raceCost: number
    }[]
    summary: {
      winsByModel: Record<string, number>
      timeoutCount: number
      timeoutPct: number
      p50Ms: number
      p95Ms: number
      avgSearchMs: number
      avgLlmMs: number
      totalCost: number
      costPerQuery: number
    }
  } | null
  recommendations: string[]
}

/**
 * Run a full diagnostic review of the memory system.
 *
 * Checks index health, hook configuration, search quality, and recall synthesis.
 * Returns a structured ReviewResult with actionable recommendations.
 *
 * @param projectRoot - Absolute path to the project root (for finding settings.json)
 */
export async function reviewMemorySystem(projectRoot: string): Promise<ReviewResult> {
  const startTime = Date.now()
  log(`review: starting diagnostics for ${projectRoot}`)
  const recommendations: string[] = []

  // ── Index Health ──────────────────────────────────────────────────────
  log(`review: checking index health...`)
  const db = getDb()
  let indexHealth: ReviewResult["indexHealth"]
  try {
    const sessions = (db.prepare("SELECT COUNT(*) as n FROM sessions").get() as { n: number }).n ?? 0
    const messages = (db.prepare("SELECT COUNT(*) as n FROM messages").get() as { n: number }).n ?? 0

    // Content table counts by type
    const contentCounts = db.prepare("SELECT content_type, COUNT(*) as n FROM content GROUP BY content_type").all() as {
      content_type: string
      n: number
    }[]
    const countByType = new Map(contentCounts.map((r) => [r.content_type, r.n]))

    const plans = countByType.get("plan") ?? 0
    const summaries = countByType.get("summary") ?? 0
    const firstPrompts = countByType.get("first_prompt") ?? 0
    const todos = countByType.get("todo") ?? 0
    const beads = countByType.get("bead") ?? 0
    const sessionMemory = countByType.get("session_memory") ?? 0
    const projectMemory = countByType.get("project_memory") ?? 0
    const docs = countByType.get("doc") ?? 0
    const claudeMd = countByType.get("claude_md") ?? 0

    // DB file size
    let dbSizeBytes = 0
    try {
      const { DB_PATH } = await import("./db")
      dbSizeBytes = fs.statSync(DB_PATH).size
    } catch {
      // ignore
    }

    // Last rebuild time
    const lastRebuild = getIndexMeta(db, "last_rebuild") ?? null
    const isStale = lastRebuild ? Date.now() - new Date(lastRebuild).getTime() > ONE_HOUR_MS : true

    indexHealth = {
      sessions,
      messages,
      plans,
      summaries,
      firstPrompts,
      todos,
      beads,
      sessionMemory,
      projectMemory,
      docs,
      claudeMd,
      dbSizeBytes,
      lastRebuild,
      isStale,
    }

    // Index health recommendations
    if (isStale) {
      const ago = lastRebuild ? formatTimeSince(new Date(lastRebuild).getTime()) : "never"
      recommendations.push(`Index is stale (${ago}) — run \`bun recall index --incremental\``)
    }
    if (firstPrompts === 0) {
      recommendations.push("No first_prompt content indexed — run full index rebuild: `bun recall index`")
    }
    if (plans === 0) {
      recommendations.push("No plans indexed — no plan files found in ~/.claude/plans/")
    }
    if (sessions === 0) {
      recommendations.push("No sessions indexed — run `bun recall index` to build the index")
    }
  } finally {
    closeDb()
  }

  log(
    `review: index has ${indexHealth.sessions} sessions, ${indexHealth.messages} messages, ${indexHealth.plans} plans, ${indexHealth.firstPrompts} first_prompts, ${indexHealth.beads} beads, ${indexHealth.docs} docs`,
  )

  // ── Hook Configuration ────────────────────────────────────────────────
  log(`review: checking hook configuration...`)
  const hookConfig = checkHookConfig(projectRoot, recommendations)

  // ── Search Benchmarks ─────────────────────────────────────────────────
  const benchmarkQueries = [
    { query: "bug fix", label: '"bug fix"' },
    { query: "inline edit", label: '"inline edit"' },
    { query: "test", label: '"test" (1d)', since: "1d" },
    {
      query: "refactor",
      label: "plans only",
      types: ["plan", "summary"] as ContentType[],
    },
  ]

  log(`review: running ${benchmarkQueries.length} search benchmarks...`)
  const searchBenchmarks: ReviewResult["searchBenchmarks"] = []
  for (const bq of benchmarkQueries) {
    try {
      const bench = runSearchBenchmark(bq.query, bq.label, bq.since, bq.types)
      searchBenchmarks.push(bench)
    } catch {
      // If a benchmark query fails (e.g. empty FTS), record zeros
      searchBenchmarks.push({
        query: bq.label,
        resultCount: 0,
        latencyMs: 0,
        avgSnippetLength: 0,
        uniqueSessions: 0,
        hasTitles: false,
      })
    }
  }

  // Search quality recommendations
  const totalResults = searchBenchmarks.reduce((sum, b) => sum + b.resultCount, 0)
  if (totalResults === 0) {
    recommendations.push("All benchmark queries returned 0 results — index may be empty or corrupt")
  } else {
    const allFromOneSess = searchBenchmarks.every((b) => b.uniqueSessions <= 1 && b.resultCount > 0)
    if (allFromOneSess) {
      recommendations.push("Results only from 1 session per query — index may be incomplete")
    }
    const avgLatency = searchBenchmarks.reduce((sum, b) => sum + b.latencyMs, 0) / searchBenchmarks.length
    const diverseSessions = searchBenchmarks.reduce((sum, b) => sum + b.uniqueSessions, 0)
    if (avgLatency < 500 && totalResults > 0 && diverseSessions > 2) {
      recommendations.push(
        `Search quality is good — ${totalResults} results across ${diverseSessions} sessions in ${Math.round(avgLatency)}ms avg`,
      )
    }
  }

  // ── Recall Quality Test ───────────────────────────────────────────────
  log(`review: testing recall quality with live LLM synthesis...`)
  let recallTest: ReviewResult["recallTest"] = null
  try {
    const testQuery = "inline edit"
    const startTime = Date.now()
    const result = await recall(testQuery, {
      limit: 5,
      timeout: 8000,
    })
    const durationMs = Date.now() - startTime
    const uniqueSessions = new Set(result.results.map((r) => r.sessionId)).size

    recallTest = {
      query: testQuery,
      synthesisOk: result.synthesis !== null && result.synthesis.length > 0,
      synthesisLength: result.synthesis?.length ?? 0,
      llmCost: result.llmCost ?? null,
      durationMs,
      resultCount: result.results.length,
      uniqueSessions,
    }

    // Recall quality recommendations
    if (!recallTest.synthesisOk) {
      recommendations.push("LLM synthesis failed — check API keys (OPENAI_API_KEY, etc.)")
    } else {
      if (recallTest.synthesisLength < 50) {
        recommendations.push(`Synthesis too short (${recallTest.synthesisLength} chars) — may not be useful`)
      } else if (recallTest.synthesisLength > 2000) {
        recommendations.push(`Synthesis too long (${recallTest.synthesisLength} chars) — consider reducing --limit`)
      }
      if (durationMs > 8000) {
        recommendations.push(`Synthesis is slow (${(durationMs / 1000).toFixed(1)}s) — consider reducing --limit`)
      }
      if (
        recallTest.synthesisOk &&
        recallTest.synthesisLength >= 50 &&
        recallTest.synthesisLength <= 2000 &&
        durationMs <= 8000
      ) {
        const cost = recallTest.llmCost ? `$${recallTest.llmCost.toFixed(4)}` : "N/A"
        recommendations.push(
          `Synthesis working — ${recallTest.synthesisLength} chars in ${(durationMs / 1000).toFixed(1)}s (${cost})`,
        )
      }
    }
  } catch {
    recommendations.push("Recall test threw an error — check DB and LLM setup")
  }

  // ── LLM Race Benchmark ─────────────────────────────────────────────────
  log(`review: running LLM race benchmark...`)
  let llmRaceBenchmark: ReviewResult["llmRaceBenchmark"] = null
  const raceModels = getCheapModels(2).filter((m) => isProviderAvailable(m.provider))

  if (raceModels.length > 0) {
    const raceQueries = ["inline edit", "bug fix", "refactor", "test failure", "keyboard input"]
    const raceTimeoutMs = 10000 // generous for benchmarking
    const raceResults: NonNullable<ReviewResult["llmRaceBenchmark"]>["results"] = []

    for (const q of raceQueries) {
      try {
        // Do a quick FTS5 search to build context
        const searchStart = Date.now()
        const db = getDb()
        const msgResults = ftsSearchWithSnippet(db, q, {
          limit: 10,
          sinceTime: Date.now() - THIRTY_DAYS_MS,
          snippetTokens: 200,
        })
        const contentResults = searchAll(db, q, {
          limit: 10,
          types: ["bead", "session_memory", "doc", "llm_research"] as ContentType[],
          snippetTokens: 200,
        })
        closeDb()
        const searchMs = Date.now() - searchStart

        // Build minimal results for context
        const sessionTitles = getAllSessionTitles()
        const fakeResults: RecallSearchResult[] = [
          ...msgResults.results.slice(0, 5).map((r) => ({
            type: "message" as ContentType,
            sessionId: r.session_id,
            sessionTitle: sessionTitles.get(r.session_id) ?? null,
            timestamp: r.timestamp,
            snippet: r.snippet || r.content?.slice(0, 300) || "",
            rank: r.rank,
          })),
          ...contentResults.results.slice(0, 3).map((r) => ({
            type: r.content_type as ContentType,
            sessionId: r.source_id,
            sessionTitle: r.title ?? null,
            timestamp: r.timestamp,
            snippet: r.snippet || r.content.slice(0, 300),
            rank: r.rank,
          })),
        ]

        if (fakeResults.length === 0) {
          log(`review: race benchmark skipping "${q}" — no search results`)
          continue
        }

        const context = formatResultsForLlm(q, fakeResults)
        log(
          `review: racing "${q}" context=${context.length} chars across [${raceModels.map((m) => m.modelId).join(", ")}]`,
        )

        const race = await raceLlmModels(context, SYNTHESIS_PROMPT, raceModels, raceTimeoutMs)

        raceResults.push({
          query: q,
          searchMs,
          winner: race.winner,
          timedOut: race.timedOut,
          totalMs: race.totalMs,
          perModel: race.perModel,
          raceCost: race.totalCost,
        })

        log(
          `review: "${q}" → ${race.winner ?? "TIMEOUT"} in ${race.totalMs}ms [${race.perModel.map((m) => `${m.model}=${m.ms}ms(${m.status})`).join(", ")}]`,
        )
      } catch (err) {
        log(`review: race benchmark error for "${q}": ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (raceResults.length > 0) {
      // Compute summary stats
      const winsByModel: Record<string, number> = {}
      for (const r of raceResults) {
        if (r.winner) {
          winsByModel[r.winner] = (winsByModel[r.winner] ?? 0) + 1
        }
      }

      const timeoutCount = raceResults.filter((r) => r.timedOut).length

      const allLlmMs = raceResults.map((r) => r.totalMs).sort((a, b) => a - b)

      const totalCost = raceResults.reduce((s, r) => s + r.raceCost, 0)
      llmRaceBenchmark = {
        models: raceModels.map((m) => m.modelId),
        queries: raceResults.length,
        results: raceResults,
        summary: {
          winsByModel,
          timeoutCount,
          timeoutPct: Math.round((timeoutCount / raceResults.length) * 100),
          p50Ms: percentile(allLlmMs, 50),
          p95Ms: percentile(allLlmMs, 95),
          avgSearchMs: Math.round(raceResults.reduce((s, r) => s + r.searchMs, 0) / raceResults.length),
          avgLlmMs: Math.round(raceResults.reduce((s, r) => s + r.totalMs, 0) / raceResults.length),
          totalCost,
          costPerQuery: raceResults.length > 0 ? totalCost / raceResults.length : 0,
        },
      }

      // Recommendations based on benchmark
      if (llmRaceBenchmark.summary.timeoutPct > 50) {
        recommendations.push(
          `LLM race: ${llmRaceBenchmark.summary.timeoutPct}% timeouts at ${raceTimeoutMs}ms — providers are slow`,
        )
      }
      if (llmRaceBenchmark.summary.p95Ms > 8000) {
        recommendations.push(
          `LLM race P95: ${(llmRaceBenchmark.summary.p95Ms / 1000).toFixed(1)}s — consider making raw mode the default`,
        )
      }
      const topWinner = Object.entries(winsByModel).sort((a, b) => b[1] - a[1])[0]
      if (topWinner) {
        recommendations.push(
          `LLM race winner: ${topWinner[0]} won ${topWinner[1]}/${raceResults.length} (P50=${(llmRaceBenchmark.summary.p50Ms / 1000).toFixed(1)}s, P95=${(llmRaceBenchmark.summary.p95Ms / 1000).toFixed(1)}s)`,
        )
      }
    }
  } else {
    recommendations.push("No cheap LLM providers available for race benchmark — check API keys")
  }

  log(`review: completed in ${Date.now() - startTime}ms — ${recommendations.length} recommendations`)

  return {
    indexHealth,
    hookConfig,
    searchBenchmarks,
    recallTest,
    llmRaceBenchmark,
    recommendations,
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil((pct / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]!
}

function checkHookConfig(projectRoot: string, recommendations: string[]): ReviewResult["hookConfig"] {
  const settingsPath = path.join(projectRoot, ".claude", "settings.json")
  let userPromptSubmitConfigured = false
  let sessionEndConfigured = false

  try {
    const raw = fs.readFileSync(settingsPath, "utf8")
    const settings = JSON.parse(raw) as {
      hooks?: Record<string, unknown[]>
    }
    if (settings.hooks) {
      userPromptSubmitConfigured = "UserPromptSubmit" in settings.hooks
      sessionEndConfigured = "SessionEnd" in settings.hooks
    }
  } catch {
    recommendations.push("Could not read .claude/settings.json — hook config unknown")
  }

  if (!userPromptSubmitConfigured) {
    recommendations.push("UserPromptSubmit hook not configured — auto-recall is disabled")
  }
  if (!sessionEndConfigured) {
    recommendations.push("SessionEnd hook not configured — session lessons won't be saved")
  }

  // Check hook commands point to recall.ts
  let recallHookConfigured = false
  let rememberHookConfigured = false
  try {
    const raw = fs.readFileSync(settingsPath, "utf8")
    const settings = JSON.parse(raw) as {
      hooks?: Record<string, { hooks?: { command?: string }[] }[]>
    }
    const hookEntries = settings.hooks ?? {}
    for (const entry of hookEntries.UserPromptSubmit ?? []) {
      for (const h of entry.hooks ?? []) {
        if (h.command?.includes("recall.ts hook")) recallHookConfigured = true
      }
    }
    for (const entry of hookEntries.SessionEnd ?? []) {
      for (const h of entry.hooks ?? []) {
        if (h.command?.includes("recall.ts remember")) rememberHookConfigured = true
      }
    }
  } catch {
    // Already reported above
  }

  // Also check shell-based hooks (e.g., .claude/hooks/session-start.sh)
  // that run recall.ts index/summarize as an alternative to JSON hooks
  if (!recallHookConfigured || !rememberHookConfigured) {
    const hooksDir = path.join(projectRoot, ".claude", "hooks")
    try {
      if (fs.existsSync(hooksDir)) {
        for (const entry of fs.readdirSync(hooksDir)) {
          const hookPath = path.join(hooksDir, entry)
          try {
            const content = fs.readFileSync(hookPath, "utf8")
            if (content.includes("recall.ts index")) recallHookConfigured = true
            if (content.includes("recall.ts summarize")) rememberHookConfigured = true
          } catch {
            // Skip unreadable files
          }
        }
      }
    } catch {
      // Skip if hooks dir doesn't exist
    }
  }

  if (userPromptSubmitConfigured && !recallHookConfigured) {
    recommendations.push("UserPromptSubmit hook exists but doesn't call recall.ts hook")
  }
  if (sessionEndConfigured && !rememberHookConfigured) {
    recommendations.push("SessionEnd hook exists but doesn't call recall.ts remember")
  }

  // Count session memory files
  let sessionMemoryFiles = 0
  const memorySessionsDir = findMemorySessionsDir(projectRoot)
  if (memorySessionsDir) {
    try {
      const entries = fs.readdirSync(memorySessionsDir)
      sessionMemoryFiles = entries.filter((e) => e.endsWith(".md")).length
    } catch {
      // ignore
    }
  }

  if (sessionMemoryFiles === 0) {
    recommendations.push("No session memory files found — SessionEnd hook may not be firing")
  }

  return {
    userPromptSubmitConfigured,
    sessionEndConfigured,
    recallHookConfigured,
    rememberHookConfigured,
    sessionMemoryFiles,
  }
}

/**
 * Find the memory/sessions/ directory for this project.
 * Claude stores project data in ~/.claude/projects/<encoded-path>/
 */
function findMemorySessionsDir(projectRoot: string): string | null {
  // Encode project path the way Claude does it: replace / with -
  const encodedPath = projectRoot.replace(/\//g, "-")
  const candidates = [
    path.join(PROJECTS_DIR, encodedPath, "memory", "sessions"),
    // Also check directly under the project's .claude dir
    path.join(projectRoot, ".claude", "memory", "sessions"),
  ]

  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir
  }
  return null
}

function runSearchBenchmark(
  query: string,
  label: string,
  since?: string,
  types?: ContentType[],
): ReviewResult["searchBenchmarks"][number] {
  const db = getDb()
  try {
    const startTime = Date.now()

    const sinceTime = since ? parseTimeToMs(since) : Date.now() - THIRTY_DAYS_MS

    if (types) {
      // Content-only search
      const results = searchAll(db, query, {
        limit: 20,
        sinceTime,
        types,
        snippetTokens: 200,
      })
      const latencyMs = Date.now() - startTime
      const snippetLengths = results.results.map((r) => r.snippet.length)
      const avgSnippetLength =
        snippetLengths.length > 0 ? Math.round(snippetLengths.reduce((a, b) => a + b, 0) / snippetLengths.length) : 0
      const uniqueSessions = new Set(results.results.map((r) => r.source_id)).size

      return {
        query: label,
        resultCount: results.total,
        latencyMs,
        avgSnippetLength,
        uniqueSessions,
        hasTitles: results.results.some((r) => r.title !== null),
      }
    }

    // Message search
    const msgResults = ftsSearchWithSnippet(db, query, {
      limit: 20,
      sinceTime,
      snippetTokens: 200,
    })
    const latencyMs = Date.now() - startTime

    // Get session titles for title check
    const sessionTitles = getAllSessionTitles()
    const snippetLengths = msgResults.results.map((r) => r.snippet.length)
    const avgSnippetLength =
      snippetLengths.length > 0 ? Math.round(snippetLengths.reduce((a, b) => a + b, 0) / snippetLengths.length) : 0
    const uniqueSessions = new Set(msgResults.results.map((r) => r.session_id)).size
    const hasTitles = msgResults.results.some((r) => sessionTitles.get(r.session_id) !== undefined)

    return {
      query: label,
      resultCount: msgResults.total,
      latencyMs,
      avgSnippetLength,
      uniqueSessions,
      hasTitles,
    }
  } finally {
    closeDb()
  }
}

function formatTimeSince(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
