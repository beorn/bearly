/**
 * The hot path — `processToolCall(event)` returns a Decision describing
 * what (if anything) to send.
 *
 * Discrete stages (each observable separately):
 *
 *   1. extract entities from the tool call
 *   2. (if entities) build a query string + run recall against each source
 *   3. quality-gate every hit before scoring
 *   4. score + threshold the survivors
 *   5. throttle check
 *   6. dedup against recent hints
 *   7. construct the hint envelope (sanitized + reported-speech rewritten)
 *
 * Pure: no socket I/O, no fs writes — the caller (daemon.ts) is in charge of
 * sending the hint and writing logs. This separation lets `processToolCall`
 * be unit-tested with stub functions.
 */

import { randomUUID } from "node:crypto"
import { entitiesFromToolCall } from "./entities.ts"
import { rankHits } from "./relevance.ts"
import { sanitizeForChannel } from "./sanitize.ts"
import type {
  Decision,
  Hint,
  QualityGate,
  RecallFn,
  RecallHit,
  RecallQueryResult,
  ScoredHit,
  ToolCallEvent,
} from "./types.ts"

export type PipelineConfig = {
  /** Per-source recall functions. */
  sources: Record<string, RecallFn>
  /** Per-source thresholds (0..1). Hits below this floor are silently rejected. */
  thresholds: Record<string, number>
  /** Quality gate (composes with the recall-quality-gate library). */
  qualityGate: QualityGate
  /** How many hits to ask each source for. */
  perSourceLimit: number
  /** How many recent hints to remember for dedup (default 50). */
  dedupWindow: number
  /** How many entities to keep in the rolling window per session (default 50). */
  windowSize: number
  /** Recency `since` window for queries (default "7d"). */
  recallSince: string
}

export const DEFAULT_PIPELINE_CONFIG: Omit<PipelineConfig, "sources" | "qualityGate"> = {
  thresholds: { bearly: 0.45, qmd: 0.5 },
  perSourceLimit: 5,
  dedupWindow: 50,
  windowSize: 50,
  recallSince: "7d",
}

export type Pipeline = {
  /** Process one tool-call event end-to-end. Pure — returns a Decision. */
  processToolCall(event: ToolCallEvent): Promise<Decision>
  /** Throttle / dedup advisory: did this session just emit a hint? */
  recordEmitted(hint: Hint): void
  /** Window inspector — useful for status. */
  windowFor(sessionId: string): string[]
}

