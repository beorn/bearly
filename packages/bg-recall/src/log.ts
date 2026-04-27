/**
 * JSONL debug logger — first-class observability surface (a) from the bead.
 *
 * Format intentionally matches `INJECTION_DEBUG_LOG` (one JSON object per
 * line, ISO timestamp first) so users can `tail -f | jq .` both side-by-side.
 *
 * Lazy file handle: nothing is opened until the first event lands. If the env
 * var isn't set the logger is a no-op — zero allocation per call.
 */

import { appendFileSync } from "node:fs"
import type { Decision, Hint } from "./types.ts"

export type DebugEventKind =
  | "tool-call"
  | "entities-extracted"
  | "recall-query"
  | "candidate-scored"
  | "candidate-rejected"
  | "hint-emitted"
  | "throttle-block"
  | "quality-reject"
  | "decision"
  | "daemon-state"
  | "session-end"

export type DebugEvent = {
  kind: DebugEventKind
  sessionId?: string
  hintId?: string
  /** Free-form payload — schema is per-`kind`. */
  data?: Record<string, unknown>
}

export type Logger = {
  log(event: DebugEvent): void
  /** Convenience helpers for the hot paths so call sites stay tight. */
  decision(d: Decision): void
  hint(h: Hint): void
  /** Force-flush any buffered writes (no-op for sync writes; for symmetry). */
  flush(): void
  /** Close handles. */
  close(): void
}

/**
 * Create a logger backed by `BG_RECALL_DEBUG_LOG` env var (or the explicit
 * path). When neither is set the returned logger is a silent no-op — and
 * `log()` early-returns before allocating the JSON envelope.
 */
export function createLogger(opts?: { path?: string; envVar?: string }): Logger {
  const envVar = opts?.envVar ?? "BG_RECALL_DEBUG_LOG"
  const path = opts?.path ?? process.env[envVar] ?? null

  if (!path) {
    return {
      log() {},
      decision() {},
      hint() {},
      flush() {},
      close() {},
    }
  }

  const write = (envelope: Record<string, unknown>): void => {
    try {
      appendFileSync(path, JSON.stringify(envelope) + "\n")
    } catch {
      // A broken log MUST NOT break the daemon.
    }
  }

  return {
    log(event) {
      write({ ts: new Date().toISOString(), ...event })
    },
    decision(d) {
      write({
        ts: new Date(d.ts).toISOString(),
        kind: "decision",
        sessionId: d.sessionId,
        data: {
          tool: d.trigger.tool,
          entities: d.entities,
          queries: d.queries.map((q) => ({ source: q.source, query: q.query, hits: q.hits.length })),
          candidates: d.candidates
            .slice(0, 3)
            .map((c) => ({ id: c.hit.id, score: c.score, reject: c.rejectReason })),
          emitted: d.emitted ? { id: d.emitted.id, to: d.emitted.to, source: d.emitted.source } : null,
          rejected: d.rejected ?? null,
        },
      })
    },
    hint(h) {
      write({
        ts: new Date(h.ts).toISOString(),
        kind: "hint-emitted",
        hintId: h.id,
        sessionId: h.to,
        data: {
          source: h.source,
          to: h.to,
          content: h.content,
          triggerEntities: h.triggerEntities,
          score: h.hit.score,
          components: h.hit.components,
          candidates: h.candidates,
        },
      })
    },
    flush() {},
    close() {},
  }
}
