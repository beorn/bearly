/**
 * Unified search command — FTS5 search with optional LLM synthesis, grep, and raw filters.
 */

import * as path from "path"
import * as fs from "fs"
import {
  getDb,
  closeDb,
  getIndexMeta,
  PROJECTS_DIR,
  ftsSearchWithSnippet,
  searchAll,
  getAllSessionTitles,
  type MessageSearchOptions,
} from "../history/db"
import { recall, type RecallOptions, type RecallResult, type RecallSearchResult } from "../history/recall"
import type { AgentRecallOptions, AgentRecallResult } from "./agent.ts"
import type { QueryPlan } from "./plan.ts"
import { searchLiveSession } from "../history/search"
import { findSessionFiles, extractTextContent } from "../history/indexer"
import type { ContentType, ContentRecord, MessageRecord, JsonlRecord } from "../history/types"
import {
  BOLD,
  RESET,
  DIM,
  CYAN,
  YELLOW,
  GREEN,
  MAGENTA,
  THIRTY_DAYS_MS,
  parseTime,
  parseInclude,
  formatBytes,
  formatTime,
  formatRelativeTime,
  displayProjectPath,
  formatSessionId,
  highlightMatch,
  groupBy,
} from "./format"

// ============================================================================
// Search options
// ============================================================================

export interface SearchOptions {
  raw?: boolean
  /** Alias for raw — vocabulary parity with accountly's "snippet vs pointer" mode. */
  snippets?: boolean
  json?: boolean
  since?: string
  limit?: string
  timeout?: string
  project?: string
  grep?: boolean
  question?: boolean
  response?: boolean
  tool?: string
  session?: string
  include?: string
  agent?: boolean
  round2?: "auto" | "wider" | "deeper" | "off"
  maxRounds?: string
  debugPlan?: boolean
  planTimeout?: string
  /**
   * Commander maps --no-speculative-synth to speculativeSynth:false.
   * Default (undefined) = speculative synth enabled.
   */
  speculativeSynth?: boolean
  /**
   * Commander maps --no-refresh to refresh:false. Default (undefined) = auto-refresh
   * the FTS5 index before search when stale. Pass --no-refresh for batch/scripted
   * use that doesn't want the subprocess side-effect.
   */
  refresh?: boolean
}

// ============================================================================
// Stale-index auto-refresh — see @km/bearly/19216-recall-freshness-shrink-threshold
// ============================================================================

// Pure helpers (parseThreshold/getStaleThresholdMs/RefreshResult/RECALL_STALE_THRESHOLD_DEFAULT)
// live in staleness.ts so unit tests can import them without dragging the search.ts
// transitive closure (bun:sqlite, indexer, llm/agent → zod) into vitest's node runtime.
export {
  RECALL_STALE_THRESHOLD_DEFAULT,
  parseThreshold,
  getStaleThresholdMs,
  type RefreshResult,
} from "./staleness"
import { getStaleThresholdMs, type RefreshResult } from "./staleness"

/**
 * Check if the FTS5 index is stale and, if so, run `bun recall index --incremental`
 * as a subprocess to refresh it before the search proceeds.
 *
 * Best-effort: on subprocess failure, returns { refreshed: false, reason: "error" }
 * with the error message — never throws, so a transient refresh problem doesn't
 * break search. Caller is responsible for printing a one-line note from the result.
 *
 * Honors RECALL_STALE_THRESHOLD env var (e.g. "5m", "1h", "30s") and the
 * `--no-refresh` opt-out flag (mapped to options.refresh === false by commander).
 */
export async function refreshIndexIfStale(
  options: { refresh?: boolean },
  /** Test seam — pass a fake spawner to avoid the real subprocess. */
  spawnCmd: (argv: string[]) => Promise<{ exitCode: number; stderr?: string }> = defaultSpawnCmd,
): Promise<RefreshResult> {
  if (options.refresh === false) return { refreshed: false, reason: "opt-out" }

  let staleMs = 0
  try {
    const db = getDb()
    try {
      const lastRebuild = getIndexMeta(db, "last_rebuild") ?? null
      if (!lastRebuild) return { refreshed: false, reason: "no-meta" }
      staleMs = Date.now() - new Date(lastRebuild).getTime()
      if (staleMs <= getStaleThresholdMs()) return { refreshed: false, reason: "fresh" }
    } finally {
      closeDb()
    }
  } catch (e) {
    return { refreshed: false, reason: "error", error: e instanceof Error ? e.message : String(e), staleMs }
  }

  const start = Date.now()
  try {
    const result = await spawnCmd(["bun", "recall", "index", "--incremental"])
    if (result.exitCode !== 0) {
      return {
        refreshed: false,
        reason: "error",
        error: `bun recall index --incremental exited ${result.exitCode}${result.stderr ? `: ${result.stderr.trim().split("\n")[0]}` : ""}`,
        staleMs,
      }
    }
    return { refreshed: true, staleMs, refreshMs: Date.now() - start }
  } catch (e) {
    return { refreshed: false, reason: "error", error: e instanceof Error ? e.message : String(e), staleMs }
  }
}

