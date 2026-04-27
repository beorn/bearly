/**
 * Explain ring — bounded in-memory store of recent Decisions, indexed by
 * hint id. Backs `bun bg-recall explain <hint-id>`.
 *
 * The JSONL log is the durable answer; the ring exists so a CLI lookup
 * doesn't have to parse a possibly-huge log file.
 */

import type { Decision, Hint } from "./types.ts"

const DEFAULT_MAX = 200

export type ExplainRing = {
  record(decision: Decision): void
  /** Look up the full decision by hint id. */
  byHintId(id: string): Decision | undefined
  /** Recent decisions (newest first), capped at `limit`. */
  recent(limit?: number): Decision[]
  /** Recent hints (newest first), capped at `limit`. */
  recentHints(limit?: number): Hint[]
}

export function createExplainRing(maxEntries: number = DEFAULT_MAX): ExplainRing {
  const entries: Decision[] = []
  const indexById = new Map<string, Decision>()

  return {
    record(decision) {
      entries.unshift(decision)
      if (decision.emitted) indexById.set(decision.emitted.id, decision)
      while (entries.length > maxEntries) {
        const dropped = entries.pop()!
        if (dropped.emitted) indexById.delete(dropped.emitted.id)
      }
    },
    byHintId(id) {
      return indexById.get(id)
    },
    recent(limit = 50) {
      return entries.slice(0, limit)
    },
    recentHints(limit = 50) {
      const hints: Hint[] = []
      for (const e of entries) {
        if (e.emitted) hints.push(e.emitted)
        if (hints.length >= limit) break
      }
      return hints
    },
  }
}
