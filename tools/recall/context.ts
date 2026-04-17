/**
 * context.ts — Build a rich context bundle for the query planner.
 *
 * Feeds the planner project-specific anchors so vague queries like
 * "that time we fixed the column thing" expand to terms that actually
 * appear in the indexed corpus (CardColumn.tsx, md-columns, km-tui, etc.)
 * rather than generic synonyms.
 *
 * Cached by DB mtime — rebuilds only when the session index changes.
 */

import * as fs from "fs"
import { execSync } from "child_process"
import type { Database } from "bun:sqlite"
import { getDb, DB_PATH, getAllSessionTitles } from "../lib/history/db.ts"
import type { ContentType } from "../lib/history/types.ts"
import {
  getCurrentSessionContext,
  renderSessionContextForPlanner,
  type SessionContext,
} from "./session-context.ts"

// ============================================================================
// Types
// ============================================================================

export interface RecentSession {
  id: string
  title: string | null
  firstPrompt: string | null
  summary: string | null
  timestamp: number
  ageLabel: string
}

export interface RecentBead {
  id: string
  title: string
  status: string
}

export interface QueryContext {
  today: string
  cwd: string
  recentSessions: RecentSession[]
  recentBeads: RecentBead[]
  /**
   * Rare/distinctive technical tokens from recent session content.
   * These are the "unique keywords" that make FTS sing — tokens that
   * appear in only a handful of documents (low DF), not common words.
   */
  rareVocabulary: string[]
  scopeEpics: string[]
  recentCommits: string[]
  /**
   * Transcript excerpt of the CURRENT Claude Code session (if one is
   * active). This is the single biggest quality lever for vague queries:
   * "that link thing" makes sense given the last 200 lines of this
   * conversation. Null when invoked outside a session (CI, scripts).
   */
  sessionContext: SessionContext | null
}

// ============================================================================
// Cache
// ============================================================================

interface CacheEntry {
  dbMtime: number
  cwd: string
  context: QueryContext
}

let _cache: CacheEntry | null = null

// ============================================================================
// Build
// ============================================================================

export interface BuildContextOptions {
  cwd?: string
  maxSessions?: number
  maxBeads?: number
  maxVocab?: number
  maxCommits?: number
  /** Force rebuild even if cache is fresh. */
  noCache?: boolean
}

export function buildQueryContext(opts: BuildContextOptions = {}): QueryContext {
  const {
    cwd = process.cwd(),
    maxSessions = 25,
    maxBeads = 80,
    maxVocab = 120,
    maxCommits = 30,
    noCache = false,
  } = opts

  const dbMtime = safeStatMtime(DB_PATH)
  if (!noCache && _cache && _cache.dbMtime === dbMtime && _cache.cwd === cwd) {
    // Project context is cached, but session context changes every exchange
    // — refresh it on every call so the planner always sees the latest tail.
    return { ..._cache.context, sessionContext: getCurrentSessionContext({ cwdOverride: cwd }) }
  }

  const db = getDb()
  const context: QueryContext = {
    today: isoDate(new Date()),
    cwd,
    recentSessions: loadRecentSessions(db, maxSessions),
    recentBeads: loadRecentBeads(db, maxBeads),
    rareVocabulary: [],
    scopeEpics: [],
    recentCommits: loadRecentCommits(cwd, maxCommits),
    // Session context is intentionally NOT cached with the rest — it changes
    // every exchange, so recompute each call. ~50ms cost.
    sessionContext: getCurrentSessionContext({ cwdOverride: cwd }),
  }

  // Scope epics: beads that look like `km-<scope>` (no dot, open status).
  context.scopeEpics = context.recentBeads
    .filter((b) => /^km-[a-z]+$/i.test(b.id))
    .map((b) => `${b.id}: ${b.title}`)
    .slice(0, 20)

  // Rare vocabulary: rebuilt from session content + bead content + commits.
  // This is the big lever for query quality — specific tokens, not generic words.
  context.rareVocabulary = loadRareVocabulary(db, maxVocab)

  _cache = { dbMtime, cwd, context }
  return context
}

// ============================================================================
// Serialization (what actually goes to the planner)
// ============================================================================

/**
 * Render the context bundle as a compact plain-text block for the planner prompt.
 * Soft-budgets to ~10KB. Callers can pass maxChars to override.
 */