async function defaultSpawnCmd(argv: string[]): Promise<{ exitCode: number; stderr?: string }> {
  const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" })
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return { exitCode, stderr }
}

// ============================================================================
// Main search command
// ============================================================================

export async function cmdSearch(query: string | undefined, options: SearchOptions): Promise<void> {
  const {
    raw,
    json,
    since,
    limit: limitStr,
    timeout: timeoutStr,
    project,
    grep: regexMode,
    question,
    response,
    tool,
    session,
    include,
  } = options

  // Auto-refresh stale FTS5 index BEFORE search runs (so results reflect the last
  // few minutes of work). See @km/bearly/19216-recall-freshness-shrink-threshold.
  // Skipped silently for JSON output (programmatic consumers shouldn't see prelude noise).
  const refresh = await refreshIndexIfStale(options)
  if (!json) emitRefreshNote(refresh)

  // Power-user flags imply raw mode. --snippets is an explicit alias for
  // --raw — surfaces the vocabulary used by the accountly side ("snippet vs
  // pointer" mode) for users who learned that distinction first.
  const impliedRaw =
    raw || !!options.snippets || !!question || !!response || !!tool || !!session || !!include || !!regexMode

  // Regex mode delegates to grep
  if (regexMode) {
    if (!query) {
      console.error("Regex mode requires a search pattern")
      process.exit(1)
    }
    const limit = limitStr ? parseInt(limitStr, 10) : 50
    await cmdGrep(query, { project, limit })
    return
  }

  // No query and no filters → show help
  if (!query && !question && !response && !tool && !since) {
    console.error("Usage: recall <query> [options]")
    console.error("Run `recall --help` for all options.")
    process.exit(1)
  }

  // If raw/implied-raw with query → direct FTS5 search (old `bun history` behavior)
  if (impliedRaw) {
    await rawSearch(query, {
      ...options,
      limit: limitStr ? parseInt(limitStr, 10) : 10,
    })
    return
  }

  // Default: LLM synthesis mode via recall()
  const recallOpts: RecallOptions = {
    raw: false,
    json: json,
    since,
    limit: limitStr ? parseInt(limitStr, 10) : 10,
    timeout: timeoutStr ? parseInt(timeoutStr, 10) : 10000,
    projectFilter: project,
  }

  const agentEnabled = !!options.agent || !!options.debugPlan || process.env.RECALL_AGENT === "1"
  if (agentEnabled) {
    await runAgentSearch(query!, options, recallOpts)
    return
  }

  const result = await recall(query!, recallOpts)
  formatRecallOutput(result, { json })
}

async function runAgentSearch(query: string, options: SearchOptions, base: RecallOptions): Promise<void> {
  const { recallAgent } = await import("./agent.ts")
  const agentOpts: AgentRecallOptions = {
    ...base,
    round2: options.round2 ?? "auto",
    maxRounds: options.maxRounds ? (parseInt(options.maxRounds, 10) === 1 ? 1 : 2) : 2,
    planTimeoutMs: options.planTimeout ? parseInt(options.planTimeout, 10) : undefined,
    debugPlan: !!options.debugPlan,
    speculativeSynth: options.speculativeSynth,
  }

  const result = await recallAgent(query, agentOpts)

  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  // Always print the one-line per-round trace so users can see what was searched.
  printAgentTrace(result, !!options.debugPlan)

  if (result.results.length === 0) {
    const rawProbe = probeLiteralRawMatches(query, base)
    if (rawProbe && rawProbe.result.results.length > 0) {
      emitSearchPrelude(base.projectFilter)
      console.log(
        `${YELLOW}⚠ recall: agent variants missed literal raw matches; showing raw hits for "${rawProbe.token}".${RESET}\n`,
      )
      formatRawRecallResults(rawProbe.result)
      return
    }
  }

  // Reuse the standard output formatter for the final answer.
  formatRecallOutput(result, { json: false })

  // Surface the synth path explicitly after the answer — users should know
  // whether the answer was short-circuited after round 1 or cost 2 synth
  // calls (one of which was wasted).
  const synthLabel = describeSynthPath(result.trace)
  if (synthLabel) {
    console.log(`${DIM}${synthLabel}${RESET}`)
  }

  if (result.traceFile) {
    console.log(`${DIM}trace: ${result.traceFile}${RESET}`)
  }
}

const RAW_PROBE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "be",
  "but",
  "by",
  "do",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "or",
  "should",
  "the",
  "this",
  "to",
  "we",
  "what",
  "when",
  "where",
  "why",
  "with",
])

