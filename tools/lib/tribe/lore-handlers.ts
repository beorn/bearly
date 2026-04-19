/**
 * Lore RPC handlers, wrapped for use inside the unified tribe daemon.
 *
 * Phase 5a of km-bear.unified-daemon: the standalone lore daemon is being
 * absorbed into the tribe daemon so there's one process per user for both
 * coordination (tribe.send/broadcast/members) and memory (tribe.ask/brief/
 * session/workspace/inject_delta).
 *
 * This module keeps the lore library code exactly where it was (in
 * `plugins/tribe/lore/lib/*.ts` and `plugins/recall/src/lib/*.ts`) and
 * exposes a factory that the tribe daemon wires up inside its JSON-RPC
 * dispatcher. Conceptually identical to the standalone daemon — two DB
 * files, one process.
 *
 * Lifecycle: `createLoreHandlers({ dbPath, ... })` opens the lore database,
 * starts the focus poller + summarizer poller + janitor, and returns
 * `{ dispatch, setConnSession, dropConn, close }`. The tribe daemon calls
 * `dispatch` from its `handleRequest` when it sees a `tribe.*` method name
 * from the lore wire protocol, and calls `dropConn` on socket close so the
 * per-session inject-dedup store is GC-able.
 */

import { createLogger } from "loggily"
import {
  createLoreRepo,
  openLoreDatabase,
  sessionRowToInfo,
  type LoreRepo,
  type SessionRow,
} from "../../../plugins/tribe/lore/lib/database.ts"
import {
  TRIBE_METHODS,
  LORE_ERRORS,
  LORE_PROTOCOL_VERSION,
  type AskParams,
  type AskResult,
  type CurrentBriefParams,
  type CurrentBriefResult,
  type HelloParams,
  type HelloResult,
  type InjectDeltaParams,
  type InjectDeltaResult,
  type PlanOnlyParams,
  type PlanOnlyResult,
  type SessionFocusSummary,
  type SessionHeartbeatParams,
  type SessionHeartbeatResult,
  type SessionRegisterParams,
  type SessionRegisterResult,
  type SessionStateParams,
  type SessionStateResult,
  type SessionsListResult,
  type StatusResult,
  type WorkspaceStateResult,
} from "../../../plugins/tribe/lore/lib/rpc.ts"
import {
  resolveSummarizerMode,
  summarizeTail,
  type SummarizerMode,
} from "../../../plugins/tribe/lore/lib/summarizer.ts"
import { recallAgent } from "../../../plugins/recall/src/lib/agent.ts"
import { planQuery, planVariants } from "../../../plugins/recall/src/lib/plan.ts"
import { buildQueryContext } from "../../../plugins/recall/src/lib/context.ts"
import { getCurrentSessionContext, extractSessionFocus } from "../../../plugins/recall/src/lib/session-context.ts"
import { setRecallLogging } from "../../../plugins/recall/src/history/recall-shared.ts"
import { createMemorySeenStore, runInjectDelta, type SeenStore } from "../../../plugins/recall/src/lib/inject-core.ts"

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type LoreConnState = {
  /** Lore session id — set via tribe.session_register or carried over from hello. */
  sessionId: string | null
  claudePid: number | null
}

export type LoreHandlers = {
  /** Return true iff the method name belongs to the lore wire protocol. */
  isLoreMethod(method: string): boolean
  /** Dispatch a lore RPC. Returns the plain result (not a JSON-RPC envelope) or throws. */
  dispatch(conn: LoreConnState, method: string, params: Record<string, unknown>): Promise<unknown>
  /** Drop per-connection state (inject-dedup) when the socket closes. */
  dropConn(sessionId: string | null): void
  /** Shut down pollers + close the lore db. Idempotent. */
  close(): Promise<void>
  /** Exposed for status/diagnostics. */
  readonly dbPath: string
  readonly startedAt: number
  readonly daemonVersion: string
}

