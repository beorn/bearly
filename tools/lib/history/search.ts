/**
 * search.ts - FTS5 search logic: core search function, query building, result scoring
 */

import {
  getDb,
  closeDb,
  ftsSearchWithSnippet,
  searchAll,
  getAllSessionTitles,
  getSessionContext,
  toFts5Query,
  type MessageSearchOptions,
  type ContentSearchOptions,
} from "./db.ts"
import type { ContentType } from "./types.ts"
import { synthesizeResults } from "./synthesize.ts"
import { log, ONE_HOUR_MS, ONE_DAY_MS, THIRTY_DAYS_MS } from "./recall-shared.ts"
import type { RecallOptions, RecallResult, RecallSearchResult } from "./recall-shared.ts"

import { existsSync, readFileSync } from "node:fs"
import { resolve, basename } from "node:path"

// Re-export shared items so existing internal imports continue to work
export { setRecallLogging, log, ONE_HOUR_MS, ONE_DAY_MS, THIRTY_DAYS_MS } from "./recall-shared.ts"
export type { RecallOptions, RecallResult, RecallSearchResult } from "./recall-shared.ts"

// ============================================================================
// Time parsing
// ============================================================================

/**
 * Parse a relative time string to an absolute timestamp (ms since epoch).
 *
 * Supported formats:
 *   1h, 2h       - Hours ago
 *   1d, 7d       - Days ago
 *   1w, 2w       - Weeks ago
 *   today        - Since midnight today
 *   yesterday    - Since midnight yesterday
 *
 * Returns undefined if parsing fails.
 */
export function parseTimeToMs(timeStr: string): number | undefined {
  const now = Date.now()
  const str = timeStr.toLowerCase().trim()

  // Handle relative time formats: 1h, 2d, 3w
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

  // Handle special keywords
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

// ============================================================================
// Query expansion (static synonym map)
// ============================================================================

/** Static synonym map for common dev terms. Keys are normalized to lowercase. */
const SYNONYMS: Record<string, string[]> = {
  auth: ["authentication", "login", "signin", "sign-in", "oauth", "jwt"],
  bug: ["error", "issue", "fix", "defect", "broken"],
  test: ["spec", "vitest", "assertion", "expect", "describe"],
  refactor: ["restructure", "reorganize", "cleanup", "clean-up"],
  perf: ["performance", "speed", "latency", "benchmark", "slow", "fast"],
  ui: ["interface", "component", "render", "display", "layout"],
  tui: ["terminal", "ink", "@silvery/ag-term", "console"],
  db: ["database", "sqlite", "sql", "query"],
  dep: ["dependency", "package", "module", "import"],
  config: ["configuration", "settings", "options", "preferences"],
  err: ["error", "exception", "throw", "catch", "failure"],
  log: ["logging", "debug", "trace", "console"],
  nav: ["navigation", "navigate", "route", "routing"],
  sync: ["synchronize", "synchronization", "bidirectional", "replicate"],
  cmd: ["command", "keybinding", "shortcut", "hotkey"],
  doc: ["documentation", "readme", "docs"],
  lint: ["eslint", "prettier", "format", "formatting"],
  ci: ["pipeline", "github-actions", "workflow", "continuous-integration"],
  api: ["endpoint", "rest", "request", "response"],
  crash: ["segfault", "panic", "abort", "fatal"],
}

/**
 * Expand a query with synonyms.
 * For each word that matches a synonym key, returns additional queries
 * with synonyms substituted (one synonym per variant).
 *
 * FTS5 doesn't support grouped OR, so we generate variant queries.
 * Example: "auth bug" → ["authentication bug", "login bug", "auth error", "auth issue"]
 *
 * Returns null if no synonyms match.
 */
export function expandQueryVariants(query: string): string[] | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)

  // Find which words have synonyms
  const expansions: { wordIdx: number; synonyms: string[] }[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    if (word.startsWith("-") || word.startsWith('"')) continue
    const cleaned = word.replace(/[?!.,;]+$/, "")
    const syns = SYNONYMS[cleaned]
    if (syns && syns.length > 0) {
      expansions.push({ wordIdx: i, synonyms: syns.slice(0, 3) })
    }
  }

  if (expansions.length === 0) return null

  // Generate variant queries: substitute one synonym at a time
  const variants: string[] = []
  for (const { wordIdx, synonyms } of expansions) {
    for (const syn of synonyms) {
      const variant = [...words]
      variant[wordIdx] = syn
      variants.push(variant.join(" "))
    }
  }

  return variants
}