export function renderContextPrompt(ctx: QueryContext, opts: { maxChars?: number } = {}): string {
  // Bumped from 10K: session context can contribute ~7KB on top of project
  // context. Haiku's context window is 200K — 20KB is trivial for the model,
  // but costs ~$0.0005 extra per call. Worth it for quality.
  const { maxChars = 18_000 } = opts
  const lines: string[] = []

  lines.push(`Today: ${ctx.today}`)
  lines.push(`Project root: ${ctx.cwd}`)
  lines.push("")

  // Session context FIRST — it's the most load-bearing signal when present.
  // The planner should anchor on "what is the user doing right now" before
  // pulling from the project-level vocabulary.
  if (ctx.sessionContext) {
    lines.push(renderSessionContextForPlanner(ctx.sessionContext))
    lines.push("")
    lines.push("---")
    lines.push("")
  }

  if (ctx.scopeEpics.length > 0) {
    lines.push("Scope epics (active areas of work):")
    for (const e of ctx.scopeEpics) lines.push(`  ${e}`)
    lines.push("")
  }

  if (ctx.recentBeads.length > 0) {
    lines.push("Recent beads (issue IDs + titles):")
    for (const b of ctx.recentBeads.slice(0, 40)) {
      lines.push(`  ${b.id} [${b.status}]: ${b.title}`)
    }
    lines.push("")
  }

  if (ctx.recentSessions.length > 0) {
    lines.push("Recent sessions (most recent first; title + first prompt + summary):")
    for (const s of ctx.recentSessions) {
      const parts: string[] = []
      if (s.title) parts.push(`title: ${s.title}`)
      if (s.firstPrompt) parts.push(`prompt: ${truncate(s.firstPrompt, 200)}`)
      if (s.summary) parts.push(`summary: ${truncate(s.summary, 300)}`)
      lines.push(`  [${s.ageLabel}] ${parts.join(" | ")}`)
    }
    lines.push("")
  }

  if (ctx.rareVocabulary.length > 0) {
    lines.push("Distinctive corpus tokens (rare/specific — prefer these over generic synonyms):")
    lines.push(`  ${ctx.rareVocabulary.join(", ")}`)
    lines.push("")
  }

  if (ctx.recentCommits.length > 0) {
    lines.push("Recent commits:")
    for (const c of ctx.recentCommits) lines.push(`  ${c}`)
    lines.push("")
  }

  let out = lines.join("\n")
  if (out.length > maxChars) {
    out = out.slice(0, maxChars - 40) + "\n[... context truncated ...]\n"
  }
  return out
}

// ============================================================================
// Loaders
// ============================================================================

function loadRecentSessions(db: Database, max: number): RecentSession[] {
  const titles = getAllSessionTitles()
  const now = Date.now()

  // Pull recent sessions by update time. The message_count column isn't
  // reliably populated across older sessions, so we don't filter on it —
  // sessions without content will just show up with null firstPrompt/summary,
  // which is harmless.
  const sessionRows = db
    .prepare(
      `SELECT s.id, s.updated_at, s.message_count
       FROM sessions s
       ORDER BY s.updated_at DESC
       LIMIT ?`,
    )
    .all(max) as { id: string; updated_at: number; message_count: number }[]

  if (sessionRows.length === 0) return []

  const ids = sessionRows.map((r) => r.id)
  const placeholders = ids.map(() => "?").join(",")

  const firstPrompts = new Map<string, string>()
  const summaries = new Map<string, string>()

  try {
    const promptRows = db
      .prepare(
        `SELECT source_id, content FROM content
         WHERE content_type = 'first_prompt' AND source_id IN (${placeholders})`,
      )
      .all(...ids) as { source_id: string; content: string }[]
    for (const r of promptRows) firstPrompts.set(r.source_id, r.content)
  } catch {
    // content table may not exist on older DBs — degrade silently
  }

  try {
    const summaryRows = db
      .prepare(
        `SELECT source_id, content, timestamp FROM content
         WHERE content_type = 'summary' AND source_id IN (${placeholders})
         ORDER BY timestamp DESC`,
      )
      .all(...ids) as { source_id: string; content: string; timestamp: number }[]
    // First (newest) summary per session wins
    for (const r of summaryRows) {
      if (!summaries.has(r.source_id)) summaries.set(r.source_id, r.content)
    }
  } catch {
    /* noop */
  }

  return sessionRows.map((r) => ({
    id: r.id,
    title: titles.get(r.id) ?? null,
    firstPrompt: firstPrompts.get(r.id) ?? null,
    summary: summaries.get(r.id) ?? null,
    timestamp: r.updated_at,
    ageLabel: relativeAge(now - r.updated_at),
  }))
}