export type LoreHandlerOpts = {
  dbPath: string
  socketPath: string
  daemonVersion: string
  focusPollMs?: number
  summaryPollMs?: number
  summarizerMode?: SummarizerMode
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const LORE_METHOD_SET = new Set<string>(Object.values(TRIBE_METHODS))

export function createLoreHandlers(opts: LoreHandlerOpts): LoreHandlers {
  const log = createLogger("tribe:lore")
  setRecallLogging(process.env.TRIBE_LOG === "1")

  const db = openLoreDatabase(opts.dbPath)
  const repo: LoreRepo = createLoreRepo(db)
  const startedAt = Date.now()

  const focusPollMs = Math.max(100, opts.focusPollMs ?? 60_000)
  const summaryPollMs = Math.max(500, opts.summaryPollMs ?? 120_000)
  const summarizerMode: SummarizerMode = opts.summarizerMode ?? "off"
  const daemonVersion = opts.daemonVersion

  // Per-session dedup state for lore.inject_delta
  const injectStores = new Map<string, SeenStore>()
  const injectStoreFor = (sessionId: string): SeenStore => {
    let store = injectStores.get(sessionId)
    if (!store) {
      store = createMemorySeenStore()
      injectStores.set(sessionId, store)
    }
    return store
  }

  // ---------------------------------------------------------------------------
  // Handlers (ported verbatim from plugins/tribe/lore/daemon.ts)
  // ---------------------------------------------------------------------------

  async function handleHello(_conn: LoreConnState, params: HelloParams): Promise<HelloResult> {
    if (params.protocolVersion !== LORE_PROTOCOL_VERSION) {
      throw new Error(
        `protocol version mismatch: client ${params.clientName} speaks v${params.protocolVersion}, daemon speaks v${LORE_PROTOCOL_VERSION}`,
      )
    }
    return {
      protocolVersion: LORE_PROTOCOL_VERSION,
      daemonVersion,
      daemonPid: process.pid,
      startedAt,
    }
  }

  async function handleAsk(_conn: LoreConnState, params: AskParams): Promise<AskResult> {
    const result = await recallAgent(params.query, {
      limit: params.limit,
      since: params.since,
      projectFilter: params.projectFilter,
      round2: params.round2,
      maxRounds: params.maxRounds,
      speculativeSynth: params.speculativeSynth,
    })
    return {
      query: result.query,
      answer: result.synthesis,
      results: result.results.map((r) => ({
        type: String(r.type),
        sessionId: r.sessionId,
        sessionTitle: r.sessionTitle,
        timestamp: r.timestamp,
        snippet: r.snippet,
      })),
      durationMs: result.durationMs,
      cost: result.llmCost ?? 0,
      synthPath: result.trace?.synthPath ?? "no-synth",
      synthCallsUsed: result.trace?.synthCallsUsed ?? 0,
      fellThrough: result.fellThrough ?? false,
      trace: params.rawTrace ? (result.trace as unknown as Record<string, unknown>) : undefined,
    }
  }

  async function handleCurrentBrief(conn: LoreConnState, params: CurrentBriefParams): Promise<CurrentBriefResult> {
    const override = params.sessionIdOverride ?? conn.sessionId ?? undefined

    const CACHE_FRESH_MS = 2 * 60 * 1000
    if (override) {
      const row = repo.getSessionBySessionId(override)
      if (row) {
        const focus = repo.getFocus(row.claude_pid)
        if (focus && Date.now() - focus.updated_at < CACHE_FRESH_MS) {
          return {
            sessionId: row.session_id,
            detected: true,
            ageMs: focus.age_ms,
            exchangeCount: focus.exchange_count,
            mentionedPaths: focus.mentioned_paths,
            mentionedBeads: focus.mentioned_beads,
            mentionedTokens: focus.mentioned_tokens,
            recentMessages: focus.tail,
          }
        }
      }
    }

    const ctx = getCurrentSessionContext(override ? { sessionIdOverride: override } : {})
    if (!ctx) return { sessionId: null, detected: false }
    return {
      sessionId: ctx.sessionId,
      detected: true,
      ageMs: ctx.ageMs,
      exchangeCount: ctx.exchangeCount,
      mentionedPaths: ctx.mentionedPaths,
      mentionedBeads: ctx.mentionedBeads,
      mentionedTokens: ctx.mentionedTokens,
      recentMessages: ctx.recentMessages,
    }
  }

  async function handlePlanOnly(_conn: LoreConnState, params: PlanOnlyParams): Promise<PlanOnlyResult> {
    const context = buildQueryContext()
    try {
      const call = await planQuery(params.query, context, { round: 1 })
      if (!call.plan) {
        return {
          ok: false,
          elapsedMs: call.elapsedMs,
          cost: call.cost ?? 0,
          model: call.model,
          error: call.error ?? "plan-failed",
        }
      }
      return {
        ok: true,
        plan: call.plan as unknown as Record<string, unknown>,
        variants: planVariants(call.plan),
        model: call.model,
        elapsedMs: call.elapsedMs,
        cost: call.cost ?? 0,
      }
    } catch (err) {
      return {
        ok: false,
        elapsedMs: 0,
        cost: 0,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  function handleSessionRegister(conn: LoreConnState, params: SessionRegisterParams): SessionRegisterResult {
    const now = Date.now()
    const row = repo.upsertSession({
      claudePid: params.claudePid,
      sessionId: params.sessionId,
      transcriptPath: params.transcriptPath,
      cwd: params.cwd,
      project: params.project,
      now,
    })
    repo.appendEvent({ ts: now, sessionId: params.sessionId, claudePid: params.claudePid, type: "session.registered" })
    conn.claudePid = params.claudePid
    conn.sessionId = params.sessionId
    log.debug?.(`session registered pid=${params.claudePid} session=${params.sessionId.slice(0, 8)}`)
    if (row.transcript_path) {
      queueMicrotask(() => refreshFocusFor(row))
    }
    return { ok: true, registeredAt: row.started_at }
  }

  function handleSessionHeartbeat(conn: LoreConnState, params: SessionHeartbeatParams): SessionHeartbeatResult {
    const now = Date.now()
    const row = repo.heartbeatSession(params.claudePid, now)
    if (row && !conn.claudePid) {
      conn.claudePid = params.claudePid
      conn.sessionId = row.session_id
    }
    return { ok: true, lastSeen: now }
  }

  function handleSessionsList(): SessionsListResult {
    const rows = repo.listSessions()
    return { sessions: rows.map(sessionRowToInfo) }
  }

  function buildSessionSummary(row: SessionRow): SessionFocusSummary {
    const focus = repo.getFocus(row.claude_pid)
    const now = Date.now()
    return {
      claudePid: row.claude_pid,
      sessionId: row.session_id,
      project: row.project,
      status: row.status,
      lastSeen: row.last_seen,
      lastActivityTs: focus?.last_activity_ts ?? null,
      ageMs:
        focus?.last_activity_ts !== null && focus?.last_activity_ts !== undefined ? now - focus.last_activity_ts : null,
      exchangeCount: focus?.exchange_count ?? 0,
      mentionedPaths: focus?.mentioned_paths ?? [],
      mentionedBeads: focus?.mentioned_beads ?? [],
      mentionedTokens: focus?.mentioned_tokens ?? [],
      focusHint: focus ? extractFocusHint(focus.tail) : "",
      focusSummary: focus?.focus_summary ?? null,
      looseEnds: focus?.loose_ends ?? [],
      summaryModel: focus?.summary_model ?? null,
      summaryUpdatedAt: focus?.summary_updated_at ?? null,
      updatedAt: focus?.updated_at ?? null,
    }
  }

  function extractFocusHint(tail: string): string {
    if (!tail) return ""
    const blocks = tail.trim().split(/\n\n+/)
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i]
      if (block?.startsWith("[USER]")) {
        const hint = block.slice("[USER]".length).trim()
        if (hint) return hint.slice(0, 120)
      }
    }
    const last = blocks[blocks.length - 1]
    if (!last) return ""
    return last.replace(/^\[(USER|ASSISTANT)\]\s*/, "").slice(0, 120)
  }

  function handleWorkspaceState(): WorkspaceStateResult {
    const rows = repo.listSessions()
    const sessions: SessionFocusSummary[] = rows.map(buildSessionSummary)
    return { generatedAt: Date.now(), sessions }
  }

  function handleSessionState(params: SessionStateParams): SessionStateResult {
    const row = repo.getSessionBySessionId(params.sessionId)
    if (!row) throw new Error(`Unknown sessionId: ${params.sessionId}`)
    const summary = buildSessionSummary(row)
    const focus = repo.getFocus(row.claude_pid)
    return { ...summary, tail: focus?.tail ?? "" }
  }

  async function handleInjectDelta(conn: LoreConnState, params: InjectDeltaParams): Promise<InjectDeltaResult> {
    const sessionId = params.sessionId ?? conn.sessionId ?? "unknown"
    const store = injectStoreFor(sessionId)
    const core = await runInjectDelta(params.prompt ?? "", store, {
      limit: params.limit,
      ttlTurns: params.ttlTurns,
    })
    if (core.skipped) {
      return { skipped: true, reason: core.reason, seenCount: store.size(), turnNumber: store.turn() }
    }
    return {
      skipped: false,
      additionalContext: core.additionalContext,
      newKeys: core.newKeys,
      seenCount: store.size(),
      turnNumber: core.turn,
    }
  }

  function handleStatus(): StatusResult {
    return {
      daemonPid: process.pid,
      daemonVersion,
      startedAt,
      dbPath: opts.dbPath,
      socketPath: opts.socketPath,
      sessionCount: repo.listSessions().filter((r) => r.status === "alive").length,
      idleDeadline: null,
    }
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  async function dispatch(conn: LoreConnState, method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case TRIBE_METHODS.hello:
        return handleHello(conn, params as unknown as HelloParams)
      case TRIBE_METHODS.ask:
        return handleAsk(conn, params as unknown as AskParams)
      case TRIBE_METHODS.currentBrief:
        return handleCurrentBrief(conn, params as unknown as CurrentBriefParams)
      case TRIBE_METHODS.planOnly:
        return handlePlanOnly(conn, params as unknown as PlanOnlyParams)
      case TRIBE_METHODS.sessionRegister:
        return handleSessionRegister(conn, params as unknown as SessionRegisterParams)
      case TRIBE_METHODS.sessionHeartbeat:
        return handleSessionHeartbeat(conn, params as unknown as SessionHeartbeatParams)
      case TRIBE_METHODS.sessionsList:
        return handleSessionsList()
      case TRIBE_METHODS.workspaceState:
        return handleWorkspaceState()
      case TRIBE_METHODS.sessionState:
        return handleSessionState(params as unknown as SessionStateParams)
      case TRIBE_METHODS.injectDelta:
        return handleInjectDelta(conn, params as unknown as InjectDeltaParams)
      case TRIBE_METHODS.status:
        return handleStatus()
      default: {
        const err = new Error(`Unknown lore method: ${method}`) as Error & { code?: number }
        err.code = LORE_ERRORS.unknownMethod
        throw err
      }
    }
  }

  function dropConn(sessionId: string | null): void {
    if (sessionId && sessionId !== "unknown") {
      injectStores.delete(sessionId)
    }
  }

  // ---------------------------------------------------------------------------
  // Background pollers (focus refresh + summarizer + janitor)
  // ---------------------------------------------------------------------------

  function refreshFocusFor(row: SessionRow): void {
    if (!row.transcript_path) return
    try {
      const focus = extractSessionFocus(row.transcript_path, { sessionId: row.session_id })
      if (!focus) return
      repo.upsertFocus({
        claudePid: row.claude_pid,
        lastActivityTs: focus.lastActivityTs,
        ageMs: focus.ageMs,
        exchangeCount: focus.exchangeCount,
        mentionedPaths: focus.mentionedPaths,
        mentionedBeads: focus.mentionedBeads,
        mentionedTokens: focus.mentionedTokens,
        tail: focus.tail,
        updatedAt: Date.now(),
      })
    } catch (err) {
      log.debug?.(`focus refresh failed for pid=${row.claude_pid}: ${err instanceof Error ? err.message : err}`)
    }
  }

  function refreshAllFocus(): void {
    for (const row of repo.listSessions()) {
      if (row.status !== "alive") continue
      refreshFocusFor(row)
    }
  }

  const SUMMARY_STALE_IF_IDLE_MS = 30 * 60 * 1000

  async function refreshSummariesOnce(): Promise<void> {
    if (summarizerMode === "off") return
    for (const row of repo.listSessions()) {
      if (row.status !== "alive") continue
      const focus = repo.getFocus(row.claude_pid)
      if (!focus?.tail) continue
      const ageMs = focus.last_activity_ts ? Date.now() - focus.last_activity_ts : null
      if (ageMs !== null && ageMs > SUMMARY_STALE_IF_IDLE_MS) continue
      if (
        focus.summary_updated_at !== null &&
        focus.last_activity_ts !== null &&
        focus.summary_updated_at >= focus.last_activity_ts
      ) {
        continue
      }
      try {
        const summary = await summarizeTail(focus.tail, { mode: summarizerMode, timeoutMs: 10_000 })
        if (!summary) continue
        repo.upsertSummary({
          claudePid: row.claude_pid,
          focusSummary: summary.focus,
          looseEnds: summary.looseEnds,
          summaryModel: summary.model,
          summaryCost: summary.cost,
          summaryUpdatedAt: Date.now(),
        })
        log.debug?.(`summary refreshed pid=${row.claude_pid} model=${summary.model} cost=$${summary.cost.toFixed(5)}`)
      } catch (err) {
        log.debug?.(`summary refresh failed for pid=${row.claude_pid}: ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  const janitor: NodeJS.Timeout = setInterval(() => {
    const now = Date.now()
    repo.sweepDeadSessions(now, 15 * 60 * 1000)
    const liveSessionIds = new Set(repo.listSessions().map((r) => r.session_id))
    for (const sessionId of injectStores.keys()) {
      if (sessionId !== "unknown" && !liveSessionIds.has(sessionId)) {
        injectStores.delete(sessionId)
      }
    }
  }, 30_000) as unknown as NodeJS.Timeout
  janitor.unref?.()

  const focusPoller: NodeJS.Timeout = setInterval(refreshAllFocus, focusPollMs) as unknown as NodeJS.Timeout
  focusPoller.unref?.()

  const summarizerPoller: NodeJS.Timeout | null =
    summarizerMode !== "off"
      ? (setInterval(() => {
          void refreshSummariesOnce()
        }, summaryPollMs) as unknown as NodeJS.Timeout)
      : null
  summarizerPoller?.unref?.()

  // Shared abort plumbing — if a signal is supplied, close on abort.
  if (opts.signal) {
    const onAbort = (): void => {
      void close()
    }
    if (opts.signal.aborted) void close()
    else opts.signal.addEventListener("abort", onAbort, { once: true })
  }

  let closed = false
  async function close(): Promise<void> {
    if (closed) return
    closed = true
    clearInterval(janitor)
    clearInterval(focusPoller)
    if (summarizerPoller) clearInterval(summarizerPoller)
    try {
      repo.close()
    } catch {
      /* ignore */
    }
  }

  return {
    isLoreMethod: (method: string): boolean => LORE_METHOD_SET.has(method),
    dispatch,
    dropConn,
    close,
    dbPath: opts.dbPath,
    startedAt,
    daemonVersion,
  }
}

// Re-export the summarizer mode resolver so the daemon can parse args.
export { resolveSummarizerMode } from "../../../plugins/tribe/lore/lib/summarizer.ts"
