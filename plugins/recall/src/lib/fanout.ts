/**
 * fanout.ts — parallel FTS fan-out + coverage rerank.
 *
 * Takes a list of FTS query variants, runs each against the messages, session
 * content, and project content tables, and merges the results. The core
 * quality lever is coverage reranking: a doc that matches N/M variants beats
 * a doc that matches 1/M even if the single-match BM25 is slightly better.
 */

import type { Database } from "bun:sqlite"
import {
  ftsSearchWithSnippet,
  searchAll,
  getAllSessionTitles,
  type MessageSearchOptions,
  type ContentSearchOptions,
} from "../history/db.ts"
import type { ContentType } from "../history/types.ts"
import type { RecallSearchResult } from "../history/recall-shared.ts"
import { boostedRank } from "../history/search.ts"

// ============================================================================
// Types
// ============================================================================

export interface FanoutOptions {
  limit: number
  sinceTime?: number
  projectFilter?: string
  snippetTokens?: number
  /** Per-variant fetch cap. Larger = more coverage signal, but slower. */
  perVariantLimit?: number
}

export interface FanoutResult {
  variants: string[]
  results: RecallSearchResult[]
  /** doc-key → number of variants that hit this doc */
  hitCounts: Map<string, number>
  /** variant → set of doc keys that matched */
  variantHits: Map<string, string[]>
  stats: FanoutStats
}

export interface FanoutStats {
  totalQueries: number
  rawHits: number
  uniqueDocs: number
  topCoverage: number
  medianCoverage: number
  msTotal: number
}

// ============================================================================
// Constants
// ============================================================================

const SESSION_CONTENT_TYPES: ContentType[] = ["plan", "summary", "todo", "first_prompt"]
const PROJECT_CONTENT_TYPES: ContentType[] = [
  "bead",
  "session_memory",
  "project_memory",
  "doc",
  "claude_md",
  "llm_research",
]

// ============================================================================
// Public API
// ============================================================================

/**
 * Run a list of FTS variants against the indexed corpus and merge results
 * with coverage reranking.
 *
 * Note: bun:sqlite is synchronous, so the "fan out" here is sequential FTS5
 * calls within a single event-loop turn. Each FTS call is <5ms on a warm DB;
 * 60 calls is ~300ms. The LLM planner, not fan-out, is the latency floor.
 */