function loadRecentBeads(db: Database, max: number): RecentBead[] {
  // Beads are indexed as content_type='bead'. Title lives in content.title,
  // and status is typically embedded in the content body ("STATUS: open").
  try {
    const rows = db
      .prepare(
        `SELECT source_id, title, content, timestamp FROM content
         WHERE content_type = 'bead'
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      .all(max) as { source_id: string; title: string | null; content: string; timestamp: number }[]

    return rows.map((r) => ({
      id: r.source_id,
      title: r.title ?? r.source_id,
      status: extractBeadStatus(r.content),
    }))
  } catch {
    return []
  }
}

function extractBeadStatus(content: string | null): string {
  if (!content) return "unknown"
  const m = content.match(/\b(open|closed|in[_-]?progress|blocked|ready|done)\b/i)
  return m ? m[1]!.toLowerCase() : "unknown"
}

function loadRareVocabulary(db: Database, max: number): string[] {
  // Strategy: pull distinctive tokens from recent content. Prefer tokens that
  // look technical (mixed case, dot-file, hyphenated identifiers, versioned)
  // and that have low document frequency — unique keywords FTS rewards.
  const CORPUS_LIMIT = 300
  const MIN_LEN = 3
  const MAX_DF_FRACTION = 0.25 // token must appear in < 25% of sampled docs

  let rows: { content: string }[] = []
  try {
    // Sample recent content across types — titles for sessions, body for
    // beads/plans/summaries. This captures technical terminology.
    rows = db
      .prepare(
        `SELECT COALESCE(title, '') || ' ' || COALESCE(SUBSTR(content, 1, 1500), '') AS content
         FROM content
         WHERE content_type IN ('first_prompt','summary','bead','plan','session_memory','project_memory','llm_research')
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      .all(CORPUS_LIMIT) as { content: string }[]
  } catch {
    return []
  }

  if (rows.length === 0) return []

  // Tokenize + compute DF
  const df = new Map<string, number>()
  const STOPWORDS = new Set(STOPWORDS_LIST)

  for (const row of rows) {
    const seen = new Set<string>()
    for (const tok of tokenize(row.content)) {
      if (tok.length < MIN_LEN) continue
      if (STOPWORDS.has(tok.toLowerCase())) continue
      if (seen.has(tok)) continue
      seen.add(tok)
      df.set(tok, (df.get(tok) ?? 0) + 1)
    }
  }

  const maxDf = Math.max(2, Math.floor(rows.length * MAX_DF_FRACTION))
  const distinctive: { tok: string; score: number }[] = []
  for (const [tok, count] of df) {
    if (count > maxDf) continue
    if (count < 2) continue // noise — appears in exactly 1 doc, skip unless it's distinctly technical
    const technical = scoreTechnical(tok)
    if (technical === 0 && count < 4) continue // demand either technical-looking OR moderately recurring
    const idfBoost = Math.log(rows.length / count)
    distinctive.push({ tok, score: idfBoost + technical })
  }

  distinctive.sort((a, b) => b.score - a.score)
  return distinctive.slice(0, max).map((d) => d.tok)
}

function loadRecentCommits(cwd: string, max: number): string[] {
  try {
    const out = execSync(`git -C "${cwd}" log --oneline -n ${max}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    })
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

// ============================================================================
// Tokenization
// ============================================================================

// Matches technical-looking tokens:
//   - camelCase, PascalCase
//   - kebab-case, snake_case
//   - paths with dots (CardColumn.tsx, km-tui.v2)
//   - bead-like IDs (km-bearly.recall-llm-agent)
const TOKEN_RE = /[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*/g

function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? []
}

/**
 * Score how "technical" a token looks. Higher = more distinctive.
 * 0 = generic word; 1+ = camelCase / has separators / has numerics
 */
function scoreTechnical(tok: string): number {
  let s = 0
  if (/[A-Z]/.test(tok) && /[a-z]/.test(tok)) s += 1.2 // camelCase / PascalCase
  if (/[._-]/.test(tok)) s += 1.0 // has separator (km-tui, CardColumn.tsx)
  if (/\d/.test(tok)) s += 0.3 // has digit (v2, gpt5)
  if (tok.length >= 10) s += 0.3
  return s
}

// ============================================================================
// Small helpers
// ============================================================================

function safeStatMtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs
  } catch {
    return 0
  }
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + "…"
}

function relativeAge(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 48) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  if (d < 14) return `${d}d ago`
  const w = Math.floor(d / 7)
  return `${w}w ago`
}

// Small, focused stopword list — we want to drop connective words but keep
// anything that looks even mildly domain-specific. Tokenization already
// removes pure-punctuation.
const STOPWORDS_LIST = [
  "the",
  "and",
  "for",
  "you",
  "this",
  "that",
  "with",
  "have",
  "from",
  "they",
  "are",
  "was",
  "were",
  "will",
  "would",
  "could",
  "should",
  "but",
  "not",
  "any",
  "all",
  "can",
  "has",
  "had",
  "its",
  "his",
  "her",
  "one",
  "two",
  "new",
  "now",
  "use",
  "using",
  "used",
  "user",
  "just",
  "only",
  "also",
  "what",
  "when",
  "where",
  "which",
  "who",
  "how",
  "why",
  "more",
  "most",
  "some",
  "into",
  "out",
  "out_of",
  "about",
  "over",
  "under",
  "via",
  "per",
  "etc",
  "you're",
  "you've",
  "there",
  "here",
  "them",
  "their",
  "these",
  "those",
  "then",
  "than",
  "very",
  "much",
  "make",
  "made",
  "does",
  "did",
  "doing",
  "done",
  "run",
  "ran",
  "running",
  "get",
  "got",
  "getting",
  "goes",
  "went",
  "going",
  "see",
  "saw",
  "seen",
  "seeing",
  "like",
  "look",
  "looks",
  "think",
  "thought",
  "need",
  "needs",
  "try",
  "tried",
  "trying",
  "want",
  "wants",
  "say",
  "said",
  "says",
  "let",
  "lets",
  "letting",
  "good",
  "bad",
  "ok",
  "okay",
  "yes",
  "no",
]

// ============================================================================
// Cache control (tests)
// ============================================================================

export function resetContextCache(): void {
  _cache = null
}