function literalRawProbeTokens(query: string): string[] {
  const seen = new Set<string>()
  return (query.match(/[\p{L}\p{N}_@#./:-]+/gu) ?? [])
    .map((token) => token.replace(/^[^\p{L}\p{N}_@#]+|[^\p{L}\p{N}_@#]+$/gu, ""))
    .filter((token) => token.length >= 3)
    .filter((token) => !RAW_PROBE_STOPWORDS.has(token.toLowerCase()))
    .filter((token) => {
      const key = token.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => b.length - a.length)
    .slice(0, 5)
}

function probeLiteralRawMatches(query: string, base: RecallOptions): { token: string; result: RecallResult } | null {
  const tokens = literalRawProbeTokens(query)
  if (tokens.length === 0) return null

  const db = getDb()
  const sessionTitles = getAllSessionTitles()
  const limit = base.limit ?? 10
  const sinceTime = base.since ? parseTime(base.since) : Date.now() - THIRTY_DAYS_MS
  const projectFilter = base.projectFilter

  for (const token of tokens) {
    const start = Date.now()
    const messageResults = ftsSearchWithSnippet(db, token, {
      limit,
      sinceTime,
      projectFilter,
      snippetTokens: 200,
    })
    const contentResults = searchAll(db, token, {
      limit,
      projectFilter,
      types: [
        "plan",
        "summary",
        "todo",
        "first_prompt",
        "bead",
        "session_memory",
        "project_memory",
        "doc",
        "claude_md",
        "llm_research",
      ] as ContentType[],
    })

    const results: RecallSearchResult[] = [
      ...messageResults.results.map((r) => ({
        type: "message" as const,
        sessionId: r.session_id,
        sessionTitle: sessionTitles.get(r.session_id) ?? null,
        timestamp: Number(r.timestamp),
        snippet: r.snippet || (r.content?.slice(0, 500) ?? ""),
        rank: r.rank,
      })),
      ...contentResults.results.map((r) => ({
        type: r.content_type as RecallSearchResult["type"],
        sessionId: r.source_id,
        sessionTitle: r.title ?? sessionTitles.get(r.source_id) ?? null,
        timestamp: Number(r.timestamp),
        snippet: r.snippet || r.content.slice(0, 500),
        rank: r.rank,
      })),
    ]
      .sort((a, b) => a.rank - b.rank)
      .slice(0, limit)

    if (results.length > 0) {
      const durationMs = Date.now() - start
      return {
        token,
        result: {
          query: token,
          synthesis: null,
          results,
          durationMs,
          timing: { searchMs: durationMs },
        },
      }
    }
  }

  return null
}

function describeSynthPath(trace: AgentRecallResult["trace"]): string {
  const { synthPath, synthCallsUsed, round1ShortCircuited, rounds } = trace
  if (!synthPath || synthPath === "none") return ""

  const calls = synthCallsUsed ?? 1
  const callsLabel = calls === 2 ? "2 synth calls (1 WASTED)" : "1 synth call"
  const round2Ran = rounds.length >= 2 && rounds[1]!.variants.length > 0

  // Four honest outcomes:
  if (!round2Ran) {
    // Round 1 was enough (short-circuit or max-rounds=1). One synth call.
    return `↳ short-circuited after round 1 — ${callsLabel}`
  }
  if (round1ShortCircuited) {
    // Round 2 ran but was judged marginal; spec answer was used. One synth call.
    return `↳ round 2 ran but was marginal — used round-1 speculative synth — ${callsLabel}`
  }
  if (calls === 2) {
    // Speculative was fired AND a fresh synth was also needed. Two synth calls.
    return `↳ round 2 added new top-K docs — fresh synth ran AND speculative was WASTED — ${callsLabel}`
  }
  // Speculative was disabled; single fresh synth on merged results.
  return `↳ fresh synth on merged round-1+round-2 results (speculative disabled) — ${callsLabel}`
}

function printAgentTrace(result: AgentRecallResult, debugPlan: boolean): void {
  for (const round of result.trace.rounds) {
    const label = round.round === 1 ? "plan r1" : `plan r2 (${round.mode ?? "?"})`
    const plannerInfo = round.planner.model
      ? `${round.planner.model} ${round.planner.elapsedMs}ms`
      : round.planner.error
        ? `${DIM}no-planner (${round.planner.error})${RESET}`
        : `${DIM}no-planner${RESET}`

    console.log(`${DIM}[${label}]${RESET} ${plannerInfo}`)

    const plan = round.plan as QueryPlan | null
    if (plan && round.variants.length > 0) {
      console.log(
        `  ${DIM}variants (${round.variants.length}):${RESET} ${round.variants.slice(0, 10).join(", ")}${round.variants.length > 10 ? ", …" : ""}`,
      )

      if (debugPlan) {
        if (plan.keywords.length) console.log(`    keywords: ${plan.keywords.join(", ")}`)
        if (plan.phrases.length) console.log(`    phrases:  ${plan.phrases.join(" | ")}`)
        if (plan.concepts.length) console.log(`    concepts: ${plan.concepts.join(", ")}`)
        if (plan.paths.length) console.log(`    paths:    ${plan.paths.join(", ")}`)
        if (plan.errors.length) console.log(`    errors:   ${plan.errors.join(" | ")}`)
        if (plan.bead_ids.length) console.log(`    bead_ids: ${plan.bead_ids.join(", ")}`)
        if (plan.time_hint) console.log(`    time_hint: ${plan.time_hint}`)
        if (plan.notes) console.log(`    notes: ${plan.notes}`)
      }
    }

    if (round.variants.length > 0) {
      const s = round.stats
      console.log(
        `  ${DIM}fanout:${RESET} ${s.totalQueries} queries → ${s.rawHits} raw → ${s.uniqueDocs} unique, top-coverage=${s.topCoverage}/${round.variants.length}, median=${s.medianCoverage} (${s.msTotal}ms)`,
      )
    }
  }

  const d = result.trace.decision
  if (result.trace.rounds.length > 0) {
    console.log(`${DIM}[decide]${RESET} round2=${d.round2Mode} — ${d.reason}`)
  }

  if (result.trace.synthPath && result.trace.synthPath !== "none") {
    console.log(`${DIM}[synth]${RESET} path=${result.trace.synthPath}`)
  }

  if (result.fellThrough) {
    const reason = result.trace.rounds[0]?.planner.error ?? "planner unavailable"
    console.log(`${DIM}[fallthrough]${RESET} ${reason} — used default recall`)
  }
  console.log()
}

// ============================================================================
// Recall output (synthesis mode)
// ============================================================================

/**
 * NO SILENT ERRORS — recall output prelude.
 *
 * Per `docs/principles.md` § "Fail Loud, Fail Now" + @km/all/silent-errors-enforcement
 * violations #3, #4, #5: search results MUST surface what was searched, where we
 * looked, and what was excluded. Prepends warnings to result output:
 *
 *   #5 — stale index: when last_rebuild > 1h ago, warn that recent sessions
 *        may not be in the FTS index yet. Status command already says "(stale)";
 *        search results need the same warn so users don't trust empty results.
 *   #3 — project scope: when no --project filter passed AND sibling -wtN dirs
 *        exist in ~/.claude/projects, warn that those sessions are NOT excluded
 *        by default (the filter only narrows; absence means "all projects").
 *        This catches the "silent empty when wrong scope expected" failure mode.
 */
/**
 * Print a one-line note about the auto-refresh attempt to stderr.
 * Silent on the "fresh" path (the happy path — no need to spam users every search).
 */
export function emitRefreshNote(r: RefreshResult): void {
  if (r.refreshed) {
    const staleMin = Math.max(1, Math.round(r.staleMs / 60_000))
    console.error(
      `${DIM}[recall] index was ${staleMin}m stale — refreshed (${r.refreshMs}ms) before search${RESET}`,
    )
    return
  }
  if (r.reason === "error") {
    console.error(
      `${YELLOW}⚠ recall: auto-refresh failed (${r.error}) — proceeding with possibly-stale index.${RESET}\n` +
        `  Pass \`--no-refresh\` to skip this attempt, or run \`bun recall index --incremental\` manually.`,
    )
    return
  }
  // "fresh" | "no-meta" | "opt-out" — silent (happy path or intentional).
}

function emitSearchPrelude(projectFilter: string | undefined): void {
  // #5 — stale index check (post-refresh: if the auto-refresh succeeded the index
  // is now fresh and this branch is silent; we still warn for the no-meta /
  // refresh-failed / opt-out cases where the auto-refresh didn't run or didn't help).
  try {
    const db = getDb()
    const lastRebuild = getIndexMeta(db, "last_rebuild") ?? null
    if (lastRebuild) {
      const ageMs = Date.now() - new Date(lastRebuild).getTime()
      const thresholdMs = getStaleThresholdMs()
      if (ageMs > thresholdMs) {
        const ageMin = Math.max(1, Math.round(ageMs / 60_000))
        const thresholdMin = Math.max(1, Math.round(thresholdMs / 60_000))
        console.error(
          `${YELLOW}⚠ recall: FTS5 index last rebuilt ${ageMin}m ago (stale > ${thresholdMin}m) — recent sessions may be missing.${RESET}\n` +
            `  Run \`bun recall index --incremental\` to refresh manually, or unset \`--no-refresh\`.`,
        )
      }
    }
  } catch {
    // Best-effort — never break search on prelude errors.
  }

  // #3 — sibling -wtN project dirs check
  try {
    const home = process.env.HOME ?? ""
    const projectsDir = path.join(home, ".claude", "projects")
    if (fs.existsSync(projectsDir)) {
      const cwd = process.cwd()
      const cwdSlug = "-" + cwd.slice(1).replace(/\//g, "-")
      const matchesCwd = fs.existsSync(path.join(projectsDir, cwdSlug))
      if (matchesCwd) {
        // Find sibling dirs that share the base name (e.g., -...-km-wt0 alongside -...-km)
        const siblings = fs
          .readdirSync(projectsDir)
          .filter(
            (d) =>
              d.startsWith(cwdSlug + "-wt") ||
              (d.startsWith(cwdSlug) && d !== cwdSlug && /^-wt\d+/.test(d.slice(cwdSlug.length))),
          )
        if (siblings.length > 0 && !projectFilter) {
          const basename = cwd.split("/").pop() ?? "project"
          console.error(
            `${YELLOW}⚠ recall: ${siblings.length} sibling worktree project dir(s) detected (${siblings.slice(0, 3).join(", ")}${siblings.length > 3 ? "…" : ""}).${RESET}\n` +
              `  Default scope = ALL projects (no current-project narrowing), but if the\n` +
              `  planner-generated variants are project-context-scoped, sibling -wtN\n` +
              `  sessions may be missed. Pass \`--project '*${basename}*'\` to aggregate.`,
          )
        }
      }
    }
  } catch {
    // Best-effort — never break search on prelude errors.
  }
}

function formatRecallOutput(result: RecallResult, options: { json?: boolean }): void {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  // NO SILENT ERRORS — surface stale-index + worktree-scope warnings BEFORE result.
  emitSearchPrelude((result as RecallResult & { projectFilter?: string }).projectFilter)

  if (result.results.length === 0) {
    // #4 — agent zero-result lie. When agent mode returns 0 but the literal
    // query is non-empty + non-trivial, surface explicitly that the FTS fanout
    // returned 0 and suggest --raw fallback. The previous "No results found"
    // looked authoritative when it wasn't — raw mode with the same token
    // may return matches (variant-construction bug class).
    console.log(`No results found for "${result.query}"`)
    if (result.query.trim().length > 0) {
      const probeToken = literalRawProbeTokens(result.query)[0] ?? result.query.split(/\s+/)[0]
      console.log(
        `${DIM}  Note: if you expect matches, try \`bun recall --raw "${probeToken}"\`. Agent mode's planner-generated FTS variants may not cover the literal token.${RESET}`,
      )
    }
    console.log(`${DIM}(searched in ${result.durationMs}ms)${RESET}`)
    return
  }

  if (result.synthesis) {
    console.log(result.synthesis)
    console.log()
    const uniqueSessions = new Set(result.results.map((r) => r.sessionId)).size
    const timingParts = [`${result.durationMs}ms`]
    if (result.timing) {
      timingParts.push(`search=${result.timing.searchMs}ms`)
      if (result.timing.llmMs !== undefined) timingParts.push(`llm=${result.timing.llmMs}ms`)
    }
    console.log(
      `${DIM}${result.results.length} results from ${uniqueSessions} sessions (${timingParts.join(", ")})${RESET}`,
    )
    if (result.llmCost !== undefined && result.llmCost > 0) {
      console.log(`${DIM}LLM cost: $${result.llmCost.toFixed(4)}${RESET}`)
    }
    return
  }

  // Fallback: synthesis failed/aborted, show raw results
  formatRawRecallResults(result)
}

function formatRawRecallResults(result: RecallResult): void {
  console.log(`${BOLD}${result.results.length} results${RESET} for "${result.query}":\n`)

  for (const r of result.results) {
    const date = new Date(r.timestamp)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, "Z")
    const typeLabel = formatType(r.type)
    const sessionLabel = r.sessionTitle ? `${r.sessionTitle}` : `${r.sessionId.slice(0, 8)}...`

    console.log(`${typeLabel} ${BOLD}${sessionLabel}${RESET} ${DIM}(${date})${RESET}`)

    const highlighted = r.snippet.replace(/>>>/g, `${BOLD}${YELLOW}`).replace(/<<</g, RESET)
    const indented = highlighted
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n")
    console.log(indented)
    console.log()
  }

  const timingParts = [`${result.durationMs}ms`]
  if (result.timing) {
    timingParts.push(`search=${result.timing.searchMs}ms`)
    if (result.timing.llmMs !== undefined) timingParts.push(`llm=${result.timing.llmMs}ms`)
  }
  console.log(`${DIM}(${timingParts.join(", ")})${RESET}`)
}

function formatType(type: string): string {
  switch (type) {
    case "message":
      return `${CYAN}[msg]${RESET}`
    case "plan":
      return `${GREEN}[plan]${RESET}`
    case "summary":
      return `${YELLOW}[summary]${RESET}`
    case "todo":
      return `${YELLOW}[todo]${RESET}`
    case "first_prompt":
      return `${CYAN}[prompt]${RESET}`
    case "bead":
      return `${MAGENTA}[bead]${RESET}`
    case "session_memory":
      return `${GREEN}[memory]${RESET}`
    case "project_memory":
      return `${GREEN}[proj-mem]${RESET}`
    case "doc":
      return `${CYAN}[doc]${RESET}`
    case "claude_md":
      return `${DIM}[claude]${RESET}`
    default:
      return `[${type}]`
  }
}

// ============================================================================
// Raw FTS5 search (old `bun history` behavior)
// ============================================================================

interface RawSearchOptions extends Omit<SearchOptions, "limit"> {
  limit: number
}

async function rawSearch(query: string | undefined, options: RawSearchOptions): Promise<void> {
  const { include, question, response, tool, since, project, session, limit, json } = options

  // Parse time filter
  let sinceTime: number | undefined
  if (since) {
    sinceTime = parseTime(since)
    if (sinceTime === undefined) {
      console.error(`Invalid time format: ${since}`)
      console.error("Valid formats: 1h, 1d, 1w, today, yesterday")
      process.exit(1)
    }
  } else {
    sinceTime = Date.now() - THIRTY_DAYS_MS
  }

  // Parse content types
  let types: ContentType[] | undefined
  if (include) {
    types = parseInclude(include)
    if (types.length === 0) {
      console.error(`Invalid include types: ${include}`)
      console.error("Valid types: p,m,s,t or plans,messages,summaries,todos")
      process.exit(1)
    }
  }

  // Determine message type filter
  const messageType: "user" | "assistant" | undefined =
    question && response ? undefined : question ? "user" : response ? "assistant" : undefined

  // Allow searching without query if filters are provided
  if (!query && !question && !response && !tool && !since) {
    console.error("Usage: recall <query> [options]")
    process.exit(1)
  }

  // Build search description
  const searchDesc: string[] = []
  if (query) searchDesc.push(`"${query}"`)
  if (types) {
    const typeNames = types.map((t) => (t === "message" ? "messages" : t + "s"))
    searchDesc.push(`in ${typeNames.join(", ")}`)
  }
  if (messageType === "user") searchDesc.push("(questions only)")
  else if (messageType === "assistant") searchDesc.push("(responses only)")
  if (tool) searchDesc.push(`with tool ${tool}`)
  if (since) searchDesc.push(`since ${since}`)
  else searchDesc.push("last 30d")
  if (project) searchDesc.push(`in project ${project}`)
  if (session) searchDesc.push(`session ${session.slice(0, 8)}...`)

  console.log(`${DIM}Searching: ${searchDesc.join(" ")}${RESET}\n`)

  const startTime = Date.now()
  const db = getDb()

  // Determine which sources to search
  const searchMessages = !types || types.includes("message")
  const contentTypes = types?.filter((t) => t !== "message") as ContentType[] | undefined
  const searchContent = !types || (contentTypes && contentTypes.length > 0)

  // Build search options
  const messageOpts: MessageSearchOptions = {
    limit,
    sinceTime,
    messageType,
    toolName: tool,
    sessionId: session,
  }

  if (project) {
    messageOpts.projectFilter = project.replace(/\*/g, "")
  }

  // Search messages table if needed
  let messageResults: {
    results: (MessageRecord & {
      snippet: string
      project_path: string
      rank: number
    })[]
    total: number
  } = { results: [], total: 0 }
  if (searchMessages && query) {
    messageResults = ftsSearchWithSnippet(db, query, messageOpts)
  } else if (searchMessages && !query) {
    const recentQuery = `
      SELECT m.*, s.project_path, '' as snippet, 0 as rank
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE 1=1
      ${sinceTime ? "AND m.timestamp >= ?" : ""}
      ${messageType ? "AND m.type = ?" : ""}
      ${tool ? "AND m.tool_name = ?" : ""}
      ${session ? "AND m.session_id = ?" : ""}
      ${project ? "AND s.project_path LIKE ?" : ""}
      ORDER BY m.timestamp DESC
      LIMIT ?
    `
    const params: (string | number)[] = []
    if (sinceTime) params.push(sinceTime)
    if (messageType) params.push(messageType)
    if (tool) params.push(tool)
    if (session) params.push(session)
    if (project) params.push(`%${project.replace(/\*/g, "")}%`)
    params.push(limit)

    const results = db.prepare(recentQuery).all(...params) as (MessageRecord & {
      snippet: string
      project_path: string
      rank: number
    })[]
    messageResults = { results, total: results.length }
  }

  // Search content table if needed
  // Project source types (bead, session_memory, project_memory, doc, claude_md)
  // are not time-filtered — they represent persistent project knowledge
  const PROJECT_SOURCE_TYPES = new Set(["bead", "session_memory", "project_memory", "doc", "claude_md"])
  const hasOnlyProjectTypes = contentTypes?.every((t) => PROJECT_SOURCE_TYPES.has(t))
  const contentSinceTime = hasOnlyProjectTypes ? undefined : sinceTime

  let contentResults: {
    results: (ContentRecord & { snippet: string; rank: number })[]
    total: number
  } = { results: [], total: 0 }
  if (searchContent && contentTypes?.length !== 0 && query) {
    contentResults = searchAll(db, query, {
      limit,
      projectFilter: project?.replace(/\*/g, ""),
      types: contentTypes,
      sinceTime: contentSinceTime,
    })
  }

  const total = messageResults.total + contentResults.total
  const duration = Date.now() - startTime
  const sessionTitles = getAllSessionTitles()

  const typeIcons: Record<string, string> = {
    message: "\u{1F4AC}",
    user: "\u{1F464}",
    assistant: "\u{1F916}",
    plan: "\u{1F4CB}",
    summary: "\u{1F4DD}",
    todo: "\u2705",
    bead: "\u{1F41E}",
    session_memory: "\u{1F4A1}",
    project_memory: "\u{1F4A1}",
    doc: "\u{1F4D6}",
    claude_md: "\u{1F4D1}",
  }
  const typeColors: Record<string, string> = {
    message: CYAN,
    user: CYAN,
    assistant: CYAN,
    plan: GREEN,
    summary: YELLOW,
    todo: MAGENTA,
    bead: MAGENTA,
    session_memory: GREEN,
    project_memory: GREEN,
    doc: CYAN,
    claude_md: "",
  }

  if (json) {
    const allResults = [
      ...messageResults.results.map((r) => ({
        contentType: "message" as const,
        sourceId: r.session_id,
        projectPath: r.project_path,
        title: sessionTitles.get(r.session_id) || null,
        timestamp: r.timestamp,
        snippet: r.snippet,
        rank: r.rank,
        type: r.type,
      })),
      ...contentResults.results.map((r) => ({
        contentType: r.content_type,
        sourceId: r.source_id,
        projectPath: r.project_path,
        title: r.title,
        timestamp: r.timestamp,
        snippet: r.snippet,
        rank: r.rank,
      })),
    ]
    console.log(JSON.stringify({ query, total, durationMs: duration, results: allResults }, null, 2))
    closeDb()
    return
  }

  // Search live session (current, not yet indexed)
  const liveResults = query && searchMessages ? searchLiveSession(query, Math.min(5, limit)) : []
  const totalWithLive = total + liveResults.length

  if (totalWithLive === 0) {
    const queryPart = query ? ` for "${query}"` : ""
    console.log(`No matches found${queryPart} (searched in ${duration}ms)`)
    closeDb()
    return
  }

  const queryPart = query ? ` for "${query}"` : ""
  console.log(`Found ${totalWithLive} matches${queryPart} in ${duration}ms:\n`)

  // Display live session results first
  if (liveResults.length > 0) {
    console.log(`\u2501`.repeat(60))
    console.log(`\u{1F534} CURRENT SESSION  |  ${liveResults.length} matches`)
    console.log(`\u2501`.repeat(60))
    for (const r of liveResults.slice(0, 3)) {
      const snippet = r.snippet.replace("[CURRENT SESSION] ", "")
      console.log(`\n\u{1F4AC} ${snippet.slice(0, 400)}${snippet.length > 400 ? "..." : ""}`)
      console.log("\u2500".repeat(60))
    }
    if (liveResults.length > 3) {
      console.log(`  ... and ${liveResults.length - 3} more matches in current session`)
    }
    console.log()
  }

  // Display message results grouped by session
  if (messageResults.results.length > 0) {
    const bySession = groupBy(messageResults.results, (r) => r.session_id)

    for (const [sessionId, sessionResults] of bySession) {
      const first = sessionResults[0]!
      const displayProject = displayProjectPath(first.project_path)
      const relTime = formatRelativeTime(first.timestamp)
      const sessionDisplay = formatSessionId(sessionId, sessionTitles)

      console.log(
        `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`,
      )
      console.log(`\u{1F4C1} ${sessionDisplay}  |  ${displayProject}  |  ${relTime}`)
      console.log(
        `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`,
      )

      for (const r of sessionResults.slice(0, 3)) {
        const time = formatTime(r.timestamp)
        const icon = typeIcons[r.type] || "\u{1F4AC}"
        const role = r.type === "user" ? "User" : r.type === "assistant" ? "Assistant" : r.type
        console.log(`\n${icon} ${role} (${time}):`)
        console.log("\u2500".repeat(60))
        if (r.snippet) {
          const highlighted = r.snippet.replace(/>>>/g, "\x1b[1m\x1b[33m").replace(/<<</g, "\x1b[0m")
          console.log(highlighted)
        } else if (r.content) {
          const content = r.content.slice(0, 300)
          console.log(content + (r.content.length > 300 ? "..." : ""))
        }
      }

      if (sessionResults.length > 3) {
        console.log(`\n  ... and ${sessionResults.length - 3} more matches in this session`)
      }
      console.log()
    }
  }

  // Display content results
  if (contentResults.results.length > 0) {
    if (messageResults.results.length > 0) {
      console.log(`\n${"─".repeat(60)}`)
      console.log(`${BOLD}Other Content${RESET}\n`)
    }

    for (const r of contentResults.results) {
      const icon = typeIcons[r.content_type] || "\u{1F4C4}"
      const color = typeColors[r.content_type] || ""
      const relTime = formatRelativeTime(r.timestamp)

      const titleDisplay = r.title || r.source_id.slice(0, 20)
      const projectPart = r.project_path ? ` ${DIM}${displayProjectPath(r.project_path)}${RESET}` : ""

      console.log(
        `${icon} ${color}[${r.content_type}]${RESET} ${BOLD}${titleDisplay}${RESET}${projectPart} ${DIM}(${relTime})${RESET}`,
      )

      const highlighted = r.snippet.replace(/>>>/g, "\x1b[1m\x1b[33m").replace(/<<</g, "\x1b[0m")
      const indentedSnippet = highlighted
        .split("\n")
        .map((line) => `   ${line}`)
        .join("\n")
      console.log(indentedSnippet)
      console.log()
    }
  }

  const shownCount = messageResults.results.length + contentResults.results.length
  if (total > limit) {
    console.log(`${DIM}(showing ${shownCount} of ${total} matches, use -n/--limit <num> to see more)${RESET}`)
  } else if (shownCount === limit && total === limit) {
    console.log(`${DIM}(showing ${shownCount} matches, use -n/--limit <num> to see more if needed)${RESET}`)
  }

  closeDb()
}

// ============================================================================
// Grep (regex search through raw session files)
// ============================================================================

async function cmdGrep(pattern: string, options: { project?: string; limit?: number }): Promise<void> {
  const { project, limit = 50 } = options
  const contextLines = 2

  console.log(`Searching for "${pattern}" in session content...\n`)

  const regex = new RegExp(pattern, "i")
  interface GrepMatch {
    sessionFile: string
    sessionId: string
    timestamp: string
    type: string
    lineNumber: number
    context: string
    matchLine: string
  }
  const matches: GrepMatch[] = []
  let filesSearched = 0

  for await (const sessionFile of findSessionFiles()) {
    const relativePath = path.relative(PROJECTS_DIR, sessionFile)
    const projectName = relativePath.split(path.sep)[0] || ""

    if (project && !projectName.toLowerCase().includes(project.toLowerCase())) {
      continue
    }

    filesSearched++

    const fileContent = fs.readFileSync(sessionFile, "utf8")
    const lines = fileContent.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line?.trim()) continue

      try {
        const record = JSON.parse(line) as JsonlRecord
        const textContent = extractTextContent(record)
        if (!textContent || !regex.test(textContent)) continue

        const contentLines = textContent.split("\n")
        for (let j = 0; j < contentLines.length; j++) {
          const contentLine = contentLines[j]
          if (!contentLine || !regex.test(contentLine)) continue

          const startIdx = Math.max(0, j - contextLines)
          const endIdx = Math.min(contentLines.length, j + contextLines + 1)
          const contextText = contentLines.slice(startIdx, endIdx).join("\n")

          matches.push({
            sessionFile: relativePath,
            sessionId: record.sessionId || path.basename(sessionFile, ".jsonl"),
            timestamp: record.timestamp || "",
            type: record.type || "unknown",
            lineNumber: j + 1,
            context: contextText,
            matchLine: contentLine,
          })

          if (matches.length >= limit) break
        }
        if (matches.length >= limit) break
      } catch {
        // Skip malformed JSON
      }
    }
    if (matches.length >= limit) break
  }

  if (matches.length === 0) {
    console.log(`No matches found for "${pattern}" in ${filesSearched} session files.`)
    return
  }

  console.log(`Found ${matches.length} matches in ${filesSearched} files:\n`)

  const bySession = groupBy(matches, (m) => m.sessionId)

  for (const [sessionId, sessionMatches] of bySession) {
    const firstMatch = sessionMatches[0]!
    const displayProject = displayProjectPath(firstMatch.sessionFile.split(path.sep)[0] || "")
    const date = firstMatch.timestamp
      ? new Date(firstMatch.timestamp)
          .toISOString()
          .replace("T", " ")
          .replace(/\.\d+Z$/, "Z")
      : "unknown date"

    console.log(
      `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`,
    )
    console.log(`\u{1F4C1} Session: ${sessionId.slice(0, 12)}...  |  Project: ${displayProject}  |  ${date}`)
    console.log(
      `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`,
    )

    for (const match of sessionMatches.slice(0, 5)) {
      const time = match.timestamp ? new Date(match.timestamp).toLocaleTimeString() : ""
      const role =
        match.type === "user" ? "\u{1F464} User" : match.type === "assistant" ? "\u{1F916} Assistant" : match.type

      console.log(`\n${role} (${time}):`)
      console.log("\u2500".repeat(60))
      console.log(highlightMatch(match.context, regex))
    }

    if (sessionMatches.length > 5) {
      console.log(`\n  ... and ${sessionMatches.length - 5} more matches in this session`)
    }
    console.log()
  }

  if (matches.length >= limit) {
    console.log(`\n(showing first ${limit} matches, use -n/--limit for more)`)
  }
}