export function fanoutSearch(db: Database, variants: string[], opts: FanoutOptions): FanoutResult {
  const startedAt = Date.now()
  const {
    limit,
    sinceTime,
    projectFilter,
    snippetTokens = 200,
    perVariantLimit = Math.max(5, Math.ceil(limit / 2)),
  } = opts

  const sessionTitles = getAllSessionTitles()

  // doc-key → aggregated record. doc-key is `${type}:${sessionId}` to match
  // the existing dedup convention in lib/history/search.ts.
  const docs = new Map<string, AggregatedDoc>()
  const hitCounts = new Map<string, number>()
  const variantHits = new Map<string, string[]>()
  let totalQueries = 0
  let rawHits = 0

  const msgOpts: MessageSearchOptions = {
    limit: perVariantLimit,
    sinceTime,
    projectFilter,
    snippetTokens,
  }
  const sessionContentOpts: ContentSearchOptions = {
    limit: perVariantLimit,
    sinceTime,
    projectFilter,
    snippetTokens,
    types: SESSION_CONTENT_TYPES,
  }
  const projectContentOpts: ContentSearchOptions = {
    limit: perVariantLimit,
    projectFilter,
    snippetTokens,
    types: PROJECT_CONTENT_TYPES,
  }

  for (const variant of variants) {
    // Dedupe doc keys WITHIN this variant — coverage means "how many distinct
    // variants found this doc", not "how many rows matched". Multiple messages
    // from the same session matching one variant is still just 1 coverage hit.
    const variantSeen = new Set<string>()
    const ingest = (
      key: string,
      entry: Omit<AggregatedDoc, "bestRank" | "bestSnippet"> & { rank: number; snippet: string },
    ) => {
      // Always update the aggregated doc (best rank / snippet across all hits)
      updateDoc(docs, key, entry)
      // But only count coverage once per variant
      if (!variantSeen.has(key)) {
        variantSeen.add(key)
        hitCounts.set(key, (hitCounts.get(key) ?? 0) + 1)
      }
    }

    // Messages
    try {
      const res = ftsSearchWithSnippet(db, variant, msgOpts)
      totalQueries++
      rawHits += res.results.length
      for (const r of res.results) {
        ingest(`message:${r.session_id}`, {
          type: "message",
          sessionId: r.session_id,
          sessionTitle: sessionTitles.get(r.session_id) ?? null,
          timestamp: Number(r.timestamp),
          snippet: r.snippet || (r.content?.slice(0, 500) ?? ""),
          rank: r.rank,
        })
      }
    } catch {
      // FTS5 can reject some queries (special chars). Skip rather than crash.
    }

    // Session-scoped content
    try {
      const res = searchAll(db, variant, sessionContentOpts)
      totalQueries++
      rawHits += res.results.length
      for (const r of res.results) {
        const docType = r.content_type as RecallSearchResult["type"]
        ingest(`${docType}:${r.source_id}`, {
          type: docType,
          sessionId: r.source_id,
          sessionTitle: r.title ?? sessionTitles.get(r.source_id) ?? null,
          timestamp: Number(r.timestamp),
          snippet: r.snippet || r.content.slice(0, 500),
          rank: r.rank,
        })
      }
    } catch {
      /* skip */
    }

    // Project knowledge (no time filter)
    try {
      const res = searchAll(db, variant, projectContentOpts)
      totalQueries++
      rawHits += res.results.length
      for (const r of res.results) {
        const docType = r.content_type as RecallSearchResult["type"]
        ingest(`${docType}:${r.source_id}`, {
          type: docType,
          sessionId: r.source_id,
          sessionTitle: r.title ?? sessionTitles.get(r.source_id) ?? null,
          timestamp: Number(r.timestamp),
          snippet: r.snippet || r.content.slice(0, 500),
          rank: r.rank,
        })
      }
    } catch {
      /* skip */
    }

    variantHits.set(variant, [...variantSeen])
  }

  // Coverage-first rerank: multi-variant hits dominate single-variant hits
  // unconditionally. This is the core agent-mode opinion — breadth of match
  // (query found this doc from multiple angles) is a stronger signal than
  // single-term density. BM25 (recency-boosted) only breaks ties within a
  // coverage tier.
  const scored: ScoredDoc[] = []
  for (const [key, agg] of docs) {
    const hits = hitCounts.get(key) ?? 1
    const finalRank = boostedRank(agg.bestRank, agg.timestamp)
    scored.push({ key, agg, hits, finalRank })
  }

  scored.sort((a, b) => {
    // Primary: coverage descending (more variant hits first)
    if (a.hits !== b.hits) return b.hits - a.hits
    // Tiebreaker: recency-boosted BM25 ascending (more negative = better)
    return a.finalRank - b.finalRank
  })

  const results: RecallSearchResult[] = []
  for (const s of scored) {
    if (results.length >= limit) break
    results.push({
      type: s.agg.type,
      sessionId: s.agg.sessionId,
      sessionTitle: s.agg.sessionTitle,
      timestamp: s.agg.timestamp,
      snippet: s.agg.bestSnippet,
      rank: s.finalRank,
    })
  }

  // Stats
  const coverages = [...hitCounts.values()].sort((a, b) => b - a)
  const topCoverage = coverages[0] ?? 0
  const medianCoverage = coverages.length > 0 ? coverages[Math.floor(coverages.length / 2)]! : 0

  return {
    variants,
    results,
    hitCounts,
    variantHits,
    stats: {
      totalQueries,
      rawHits,
      uniqueDocs: docs.size,
      topCoverage,
      medianCoverage,
      msTotal: Date.now() - startedAt,
    },
  }
}

