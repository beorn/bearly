/**
 * The bg-recall daemon — orchestrates the pipeline, throttle, metrics, log,
 * and explain ring against an injected tribe-send + recall + quality-gate.
 *
 * `createBgRecallDaemon(deps)` returns a handle with:
 *   - .observeToolCall(event)  — feed it an event from the host (PostToolUse
 *                                hook, JSONL tail, etc.) and it Just Works
 *   - .status()                — DaemonStatus snapshot for the CLI
 *   - .explain(hintId)         — the full Decision behind a hint
 *   - .recentHints(limit)      — for `bg-recall watch`
 *   - .stop()                  — graceful shutdown
 *
 * Lifecycle:
 *   - the host wires `observeToolCall` to whichever event source (hook or
 *     JSONL tail) and calls `start()` to arm idle-quit
 *   - idle-quit fires after `idleTimeoutMs` of no events; calls
 *     `onIdleQuit(snapshot)` so the host can log + exit
 *   - `stop()` clears the timer + emits a final status snapshot
 *
 * The daemon NEVER speaks the wire protocol directly — every external effect
 * is a function on `deps`. That keeps the package testable + portable.
 */

import { createPipeline, DEFAULT_PIPELINE_CONFIG, type PipelineConfig } from "./pipeline.ts"
import { createThrottle, DEFAULT_THROTTLE, type ThrottleConfig } from "./throttle.ts"
import { createMetrics, DEFAULT_METRICS_CONFIG, type Metrics, type MetricsConfig } from "./metrics.ts"
import { createExplainRing, type ExplainRing } from "./explain.ts"
import { createLogger, type Logger } from "./log.ts"
import type { DaemonStatus, Decision, Hint, QualityGate, RecallFn, ToolCallEvent, TribeSend } from "./types.ts"

export type BgRecallConfig = {
  /** Per-source recall functions. Required — no defaults. */
  sources: Record<string, RecallFn>
  /** Wire to the tribe daemon's `tribe.send` RPC. */
  tribeSend: TribeSend
  /** Quality gate (compose with @bearly/recall once the gate lands). */
  qualityGate: QualityGate
  /** Idle quit after this many ms of zero activity. Default: 30 min. */
  idleTimeoutMs?: number
  /** Called when the daemon decides to idle-quit. Host should `process.exit(0)`. */
  onIdleQuit?: (status: DaemonStatus) => void
  /** Pipeline tuning — defaults are reasonable. */
  pipeline?: Partial<Omit<PipelineConfig, "sources" | "qualityGate">>
  /** Throttle tuning. */
  throttle?: Partial<ThrottleConfig>
  /** Metrics tuning. */
  metrics?: Partial<MetricsConfig>
  /** Explain ring size. Default: 200. */
  explainRingSize?: number
  /** Override the JSONL log path (else BG_RECALL_DEBUG_LOG env). */
  debugLog?: string | null
}

const DEFAULT_IDLE_MS = 30 * 60 * 1000

export type BgRecallDaemon = {
  observeToolCall(event: ToolCallEvent): Promise<Decision>
  status(): DaemonStatus
  explain(hintId: string): Decision | undefined
  recentHints(limit?: number): Hint[]
  /** For `bg-recall watch` — recent decisions in reverse-chronological order. */
  recentDecisions(limit?: number): Decision[]
  /** Reach into the metrics object — useful when host owns the broadcast. */
  metrics(): Metrics
  /** Reach into the explain ring — useful for tests. */
  explainRing(): ExplainRing
  /** Start arming the idle-quit timer. Idempotent. */
  start(): void
  /** Stop the daemon — clears the timer. */
  stop(): void
  /** True iff the idle timer has fired (host should shut down). */
  isIdle(): boolean
}