// ============================================================================
// Recency boost
// ============================================================================

/**
 * Compute a combined score from FTS5 rank and recency.
 * BM25 rank is negative (more negative = better match).
 * Recency factor: 1 / (1 + days_ago / 7), half-life ~1 week.
 * Combined: rank / recency_factor (dividing a negative number by a value <1 makes it more negative = better)
 */
export function boostedRank(rank: number, timestamp: number): number {
  const daysAgo = (Date.now() - timestamp) / ONE_DAY_MS
  const recencyFactor = 1 / (1 + daysAgo / 7)
  // rank is negative (bm25), so multiplying by recencyFactor (0..1) makes recent items more negative = better
  return rank * recencyFactor
}

// ============================================================================
// Live session search — grep current session's JSONL (not yet indexed)
// ============================================================================

export function searchLiveSession(query: string, limit: number): RecallSearchResult[] {
  const sessionId = process.env.CLAUDE_SESSION_ID
  if (!sessionId) return []

  // Find the live JSONL — Claude Code stores sessions at ~/.claude/projects/{slug}/{id}.jsonl
  // The slug is the CWD with / replaced by - (e.g., /Users/beorn/Code → -Users-beorn-Code)
  const home = process.env.HOME ?? ""
  const cwd = process.cwd()
  const projectSlug = cwd.replaceAll("/", "-")
  const projectDir = resolve(home, ".claude/projects", projectSlug)
  const jsonlPath = resolve(projectDir, `${sessionId}.jsonl`)
  if (!existsSync(jsonlPath)) return []

  try {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2)
    if (terms.length === 0) return []

    // Use grep for fast pre-filtering — much faster than reading 40MB into memory
    const grepPattern = terms[0]!
    const proc = Bun.spawnSync(["grep", "-i", "-n", grepPattern, jsonlPath], {
      stdout: "pipe",
      stderr: "ignore",
    })
    if (!proc.stdout) return []

    const grepOutput = proc.stdout.toString()
    const matchingLines = grepOutput.split("\n").filter(Boolean)
    const results: RecallSearchResult[] = []

    // Process from end (most recent matches first)
    for (let i = matchingLines.length - 1; i >= 0 && results.length < limit; i--) {
      const line = matchingLines[i]!
      const colonIdx = line.indexOf(":")
      if (colonIdx < 0) continue
      const jsonStr = line.slice(colonIdx + 1)

      try {
        const msg = JSON.parse(jsonStr) as { type?: string; timestamp?: number; message?: { content?: unknown } }
        if (msg.type !== "human" && msg.type !== "assistant") continue

        const text =
          typeof msg.message?.content === "string"
            ? msg.message.content
            : Array.isArray(msg.message?.content)
              ? (msg.message.content as Array<{ type: string; text: string }>)
                  .filter((c) => c.type === "text")
                  .map((c) => c.text)
                  .join(" ")
              : ""
        if (!text) continue

        const lower = text.toLowerCase()
        const matchCount = terms.filter((t) => lower.includes(t)).length
        if (matchCount < Math.ceil(terms.length / 2)) continue

        // Extract snippet around first match
        const firstIdx = Math.min(...terms.map((t) => lower.indexOf(t)).filter((idx) => idx >= 0))
        const start = Math.max(0, firstIdx - 100)
        const snippet = text.slice(start, start + 500)

        results.push({
          type: "message",
          sessionId,
          sessionTitle: "(current session)",
          timestamp: msg.timestamp ?? Date.now(),
          snippet: `[CURRENT SESSION] ${snippet}`,
          rank: -100 - matchCount,
        })
      } catch {
        /* skip malformed */
      }
    }

    return results
  } catch {
    return []
  }
}