export function createPipeline(config: PipelineConfig): Pipeline {
  const recentHintIds = new Map<string, { at: number; hit: string }>() // hint-id → metadata for dedup
  const recentHitsBySession = new Map<string, Set<string>>() // sessionId → seen hit ids
  const windowBySession = new Map<string, string[]>() // sessionId → rolling entity window

  function pushWindow(sessionId: string, entities: string[]): string[] {
    let win = windowBySession.get(sessionId)
    if (!win) {
      win = []
      windowBySession.set(sessionId, win)
    }
    for (const e of entities) {
      const idx = win.indexOf(e)
      if (idx >= 0) win.splice(idx, 1)
      win.unshift(e)
    }
    if (win.length > config.windowSize) win.length = config.windowSize
    return win
  }

  function rememberSeen(sessionId: string, hitId: string): void {
    let seen = recentHitsBySession.get(sessionId)
    if (!seen) {
      seen = new Set()
      recentHitsBySession.set(sessionId, seen)
    }
    seen.add(hitId)
    // Cap memory — drop oldest by re-creating set when too large.
    if (seen.size > config.dedupWindow * 4) {
      const arr = [...seen].slice(-config.dedupWindow)
      recentHitsBySession.set(sessionId, new Set(arr))
    }
  }

  function alreadySeen(sessionId: string, hitId: string): boolean {
    return recentHitsBySession.get(sessionId)?.has(hitId) ?? false
  }

  return {
    async processToolCall(event) {
      const baseDecision: Decision = {
        ts: event.ts,
        sessionId: event.sessionId,
        trigger: event,
        entities: [],
        queries: [],
        candidates: [],
      }

      const entities = entitiesFromToolCall(event)
      baseDecision.entities = entities
      const window = pushWindow(event.sessionId, entities)

      if (entities.length === 0) {
        baseDecision.rejected = { reason: "no-entities" }
        return baseDecision
      }

      // Build query string from highest-signal entities first (by simple
      // length heuristic — paths/sigils are typically longer than long words).
      const query = entities
        .slice()
        .sort((a, b) => b.length - a.length)
        .slice(0, 5)
        .join(" ")

      const queries: RecallQueryResult[] = []
      for (const [source, fn] of Object.entries(config.sources)) {
        try {
          const result = await fn(query, { since: config.recallSince, limit: config.perSourceLimit })
          queries.push(result)
        } catch (err) {
          queries.push({
            source,
            query,
            hits: [],
            durationMs: 0,
          })
          // Quietly ignore source errors — they don't block other sources.
          // The caller's logger already records the empty result.
          void err
        }
      }
      baseDecision.queries = queries

      const allHits: RecallHit[] = []
      for (const q of queries) {
        for (const h of q.hits) {
          if (alreadySeen(event.sessionId, h.id)) continue
          // Quality gate runs BEFORE scoring so corrupted docs don't burn
          // entity-overlap budget. See km-tribe.recall-quality-gate.
          if (!config.qualityGate.isAcceptable(h.snippet)) {
            baseDecision.candidates.push({
              hit: h,
              score: 0,
              rejectReason: "quality-gate",
            })
            continue
          }
          allHits.push(h)
        }
      }

      if (allHits.length === 0 && baseDecision.candidates.length === 0) {
        baseDecision.rejected = { reason: "no-hits" }
        return baseDecision
      }

      // Score-then-threshold: build per-source scored slices so we can apply
      // per-source thresholds.
      const scored: ScoredHit[] = []
      for (const q of queries) {
        const threshold = config.thresholds[q.source] ?? 0.5
        const surviving = q.hits
          .filter((h) => allHits.includes(h))
          .map((h) => ({
            ...rankHits([h], { windowEntities: window, threshold: 0 })[0]!,
            source: h.source,
          }))
          .filter((h) => h.score >= threshold)
        scored.push(...surviving)
      }

      // Record EVERY scored hit (above and below threshold) into candidates
      // — the explain trace wants the full picture.
      for (const q of queries) {
        for (const h of q.hits) {
          if (alreadySeen(event.sessionId, h.id)) continue
          if (!config.qualityGate.isAcceptable(h.snippet)) continue
          const ranked = rankHits([h], { windowEntities: window, threshold: 0 })[0]
          if (!ranked) continue
          const threshold = config.thresholds[q.source] ?? 0.5
          baseDecision.candidates.push({
            hit: h,
            score: ranked.score,
            rejectReason: ranked.score < threshold ? "below-threshold" : undefined,
          })
        }
      }
      baseDecision.candidates.sort((a, b) => b.score - a.score)

      const winner = scored.sort((a, b) => b.score - a.score)[0]
      if (!winner) {
        baseDecision.rejected = { reason: "below-threshold" }
        return baseDecision
      }

      // Build the hint envelope.
      const hint: Hint = {
        id: randomUUID(),
        ts: event.ts,
        sessionId: event.sessionId,
        to: event.sessionName,
        source: winner.source,
        content: buildHintContent(winner),
        hit: winner,
        triggerEntities: entities,
        candidates: baseDecision.candidates.slice(0, 3).map((c) => ({
          id: c.hit.id,
          source: c.hit.source,
          score: c.score,
          rejectReason: c.rejectReason,
        })),
      }
      baseDecision.emitted = hint
      return baseDecision
    },
    recordEmitted(hint) {
      recentHintIds.set(hint.id, { at: hint.ts, hit: hint.hit.id })
      rememberSeen(hint.to, hint.hit.id)
      // Bound recentHintIds.
      if (recentHintIds.size > config.dedupWindow * 4) {
        const arr = [...recentHintIds.entries()].slice(-config.dedupWindow)
        recentHintIds.clear()
        for (const [k, v] of arr) recentHintIds.set(k, v)
      }
    },
    windowFor(sessionId) {
      return [...(windowBySession.get(sessionId) ?? [])]
    },
  }
}

/**
 * Build the user-facing channel content. The pointer is intentional:
 * surface a retrieval handle, not the body, so the model has to opt-in via
 * `retrieve_memory(<id>)`. Matches the pointer-mode default in
 * `@bearly/recall` post-phase-3.
 */
function buildHintContent(hit: ScoredHit): string {
  const title = sanitizeForChannel(hit.title, 100)
  const summary = sanitizeForChannel(hit.snippet, 200)
  return `prior session — ${title}. retrieve_memory("${hit.id}") for full content. (${summary})`
}