export function createBgRecallDaemon(config: BgRecallConfig): BgRecallDaemon {
  const idleTimeoutMs = config.idleTimeoutMs ?? readIdleTimeoutFromEnv() ?? DEFAULT_IDLE_MS

  const logger: Logger = createLogger({ path: config.debugLog ?? undefined })
  const explainRing = createExplainRing(config.explainRingSize ?? 200)
  const throttle = createThrottle({ ...DEFAULT_THROTTLE, ...config.throttle })
  const metrics = createMetrics({ ...DEFAULT_METRICS_CONFIG, ...config.metrics })

  const pipeline = createPipeline({
    ...DEFAULT_PIPELINE_CONFIG,
    ...config.pipeline,
    sources: config.sources,
    qualityGate: config.qualityGate,
  })

  const startedAt = Date.now()
  let lastActivityMs = startedAt
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let idle = false
  let stopped = false

  function armIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer)
    if (stopped) return
    idleTimer = setTimeout(() => {
      idle = true
      logger.log({ kind: "daemon-state", data: { state: "idle", reason: "idle-timeout" } })
      config.onIdleQuit?.(snapshotStatus())
    }, idleTimeoutMs)
  }

  function snapshotStatus(): DaemonStatus {
    const sessions = metrics.snapshot()
    const hints = explainRing.recentHints(10)
    return {
      state: stopped ? "stopped" : idle ? "idle" : "running",
      startedAt,
      lastActivityMs,
      sessions,
      recentHints: hints.map((h) => ({
        id: h.id,
        ts: h.ts,
        to: h.to,
        source: h.source,
        title: h.hit.title,
        adoption: metrics.adoption(h.id) ?? "pending",
      })),
      totals: {
        toolCalls: sessions.reduce((s, x) => s + x.toolCalls, 0),
        queries: explainRing.recent(1000).reduce((s, d) => s + d.queries.length, 0),
        hintsFired: sessions.reduce((s, x) => s + x.hintsFired, 0),
        rejected: explainRing.recent(1000).filter((d) => d.rejected).length,
      },
    }
  }

  return {
    async observeToolCall(event) {
      lastActivityMs = event.ts
      armIdleTimer()
      idle = false

      metrics.recordToolCall(event.sessionId, event.sessionName, event.tool, event.ts)
      throttle.recordToolCall(event.sessionId)

      // Build the decision.
      const decision = await pipeline.processToolCall(event)
      metrics.recordEntities(event.sessionId, decision.entities)

      // Record candidate-level outcomes.
      if (decision.emitted) {
        if (!throttle.allow(event.sessionId, event.ts)) {
          decision.emitted = undefined
          decision.rejected = { reason: "throttle" }
          throttle.recordHighScore(event.sessionId)
        } else {
          // Send the hint.
          try {
            await config.tribeSend(decision.emitted.to, decision.emitted.content, "hint", {
              hintId: decision.emitted.id,
              source: decision.emitted.source,
              hitId: decision.emitted.hit.id,
              score: decision.emitted.hit.score,
            })
            throttle.recordHint(event.sessionId, event.ts)
            throttle.recordHighScore(event.sessionId)
            pipeline.recordEmitted(decision.emitted)
            metrics.recordHint(decision.emitted)
            logger.hint(decision.emitted)
          } catch (err) {
            // Send failed — keep the decision but mark it rejected.
            decision.emitted = undefined
            decision.rejected = { reason: "below-floor", detail: err instanceof Error ? err.message : String(err) }
          }
        }
      } else if (decision.rejected?.reason === "below-threshold") {
        throttle.recordLowScore(event.sessionId)
      }

      explainRing.record(decision)
      logger.decision(decision)
      return decision
    },
    status: snapshotStatus,
    explain(hintId) {
      return explainRing.byHintId(hintId)
    },
    recentHints(limit) {
      return explainRing.recentHints(limit)
    },
    recentDecisions(limit) {
      return explainRing.recent(limit)
    },
    metrics() {
      return metrics
    },
    explainRing() {
      return explainRing
    },
    start() {
      stopped = false
      idle = false
      armIdleTimer()
      logger.log({ kind: "daemon-state", data: { state: "running" } })
    },
    stop() {
      stopped = true
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = null
      logger.log({ kind: "daemon-state", data: { state: "stopped", final: snapshotStatus() } })
    },
    isIdle() {
      return idle
    },
  }
}

function readIdleTimeoutFromEnv(): number | null {
  const raw = process.env.BG_RECALL_IDLE_TIMEOUT_SEC
  if (!raw) return null
  const sec = Number(raw)
  if (!Number.isFinite(sec) || sec <= 0) return null
  return sec * 1000
}