// ============================================================================
// Core recall function
// ============================================================================

/**
 * Search session history and optionally synthesize results via cheap LLM.
 *
 * Searches both the messages FTS table and the unified content table
 * (plans, summaries, todos), merges results by rank, deduplicates by session,
 * and optionally passes them through a cheap LLM for synthesis.
 */
export async function recall(query: string, options: RecallOptions = {}): Promise<RecallResult> {
  const { limit = 10, raw = false, since, json = false, timeout = 4000, snippetTokens = 200, projectFilter } = options

  const startTime = Date.now()
  const sinceLabel = since ?? "30d"
  log(`search query="${query.slice(0, 80)}" limit=${limit} since=${sinceLabel} raw=${raw} timeout=${timeout}ms`)

  const db = getDb()

  try {
    // Parse time filter (default: 30 days)
    let sinceTime: number | undefined
    if (since) {
      sinceTime = parseTimeToMs(since)
      if (sinceTime === undefined) {
        log(`invalid time filter: "${since}"`)
        return {
          query,
          synthesis: null,
          results: [],
          durationMs: Date.now() - startTime,
        }
      }
    } else {
      sinceTime = Date.now() - THIRTY_DAYS_MS
    }

    // Search messages table with FTS5
    const messageOpts: MessageSearchOptions = {
      limit: limit * 2, // Fetch extra for dedup
      sinceTime,
      projectFilter,
      snippetTokens,
    }

    const searchStart = Date.now()
    const messageResults = ftsSearchWithSnippet(db, query, messageOpts)
    const msgMs = Date.now() - searchStart
    log(`FTS5 messages: ${messageResults.total} total, ${messageResults.results.length} returned (${msgMs}ms)`)

    // Search session-scoped content (plans, summaries, todos, first_prompts) with time filter
    const sessionContentOpts: ContentSearchOptions = {
      limit: limit * 2,
      sinceTime,
      projectFilter,
      snippetTokens,
      types: ["plan", "summary", "todo", "first_prompt"] as ContentType[],
    }

    const contentStart = Date.now()
    const sessionContentResults = searchAll(db, query, sessionContentOpts)
    const sessionMs = Date.now() - contentStart

    // Search project knowledge sources (beads, memory, docs) WITHOUT time filter
    const projectStart = Date.now()
    const projectContentOpts: ContentSearchOptions = {
      limit: limit * 2,
      projectFilter,
      snippetTokens,
      types: ["bead", "session_memory", "project_memory", "doc", "claude_md", "llm_research"] as ContentType[],
    }

    const projectContentResults = searchAll(db, query, projectContentOpts)
    const projectMs = Date.now() - projectStart

    // Query expansion: search with synonym variants for broader recall
    const SYNONYM_RANK_PENALTY = 5 // Penalize synonym matches to rank below exact matches
    const queryVariants = expandQueryVariants(query)
    let synonymMsgCount = 0
    let synonymContentCount = 0

    if (queryVariants) {
      log(`query expansion: "${query}" → ${queryVariants.length} variants`)
      // Collect IDs already found to avoid duplicates
      const seenMsgIds = new Set(messageResults.results.map((r) => r.id))
      const seenContentIds = new Set([
        ...sessionContentResults.results.map((r) => r.id),
        ...projectContentResults.results.map((r) => r.id),
      ])

      for (const variant of queryVariants.slice(0, 4)) {
        try {
          // Search messages with variant
          const varMsgs = ftsSearchWithSnippet(db, variant, {
            ...messageOpts,
            limit: limit,
          })
          for (const r of varMsgs.results) {
            if (!seenMsgIds.has(r.id)) {
              seenMsgIds.add(r.id)
              r.rank += SYNONYM_RANK_PENALTY
              messageResults.results.push(r)
              synonymMsgCount++
            }
          }

          // Search session content with variant
          const varSession = searchAll(db, variant, {
            ...sessionContentOpts,
            limit: limit,
          })
          for (const r of varSession.results) {
            if (!seenContentIds.has(r.id)) {
              seenContentIds.add(r.id)
              r.rank += SYNONYM_RANK_PENALTY
              sessionContentResults.results.push(r)
              synonymContentCount++
            }
          }

          // Search project content with variant
          const varProject = searchAll(db, variant, {
            ...projectContentOpts,
            limit: limit,
          })
          for (const r of varProject.results) {
            if (!seenContentIds.has(r.id)) {
              seenContentIds.add(r.id)
              r.rank += SYNONYM_RANK_PENALTY
              projectContentResults.results.push(r)
              synonymContentCount++
            }
          }
        } catch {
          // Skip variants that fail FTS5 parsing
        }
      }

      if (synonymMsgCount > 0 || synonymContentCount > 0) {
        log(`query expansion: added ${synonymMsgCount} messages + ${synonymContentCount} content from synonyms`)
      }
    }

    // Merge both content result sets
    const contentResults = {
      results: [...sessionContentResults.results, ...projectContentResults.results],
      total: sessionContentResults.total + projectContentResults.total,
    }
    const searchMs = Date.now() - searchStart
    log(`FTS5 search: ${searchMs}ms (messages=${msgMs}ms session=${sessionMs}ms project=${projectMs}ms)`)

    // Get session titles for enrichment
    const sessionTitles = getAllSessionTitles()

    // Session depth corroboration: sessions with more matching messages are more relevant.
    // A session with 10 messages about the topic is more authoritative than one with 1 passing mention.
    const corroborationStart = Date.now()
    const ftsQuery = toFts5Query(query)
    const sessionDepths = new Map<string, number>()
    try {
      const depthRows = db
        .prepare(
          `SELECT m.session_id, COUNT(*) as depth
           FROM messages_fts f
           JOIN messages m ON f.rowid = m.id
           WHERE messages_fts MATCH ?
           GROUP BY m.session_id
           ORDER BY depth DESC
           LIMIT 100`,
        )
        .all(ftsQuery) as { session_id: string; depth: number }[]
      for (const r of depthRows) {
        sessionDepths.set(r.session_id, r.depth)
      }
    } catch {
      // FTS5 query parsing can fail for some edge cases — skip corroboration
    }
    const corroborationMs = Date.now() - corroborationStart
    if (sessionDepths.size > 0) {
      const maxDepth = Math.max(...sessionDepths.values())
      log(`corroboration: ${sessionDepths.size} sessions, max depth=${maxDepth} (${corroborationMs}ms)`)
    }

    // Search current (live) session — not yet indexed
    const liveStart = Date.now()
    const liveResults = searchLiveSession(query, limit)
    const liveMs = Date.now() - liveStart
    if (liveResults.length > 0) {
      log(`live session: ${liveResults.length} matches (${liveMs}ms)`)
    }

    // Merge results into a unified list
    const merged: RecallSearchResult[] = []

    // Live session results get top priority (rank = -100, very negative = best)
    for (const r of liveResults) {
      merged.push(r)
    }

    for (const r of messageResults.results) {
      // Apply corroboration boost: divide BM25 rank by log2(depth+1)
      // BM25 is negative (more negative = better), so dividing by >1 makes it more negative = better
      const depth = sessionDepths.get(r.session_id) ?? 1
      const corroborationBoost = depth > 1 ? Math.log2(depth + 1) : 1

      merged.push({
        type: "message",
        sessionId: r.session_id,
        sessionTitle: sessionTitles.get(r.session_id) ?? null,
        timestamp: Number(r.timestamp),
        snippet: r.snippet || (r.content?.slice(0, 500) ?? ""),
        rank: r.rank / corroborationBoost,
      })
    }

    for (const r of contentResults.results) {
      merged.push({
        type: r.content_type as RecallSearchResult["type"],
        sessionId: r.source_id,
        sessionTitle: r.title ?? sessionTitles.get(r.source_id) ?? null,
        timestamp: Number(r.timestamp),
        snippet: r.snippet || r.content.slice(0, 500),
        rank: r.rank,
      })
    }

    // Sort by recency-boosted rank (bm25 * recency_factor — lower is better)
    merged.sort((a, b) => boostedRank(a.rank, a.timestamp) - boostedRank(b.rank, b.timestamp))

    // Dedup: keep best result per session
    const seen = new Set<string>()
    const deduped: RecallSearchResult[] = []
    for (const result of merged) {
      const key = `${result.sessionId}:${result.type}`
      if (!seen.has(key)) {
        seen.add(key)
        deduped.push(result)
      }
      if (deduped.length >= limit) break
    }

    const uniqueSessions = new Set(deduped.map((r) => r.sessionId)).size
    log(
      `merged: ${merged.length} raw → ${deduped.length} deduped from ${uniqueSessions} sessions (${Date.now() - searchStart}ms total search)`,
    )

    // Session proximity: expand top message results with neighboring context
    const proximityStart = Date.now()
    const TOP_N = Math.min(5, deduped.length)
    let contextExpanded = 0
    for (let i = 0; i < TOP_N; i++) {
      const result = deduped[i]!
      if (result.type !== "message") continue

      const neighbors = getSessionContext(db, result.sessionId, result.timestamp, 5)
      if (neighbors.length > 1) {
        // Build expanded snippet from neighboring messages
        const contextParts: string[] = []
        for (const n of neighbors) {
          if (!n.content) continue
          const role = n.type === "user" ? "[User]" : n.type === "assistant" ? "[Assistant]" : `[${n.type}]`
          const text = n.content.slice(0, 200)
          contextParts.push(`${role} ${text}`)
        }
        if (contextParts.length > 0) {
          const expandedSnippet = contextParts.join("\n---\n")
          // Replace snippet with expanded context (keeping original at front)
          result.snippet = expandedSnippet.slice(0, 1500)
          contextExpanded++
        }
      }
    }
    if (contextExpanded > 0) {
      log(
        `session proximity: expanded ${contextExpanded} results with neighboring context (${Date.now() - proximityStart}ms)`,
      )
    }

    // No results — return early
    if (deduped.length === 0) {
      log(`no results found (${Date.now() - startTime}ms total)`)
      return {
        query,
        synthesis: null,
        results: [],
        durationMs: Date.now() - startTime,
      }
    }

    // Raw mode — return results as-is without LLM
    if (raw) {
      log(`raw mode — returning ${deduped.length} results without synthesis (${Date.now() - startTime}ms total)`)
      return {
        query,
        synthesis: null,
        results: deduped,
        durationMs: Date.now() - startTime,
        timing: { searchMs },
      }
    }

    // Attempt LLM synthesis with AbortController for clean timeout
    const llmStart = Date.now()
    const synthesis = await synthesizeResults(query, deduped, timeout)
    const llmMs = Date.now() - llmStart

    const totalMs = Date.now() - startTime
    if (synthesis.text) {
      log(
        `synthesis OK: ${synthesis.text.length} chars, cost=$${(synthesis.cost ?? 0).toFixed(4)} (${totalMs}ms total, search=${searchMs}ms llm=${llmMs}ms${synthesis.aborted ? " ABORTED" : ""})`,
      )
    } else {
      log(
        `synthesis returned null (${totalMs}ms total, search=${searchMs}ms llm=${llmMs}ms${synthesis.aborted ? " ABORTED" : ""})`,
      )
    }

    return {
      query,
      synthesis: synthesis.text,
      results: deduped,
      durationMs: totalMs,
      llmCost: synthesis.cost,
      timing: { searchMs, llmMs },
    }
  } finally {
    closeDb()
  }
}