/**
 * Merge two fan-out rounds into a single reranked result set.
 * Coverage counts sum across rounds, BM25 ranks take the best per doc.
 */
export function mergeFanouts(a: FanoutResult, b: FanoutResult, limit: number): FanoutResult {
  const docs = new Map<string, AggregatedDoc>()
  const hitCounts = new Map<string, number>()
  const variantHits = new Map<string, string[]>()

  const ingest = (r: FanoutResult) => {
    for (const variant of r.variants) {
      const prior = variantHits.get(variant) ?? []
      const next = r.variantHits.get(variant) ?? []
      variantHits.set(variant, [...new Set([...prior, ...next])])
    }
    for (const [key, count] of r.hitCounts) {
      hitCounts.set(key, (hitCounts.get(key) ?? 0) + count)
    }
    // Ingest aggregated docs (best rank wins)
    for (const res of r.results) {
      const key = `${res.type}:${res.sessionId}`
      const existing = docs.get(key)
      if (!existing || res.rank < existing.bestRank) {
        docs.set(key, {
          type: res.type,
          sessionId: res.sessionId,
          sessionTitle: res.sessionTitle,
          timestamp: res.timestamp,
          bestRank: res.rank,
          bestSnippet: res.snippet,
        })
      }
    }
  }
  ingest(a)
  ingest(b)

  // Same coverage-first rerank as fanoutSearch, with combined cross-round hit counts
  const scored: ScoredDoc[] = []
  for (const [key, agg] of docs) {
    const hits = hitCounts.get(key) ?? 1
    const finalRank = boostedRank(agg.bestRank, agg.timestamp)
    scored.push({ key, agg, hits, finalRank })
  }
  scored.sort((x, y) => {
    if (x.hits !== y.hits) return y.hits - x.hits
    return x.finalRank - y.finalRank
  })

  const results: RecallSearchResult[] = []
  for (const s of scored) {
    if (results.length >= limit) break
    results.push({
      type: s.agg.type,
      sessionId: s.agg.sessionId,
      sessionTitle: s.agg.sessionTitle,
      timestamp: s.agg.timestamp,
      snippet: s.agg.bestSnippet,
      rank: s.finalRank,
    })
  }

  const coverages = [...hitCounts.values()].sort((x, y) => y - x)
  const topCoverage = coverages[0] ?? 0
  const medianCoverage = coverages.length > 0 ? coverages[Math.floor(coverages.length / 2)]! : 0

  return {
    variants: [...new Set([...a.variants, ...b.variants])],
    results,
    hitCounts,
    variantHits,
    stats: {
      totalQueries: a.stats.totalQueries + b.stats.totalQueries,
      rawHits: a.stats.rawHits + b.stats.rawHits,
      uniqueDocs: docs.size,
      topCoverage,
      medianCoverage,
      msTotal: a.stats.msTotal + b.stats.msTotal,
    },
  }
}

// ============================================================================
// Internals
// ============================================================================

interface AggregatedDoc {
  type: RecallSearchResult["type"]
  sessionId: string
  sessionTitle: string | null
  timestamp: number
  bestRank: number
  bestSnippet: string
}

interface ScoredDoc {
  key: string
  agg: AggregatedDoc
  hits: number
  finalRank: number
}

function updateDoc(
  docs: Map<string, AggregatedDoc>,
  key: string,
  incoming: Omit<AggregatedDoc, "bestRank" | "bestSnippet"> & { rank: number; snippet: string },
): void {
  const existing = docs.get(key)
  if (!existing || incoming.rank < existing.bestRank) {
    docs.set(key, {
      type: incoming.type,
      sessionId: incoming.sessionId,
      sessionTitle: incoming.sessionTitle,
      timestamp: incoming.timestamp,
      bestRank: incoming.rank,
      bestSnippet: incoming.snippet,
    })
  }
}
