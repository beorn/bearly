/**
 * Per-session metrics — backs the `bg-recall status` command and the
 * end-of-session tribe broadcast.
 *
 * Adoption tracking: a hint is "adopted" if the model calls retrieve_memory
 * within N (default 5) turns. The PostToolUse listener feeds us tool-call
 * events; if a `retrieve_memory` arrives soon enough after a hint, we mark it
 * adopted. Otherwise it ages out into "ignored".
 */

import type { AdoptionStatus, Hint, SessionMetrics } from "./types.ts"

export type MetricsConfig = {
  /** How many tool calls after a hint before it's considered "ignored". */
  adoptionWindowCalls: number
  /** Cap on the per-session entity-window size (top-N kept). */
  topEntities: number
}

export const DEFAULT_METRICS_CONFIG: MetricsConfig = {
  adoptionWindowCalls: 5,
  topEntities: 20,
}

type PendingHint = {
  hint: Hint
  callsRemaining: number
  status: AdoptionStatus
}

type SessionState = {
  sessionName: string
  toolCalls: number
  hintsFired: number
  hintsAdopted: number
  hintsIgnored: number
  lastActivityMs: number
  entityCounts: Map<string, number>
  pending: PendingHint[]
}

export type Metrics = {
  recordToolCall(sessionId: string, sessionName: string, tool: string, ts: number): void
  recordEntities(sessionId: string, entities: string[]): void
  recordHint(hint: Hint): void
  /** Returns adoption status for a given hint id (or undefined if unknown). */
  adoption(hintId: string): AdoptionStatus | undefined
  snapshot(): SessionMetrics[]
  forSession(sessionId: string): SessionMetrics | undefined
  /** Drop a session from tracking — used when the session disconnects. */
  drop(sessionId: string): SessionMetrics | undefined
}

export function createMetrics(config: MetricsConfig = DEFAULT_METRICS_CONFIG): Metrics {
  const sessions = new Map<string, SessionState>()
  const hintIndex = new Map<string, { sessionId: string; pending: PendingHint }>()

  function ensure(sessionId: string, sessionName: string): SessionState {
    let s = sessions.get(sessionId)
    if (!s) {
      s = {
        sessionName,
        toolCalls: 0,
        hintsFired: 0,
        hintsAdopted: 0,
        hintsIgnored: 0,
        lastActivityMs: 0,
        entityCounts: new Map(),
        pending: [],
      }
      sessions.set(sessionId, s)
    }
    if (sessionName) s.sessionName = sessionName
    return s
  }

  function topEntities(s: SessionState): Array<{ entity: string; count: number }> {
    return [...s.entityCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, config.topEntities)
      .map(([entity, count]) => ({ entity, count }))
  }

  function snapshotOne(sessionId: string, s: SessionState): SessionMetrics {
    return {
      sessionId,
      sessionName: s.sessionName,
      toolCalls: s.toolCalls,
      hintsFired: s.hintsFired,
      hintsAdopted: s.hintsAdopted,
      hintsIgnored: s.hintsIgnored,
      lastActivityMs: s.lastActivityMs,
      topEntities: topEntities(s),
    }
  }

  return {
    recordToolCall(sessionId, sessionName, tool, ts) {
      const s = ensure(sessionId, sessionName)
      s.toolCalls += 1
      s.lastActivityMs = ts

      // Decrement adoption windows + classify retrieve_memory as an adoption.
      const isAdoptionTool = tool === "retrieve_memory" || tool === "mcp__retrieve_memory"
      for (const p of s.pending) {
        if (p.status !== "pending") continue
        if (isAdoptionTool) {
          p.status = "adopted"
          s.hintsAdopted += 1
        } else {
          p.callsRemaining -= 1
          if (p.callsRemaining <= 0) {
            p.status = "ignored"
            s.hintsIgnored += 1
          }
        }
      }
      s.pending = s.pending.filter((p) => p.status === "pending")
    },
    recordEntities(sessionId, entities) {
      const s = sessions.get(sessionId)
      if (!s) return
      for (const e of entities) {
        s.entityCounts.set(e, (s.entityCounts.get(e) ?? 0) + 1)
      }
      // Cap entity-counts map to avoid unbounded growth on long sessions.
      if (s.entityCounts.size > config.topEntities * 4) {
        const trimmed = topEntities(s)
        s.entityCounts.clear()
        for (const e of trimmed) s.entityCounts.set(e.entity, e.count)
      }
    },
    recordHint(hint) {
      const s = ensure(hint.sessionId, hint.to)
      s.hintsFired += 1
      const pending: PendingHint = {
        hint,
        callsRemaining: config.adoptionWindowCalls,
        status: "pending",
      }
      s.pending.push(pending)
      hintIndex.set(hint.id, { sessionId: hint.sessionId, pending })
    },
    adoption(hintId) {
      return hintIndex.get(hintId)?.pending.status
    },
    snapshot() {
      return [...sessions.entries()].map(([id, s]) => snapshotOne(id, s))
    },
    forSession(sessionId) {
      const s = sessions.get(sessionId)
      return s ? snapshotOne(sessionId, s) : undefined
    },
    drop(sessionId) {
      const s = sessions.get(sessionId)
      if (!s) return undefined
      const snap = snapshotOne(sessionId, s)
      sessions.delete(sessionId)
      return snap
    },
  }
}
