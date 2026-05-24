/**
 * Tribe tool handlers — all MCP tool case implementations.
 */

import { createLogger } from "loggily"
import type { TribeContext } from "./context.ts"
import type { TribeRole } from "./config.ts"

const log = createLogger("tribe:handlers")
import { existsSync, readFileSync, statSync } from "node:fs"
import { validateName, sanitizeMessage } from "./validation.ts"
import { sendMessage, logEvent } from "./messaging.ts"
import { isPidAlive as pidStillAlive } from "./session.ts"
import { senderMayUseRegisteredTrustTopic, type SessionRoster } from "./trust.ts"
import type { LifecycleStore, LifecycleSnapshotRecord } from "./lifecycle-store.ts"

// ---------------------------------------------------------------------------
// Reconciler snapshot — read-only view into chief-reconciler output, surfaced
// inside tribe.health() so consumers see stale leases / dead sessions /
// orphan worktrees in real-time without a separate `km tribe doctor` call.
// Path comes from `TRIBE_RECONCILER_SNAPSHOT` so the daemon stays
// km-agnostic (matches vendor/CLAUDE.md: no hardcoded km paths in vendor).
// ---------------------------------------------------------------------------

const RECONCILER_STALE_MS = 20 * 60 * 1000 // 20min

interface ReconcilerFinding {
  kind: string
  severity?: "info" | "warn" | "action"
  summary?: string
  bead?: string
  agent?: string
  worktree?: string
  pid?: number
  fix?: string
}

interface ReconcilerSnapshotShape {
  ts: number
  findings: ReconcilerFinding[]
}

interface ReconcilerSection {
  lastTickAt?: number
  ageMs?: number
  findings?: Record<string, number>
  actions?: ReconcilerFinding[]
  error?: string
  snapshotPath?: string
}

/** Read + summarize the chief-reconciler snapshot. Returns null when the
 *  feature is opt-out (env var unset). All errors degrade gracefully into
 *  an `error` field — never throws, because tribe.health() must keep
 *  working when the snapshot file is missing, corrupt, or stale. */
export function readReconcilerSnapshot(): ReconcilerSection | null {
  const path = process.env.TRIBE_RECONCILER_SNAPSHOT
  if (!path) return null
  if (!existsSync(path)) {
    return { error: "snapshot not found", snapshotPath: path }
  }
  try {
    const raw = readFileSync(path, "utf8")
    const report = JSON.parse(raw) as ReconcilerSnapshotShape
    const lastTickAt = typeof report.ts === "number" ? report.ts : statSync(path).mtimeMs
    // statSync's mtimeMs is fractional; clamp to nonneg so a snapshot
    // written in the same tick doesn't surface a slightly-negative ageMs.
    const ageMs = Math.max(0, Date.now() - lastTickAt)
    const findings: Record<string, number> = {}
    const actions: ReconcilerFinding[] = []
    for (const f of Array.isArray(report.findings) ? report.findings : []) {
      const kind = String(f.kind ?? "unknown")
      findings[kind] = (findings[kind] ?? 0) + 1
      if (f.severity === "action") {
        actions.push({
          kind,
          ...(f.bead ? { bead: f.bead } : {}),
          ...(f.agent ? { agent: f.agent } : {}),
          ...(f.worktree ? { worktree: f.worktree } : {}),
          ...(f.pid ? { pid: f.pid } : {}),
          ...(f.fix ? { fix: f.fix } : {}),
        })
      }
    }
    if (ageMs > RECONCILER_STALE_MS) {
      findings["stale-snapshot"] = (findings["stale-snapshot"] ?? 0) + 1
    }
    return { lastTickAt, ageMs, findings, actions }
  } catch (err) {
    return { error: `snapshot parse failed: ${err instanceof Error ? err.message : String(err)}`, snapshotPath: path }
  }
}

// ---------------------------------------------------------------------------
// Canonical tribe-coordination daemon RPC method names.
// ---------------------------------------------------------------------------

export const TRIBE_COORD_METHODS = {
  send: "tribe.send",
  fetch: "tribe.fetch",
  members: "tribe.members",
  rename: "tribe.rename",
  health: "tribe.health",
  join: "tribe.join",
  reload: "tribe.reload",
  retro: "tribe.retro",
  debug: "tribe.debug",
  filter: "tribe.filter",
  lifecyclePublish: "tribe.lifecycle.publish",
  lifecycle: "tribe.lifecycle",
  pending: "tribe.pending",
} as const

export type TribeCoordMethod = (typeof TRIBE_COORD_METHODS)[keyof typeof TRIBE_COORD_METHODS]

/**
 * Notification-semantics primer returned in every `tribe.join` response. Host-
 * agnostic — every agent calls `tribe.join` exactly once at startup, so this is
 * the one reliable injection point for the convention (works for silvercode,
 * raw Claude Code, codex, anything that speaks tribe MCP). The text teaches:
 *
 *   1. Notifications (`from: daemon`, broadcasts `to: "*"`) are AMBIENT —
 *      surface them in fetch reads but never act on them.
 *   2. Direct messages addressed `to: <your name>` OR any `assign` / `query` /
 *      `request` / `verdict` typed message are the ACTIONABLE channel.
 *   3. When an actionable message needs no response and no comment, reply with
 *      ONLY `<ack/>` (or `<ack id="<msgid>"/>` to correlate) — silvercode
 *      suppresses bare-ack replies from the chat bubble, so a quiet
 *      acknowledgement is invisible while a real reply renders normally.
 *
 * Bead: `@km/code/15654` (Part 1).
 */
export const TRIBE_JOIN_PRIMER =
  "Tribe notification semantics: messages from `from: daemon` (github:push, " +
  'session events, health) and broadcasts (`to: "*"`) are AMBIENT awareness ' +
  "only — surface in `tribe.fetch` reads but DO NOT act on them. Direct " +
  "messages addressed `to: <your name>`, or any message with " +
  "`type: assign`/`query`/`request`/`verdict`, are the actionable channel. " +
  "When an actionable message needs no response and no comment, reply with " +
  '`<ack/>` (or `<ack id="<msgid>"/>` to correlate) and nothing else — ' +
  "silvercode suppresses bare-ack replies from the chat bubble."

const REMOVED_TRIBE_METHODS = new Set([
  "tribe.broadcast",
  "tribe.history",
  "tribe.inbox",
  "tribe.ping",
  "tribe.read",
  "broadcast",
  "history",
  "inbox",
  "ping",
  "read",
  // F12 of @km/tribe/15496-coordination-drift — the tribe-wire daemon is
  // role-agnostic; chief-ness is an L3 fact (the `@chief` bead lease), not a
  // daemon concept. These coordination-role methods were removed entirely.
  "tribe.chief",
  "tribe.claim-chief",
  "tribe.release-chief",
])
const REMOVED_TRIBE_METHOD_HINT = "use send/fetch/filter — see hub/bearly/design/tribe-message-bus.md"

export function isRemovedTribeMethod(name: string): boolean {
  return REMOVED_TRIBE_METHODS.has(name)
}

export function removedTribeMethodMessage(name: string): string {
  return `${name} removed; ${REMOVED_TRIBE_METHOD_HINT}`
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToolResult = {
  content: Array<{ type: string; text: string }>
  /**
   * MCP-spec first-class structured payload, paired with the tool's
   * `outputSchema` (see `tools-list.ts`). Hosts can render / validate /
   * consume this directly instead of double-parsing an escaped-JSON-string
   * out of `content[0].text`. Spec:
   * `@km/infra/15623-mcp-tools-structuredcontent`.
   *
   * The MCP `CallToolResult` schema requires structuredContent to be an
   * *object* — array / primitive payloads must be wrapped (the `jsonResult`
   * helper below does this automatically: arrays go under `items`,
   * primitives under `value`).
   */
  structuredContent?: Record<string, unknown>
  isError?: boolean
}
type ToolArgs = Record<string, unknown>

/**
 * Wrap a JSON-able payload as a dual content + structuredContent MCP tool
 * result. The `content[0].text` mirrors the payload as pretty-printed JSON
 * (backward compatible — pre-15623 hosts that only know `content` still see
 * the data); the `structuredContent` field carries the same payload as a
 * first-class object so structuredContent-aware hosts can render it
 * natively without the escaped-string envelope.
 *
 * For string-typed responses (e.g. retro markdown), pass `text` to override
 * the JSON-stringified text with a raw human-readable variant; the
 * structured payload is still wrapped as `{ text }` so the schema match
 * holds.
 *
 * Spec: @km/infra/15623-mcp-tools-structuredcontent.
 */
function jsonResult(payload: unknown, opts?: { text?: string }): ToolResult {
  const structured = ensureRecord(payload)
  const text = opts?.text ?? JSON.stringify(payload, null, 2)
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
  }
}

function ensureRecord(payload: unknown): Record<string, unknown> {
  if (payload === null || payload === undefined) return {}
  if (Array.isArray(payload)) return { items: payload }
  if (typeof payload === "object") return payload as Record<string, unknown>
  return { value: payload }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type ActiveSessionInfo = {
  id: string
  name: string
  pid: number
  role: string
  claudeSessionId: string | null
  registeredAt: number
}

export type HandlerOpts = {
  cleanup: () => void
  userRenamed: boolean
  setUserRenamed: (v: boolean) => void
  /**
   * Return ctx.sessionId of every currently-connected participating session —
   * used to compute `alive` on DB-sourced session rows without a heartbeat
   * timer. Excludes daemon / watch / pending sessions.
   */
  getActiveSessionIds: () => Set<string>
  /** Realtime snapshot of connected sessions (daemon clients Map). */
  getActiveSessionInfo: () => ActiveSessionInfo[]
  /** Optional: dump daemon internals for `tribe.debug`. Daemon-only (tests using
   *  handlers directly can omit this — `tribe.debug` then returns a minimal
   *  snapshot synthesized from the other accessors). */
  getDebugState?: () => Record<string, unknown>
  /** Optional: per-session lifecycle-snapshot cache (last-write-wins).
   *  Returns the daemon's singleton store; omitted when running handlers
   *  outside the daemon (tests, smoke harness) — `tribe.lifecycle.publish`
   *  / `tribe.lifecycle` then return an `error` field explaining that the
   *  store isn't available, instead of throwing. See `lifecycle-store.ts`
   *  + `@km/infra/15630-stuck-agent-observability` § S4. */
  getLifecycleStore?: () => LifecycleStore
}

export function handleToolCall(
  ctx: TribeContext,
  name: string,
  a: ToolArgs,
  opts: HandlerOpts,
): ToolResult | Promise<ToolResult> {
  switch (name) {
    case TRIBE_COORD_METHODS.send:
      return handleSend(ctx, a, opts)
    case TRIBE_COORD_METHODS.fetch:
      return handleFetch(ctx, a)
    case TRIBE_COORD_METHODS.members:
      return handleSessions(ctx, a, opts)
    case TRIBE_COORD_METHODS.rename:
      return handleRename(ctx, a, opts)
    case TRIBE_COORD_METHODS.join:
      return handleJoin(ctx, a, opts)
    case TRIBE_COORD_METHODS.health:
      return handleHealth(ctx, opts)
    case TRIBE_COORD_METHODS.reload:
      return handleReload(ctx, a, opts.cleanup)
    case TRIBE_COORD_METHODS.retro:
      return handleRetro(ctx, a)
    case TRIBE_COORD_METHODS.debug:
      return handleDebug(ctx, a, opts)
    case TRIBE_COORD_METHODS.filter:
      return handleFilter(ctx, a)
    case TRIBE_COORD_METHODS.lifecyclePublish:
      return handleLifecyclePublish(ctx, a, opts)
    case TRIBE_COORD_METHODS.lifecycle:
      return handleLifecycle(a, opts)
    case TRIBE_COORD_METHODS.pending:
      return handlePending(ctx, a, opts)
    default:
      if (REMOVED_TRIBE_METHODS.has(name)) {
        throw new Error(removedTribeMethodMessage(name))
      }
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Names of currently-active sessions, lexicographically sorted. Returned as
 *  `existing_names` on conflict errors so the caller can pick a non-colliding
 *  alternative without a separate `tribe.sessions` round-trip. */
function listActiveSessionNames(ctx: TribeContext, activeIds?: Set<string>): string[] {
  const rows = ctx.db.prepare("SELECT id, name FROM sessions").all() as Array<{ id: string; name: string }>
  const active = activeIds ?? new Set(rows.map((r) => r.id))
  return rows
    .filter((r) => active.has(r.id))
    .map((r) => r.name)
    .sort()
}

function parseDomains(value: string): string[] {
  const parsed: unknown = JSON.parse(value)
  return Array.isArray(parsed) && parsed.every((v) => typeof v === "string") ? parsed : []
}

function handleSend(ctx: TribeContext, a: ToolArgs, _opts: HandlerOpts): ToolResult {
  // The tribe-wire daemon is role-agnostic (F12 of
  // @km/tribe/15496-coordination-drift): every message type is delivered to
  // every session with no role gate. `assign` / `verdict` are ordinary
  // message types — coordination authority is an L3 concern, not a daemon one.
  const msgType = (a.type as string) ?? "notify"
  const sanitized = sanitizeMessage(a.message as string)
  // Ball-tracker fields (@km/tribe/message-ball-tracker Phase 2a):
  // both optional, orthogonal to `type`. `request: true` is the
  // shorthand for "this message IS its own request id" — we resolve it
  // post-send by passing the message id through. Explicit string forms
  // bind to an existing request id.
  const requestArg = a.request
  const replyArg = a.reply
  const fanoutArg = a.fanout as "first" | "all" | undefined
  // For `request: true`, the request id IS the message id. sendMessage
  // generates the message id internally, so for the truthy-shorthand case
  // we open the pending row AFTER the insert. For string-form, we open
  // immediately with the supplied id.
  const requestFlag = requestArg === true
  const requestId = typeof requestArg === "string" ? requestArg : null
  const replyId = typeof replyArg === "string" ? replyArg : null
  const result = sendMessage(
    ctx,
    a.to as string,
    sanitized,
    msgType,
    a.bead as string | undefined,
    a.ref as string | undefined,
    "direct",
    {},
    {
      request: requestFlag ? undefined : requestId ?? undefined,
      reply: replyId ?? undefined,
      fanout: fanoutArg,
    },
  )
  // Truthy-shorthand fixup: the canonical convention is request_id == message_id.
  // sendMessage already wrote the message; we now open the pending row using
  // the freshly-assigned id (no second SQL insert path — same statement).
  // Skipped for broadcast/event rows since Phase 2a is single-recipient-only.
  if (requestFlag && (a.to as string) !== "*") {
    ctx.stmts.openPendingRequest.run({
      $request_id: result.id,
      $recipient: a.to as string,
      $sender: ctx.getName(),
      $opened_at: result.ts,
      $message_id: result.id,
      $fanout: fanoutArg ?? "first",
    })
  }
  logEvent(ctx, `message.sent.${msgType}`, a.bead as string | undefined, {
    to: a.to,
    message_id: result.id,
  })
  return jsonResult({ sent: true, id: result.id })
}

function handlePending(ctx: TribeContext, a: ToolArgs, _opts: HandlerOpts): ToolResult {
  // Ball-tracker pending-query (@km/tribe/message-ball-tracker Phase 2a):
  // return open requests addressed to the given recipient (the "owner" of
  // the open ball). Default recipient is the caller's own session name.
  // Optional `stale_ms` filters to requests older than that threshold.
  const owner = (a.owner as string) ?? ctx.getName()
  const staleMs = typeof a.stale_ms === "number" ? a.stale_ms : null
  const now = Date.now()
  const rows = ctx.stmts.selectPendingForRecipient.all({ $recipient: owner }) as Array<{
    request_id: string
    sender: string
    opened_at: number
    message_id: string
    fanout: string
  }>
  const filtered = staleMs === null ? rows : rows.filter((r) => now - r.opened_at >= staleMs)
  const pending = filtered.map((r) => ({
    request_id: r.request_id,
    sender: r.sender,
    opened_at: new Date(r.opened_at).toISOString(),
    age_ms: now - r.opened_at,
    message_id: r.message_id,
    fanout: r.fanout,
  }))
  return jsonResult({ owner, pending, count: pending.length })
}

function handleSessions(ctx: TribeContext, a: ToolArgs, opts: HandlerOpts): ToolResult {
  // Membership is sourced from the `room_members` table (Matrix-shape, see
  // km-tribe.matrix-shape). Today every project has exactly one default room
  // and registerSession() populates the join row, so this is functionally a
  // no-op vs the prior `clients` Map sweep — but it exercises the schema so
  // the table stops being inert. Liveness still comes from the daemon's
  // in-memory clients Map (no DB-level tri-state).
  const activeIds = opts.getActiveSessionIds()
  // INNER JOIN on room_members: a session that hasn't joined any room is not
  // visible. The startup invariant + per-register backfill (joinDefaultRoom)
  // guarantee every active session has a row, so this match is total in
  // practice. Sessions appear once per room they belong to — DISTINCT collapses
  // multi-room sessions to one row (future-proofs sub-room work without
  // changing today's output shape).
  const rows = ctx.db
    .prepare(`
      SELECT DISTINCT s.id, s.name, s.role, s.domains, s.pid, s.cwd,
        s.claude_session_id, s.claude_session_name, s.started_at, s.updated_at,
        s.account, s.provider
      FROM sessions s
      INNER JOIN room_members rm ON rm.session_id = s.id
      ORDER BY s.started_at
    `)
    .all() as Array<{
    id: string
    name: string
    role: string
    domains: string
    pid: number
    cwd: string
    claude_session_id: string | null
    claude_session_name: string | null
    started_at: number
    updated_at: number
    account: string | null
    provider: string | null
  }>

  // By default return only currently-connected sessions. `a.all` exposes the
  // full DB (useful for diagnostics and tribe retro).
  const visibleRows = a.all ? rows : rows.filter((r) => activeIds.has(r.id))

  // Build parent map: first session per claudeSessionId is the parent, rest are sub-agents
  const parentMap = new Map<string, string>()
  for (const r of visibleRows) {
    if (!r.claude_session_id) continue
    if (!parentMap.has(r.claude_session_id)) {
      parentMap.set(r.claude_session_id, r.name)
    }
  }

  const sessions = visibleRows.map((r) => {
    const parent = r.claude_session_id ? parentMap.get(r.claude_session_id) : undefined
    return {
      name: r.name,
      role: r.role,
      domains: parseDomains(r.domains),
      pid: r.pid,
      cwd: r.cwd,
      claude_session_id: r.claude_session_id,
      claude_session_name: r.claude_session_name,
      alive: activeIds.has(r.id),
      uptime_min: Math.round((Date.now() - r.started_at) / 60_000),
      last_seen_sec: Math.round((Date.now() - r.updated_at) / 1000),
      parent: parent && parent !== r.name ? parent : undefined,
      // @km/infra/15641 Phase 1 — surface per-session account/provider
      // (omit when null so the output stays compact for sessions that
      // weren't spawned through ag).
      ...(r.account ? { account: r.account } : {}),
      ...(r.provider ? { provider: r.provider } : {}),
    }
  })
  return jsonResult({ sessions })
}

function handleRename(
  ctx: TribeContext,
  a: ToolArgs,
  opts: {
    userRenamed: boolean
    setUserRenamed: (v: boolean) => void
    /** Optional: when provided, allow reclaiming names held by non-active sessions. */
    getActiveSessionIds?: () => Set<string>
  },
): ToolResult {
  const newName = a.new_name as string
  // Rename-to-self: silent no-op. Without this short-circuit, the rest of the
  // handler still validates, broadcasts "Member X is now X", and emits a
  // session.renamed event — pure noise.
  if (newName === ctx.getName()) {
    return jsonResult({ renamed: false, name: newName })
  }
  // Validate name format
  const nameError = validateName(newName)
  if (nameError) {
    return jsonResult({ error: nameError })
  }
  // Check if name is taken. If the holder is a non-active (dead / disconnected)
  // session, reclaim the name — tombstone the old row so journaled messages
  // stay addressable (recipient column still points at the old id) but the
  // unique `name` column is freed. See km-bearly.tribe-session-resume F1-B.
  const existing = ctx.stmts.checkNameTaken.get({ $name: newName, $session_id: ctx.sessionId }) as
    | { id: string }
    | undefined
  if (existing) {
    const activeIds = opts.getActiveSessionIds?.()
    const isActive = activeIds ? activeIds.has(existing.id) : true
    if (isActive) {
      const existing_names = listActiveSessionNames(ctx, activeIds)
      return jsonResult({ error: `Name "${newName}" is already taken`, existing_names })
    }
    // Tombstone the dead holder's name so the current session can claim it.
    // Format: `<name>-dead-<8-char-id-prefix>` — deterministic, preserves the
    // old row (message journal stays valid), avoids collisions between
    // multiple sequential reclaims.
    const tombstoneName = `${newName}-dead-${existing.id.slice(0, 8)}`
    ctx.db
      .prepare("UPDATE sessions SET name = $tomb, updated_at = $now WHERE id = $id")
      .run({ $tomb: tombstoneName, $now: Date.now(), $id: existing.id })
    log.info?.(`reclaimed name "${newName}" from dead session ${existing.id} (tombstoned as "${tombstoneName}")`)
  }
  const oldName = ctx.getName()
  // A rename is the same session (same pid, same socket, same ctx.sessionId).
  // The tribe-wire daemon is role-agnostic (F12) — there is no chief claim to
  // carry across the rename, so a rename can no longer flap a coordination
  // identity. Chief-ness is an L3 fact (the `@chief` bead lease).
  ctx.stmts.renameSession.run({ $new_name: newName, $session_id: ctx.sessionId, $now: Date.now() })
  ctx.setName(newName)
  opts.setUserRenamed(true) // Explicit rename — name is now sticky, won't be overridden
  // Broadcast the rename
  sendMessage(ctx, "*", `Member "${oldName}" is now "${newName}"`, "notify")
  logEvent(ctx, "session.renamed", undefined, { old_name: oldName, new_name: newName })
  return jsonResult({ renamed: true, old_name: oldName, new_name: newName })
}

function handleJoin(ctx: TribeContext, a: ToolArgs, opts: HandlerOpts): ToolResult {
  let joinName = a.name as string
  let joinRole = (a.role as string) ?? ctx.sessionRole
  const joinDomains = (a.domains as string[]) ?? ctx.domains
  const identityToken = (a.identity_token as string) ?? (a.identityToken as string) ?? null

  // Identity-token adoption: if the caller supplies a token that matches a
  // non-active prior session, inherit its name/role when the caller didn't
  // pass them explicitly. Symmetric with the register path in tribe-daemon.
  if (identityToken) {
    const prior = ctx.db
      .prepare(
        "SELECT id, name, role FROM sessions WHERE identity_token = $tok AND id != $id ORDER BY updated_at DESC LIMIT 1",
      )
      .get({ $tok: identityToken, $id: ctx.sessionId }) as {
      id: string
      name: string
      role: string
    } | null
    if (prior) {
      const isActive = opts.getActiveSessionIds().has(prior.id)
      if (!isActive) {
        if (!a.name) joinName = prior.name
        if (!a.role) joinRole = prior.role
      }
    }
  }

  // Validate name format
  const joinNameError = validateName(joinName)
  if (joinNameError) {
    return jsonResult({ error: joinNameError })
  }

  // Check if name is taken. Like handleRename, reclaim from non-active holders
  // by tombstoning the dead row (preserves message journal addressability).
  const taken = ctx.stmts.checkNameTaken.get({ $name: joinName, $session_id: ctx.sessionId }) as
    | { id: string }
    | undefined
  if (taken) {
    const holderIsActive = opts.getActiveSessionIds().has(taken.id)
    if (!holderIsActive) {
      // Dead session — tombstone and reclaim.
      const tombstoneName = `${joinName}-dead-${taken.id.slice(0, 8)}`
      ctx.db
        .prepare("UPDATE sessions SET name = $tomb, updated_at = $now WHERE id = $id")
        .run({ $tomb: tombstoneName, $now: Date.now(), $id: taken.id })
      log.info?.(`reclaimed name "${joinName}" from dead session ${taken.id} (tombstoned as "${tombstoneName}")`)
    } else {
      // Active holder — tribe.join is an explicit identity assertion ("I am
      // @agent/3"). The old holder is a stale adapter process from a previous
      // session that Claude Code didn't kill. Tombstone and take over — the
      // user's explicit name wins over a lingering socket.
      const tombstoneName = `${joinName}-dead-${taken.id.slice(0, 8)}`
      ctx.db
        .prepare("UPDATE sessions SET name = $tomb, updated_at = $now WHERE id = $id")
        .run({ $tomb: tombstoneName, $now: Date.now(), $id: taken.id })
      log.info?.(
        `tribe.join takeover: "${joinName}" reclaimed from active session ${taken.id} (tombstoned as "${tombstoneName}")`,
      )
    }
  }

  const prevName = ctx.getName()
  // Note: renames are in-place; the old name is not preserved.

  ctx.stmts.updateSessionMeta.run({
    $id: ctx.sessionId,
    $name: joinName,
    $role: joinRole,
    $domains: JSON.stringify(joinDomains),
    $now: Date.now(),
  })
  ctx.setName(joinName)
  ctx.setRole(joinRole as TribeRole)

  // km-bearly.tribe-dm-delivery-gap: declare delivery mode. `push` (default)
  // means the daemon fans events out on the MCP channel; `pull` queues them
  // and the agent drains via tribe.fetch. MCP-only clients (codex, gemini,
  // etc.) without a notification reader should join with `pull`.
  const deliveryRaw = a.delivery
  if (deliveryRaw === "push" || deliveryRaw === "pull") {
    ctx.stmts.setSessionDelivery.run({
      $id: ctx.sessionId,
      $delivery: deliveryRaw,
      $now: Date.now(),
    })
  }
  const delivery =
    deliveryRaw === "push" || deliveryRaw === "pull"
      ? deliveryRaw
      : ((
          ctx.db.prepare("SELECT delivery FROM sessions WHERE id = $id").get({ $id: ctx.sessionId }) as
            | { delivery: string }
            | undefined
        )?.delivery ?? "push")

  logEvent(ctx, "session.joined", undefined, {
    name: joinName,
    role: joinRole,
    domains: joinDomains,
    delivery,
    rejoin: true,
  })

  return jsonResult({
    joined: true,
    name: joinName,
    role: joinRole,
    domains: joinDomains,
    delivery,
    previous_name: joinName !== prevName ? prevName : undefined,
    // 15654 Part 1 — notification-semantics primer. See TRIBE_JOIN_PRIMER docstring.
    primer: TRIBE_JOIN_PRIMER,
  })
}

function handleHealth(ctx: TribeContext, opts: HandlerOpts): ToolResult {
  const silentThreshold = Date.now() - 300_000 // 5 minutes

  // Liveness comes from the daemon's in-memory clients Map. Dead sessions
  // are simply absent from activeSessionInfo — no DB pruning required.
  const activeInfo = opts.getActiveSessionInfo()
  const byId = new Map(activeInfo.map((s) => [s.id, s]))
  const rows = ctx.stmts.allSessions.all() as Array<{
    id: string
    name: string
    role: string
    domains: string
    pid: number
    started_at: number
    updated_at: number
  }>
  const liveSessions = rows.filter((r) => byId.has(r.id))

  const members = liveSessions.map((s) => {
    const alive = true // by definition — only connected sessions reported
    // Find last message from this member
    const lastMsg = ctx.db
      .prepare("SELECT ts FROM messages WHERE sender = $name ORDER BY ts DESC LIMIT 1")
      .get({ $name: s.name }) as { ts: number } | null

    const lastMsgAge = lastMsg ? Date.now() - lastMsg.ts : null
    const warnings: string[] = []
    if (alive && lastMsgAge && lastMsgAge > silentThreshold) {
      warnings.push(`no message in ${Math.round(lastMsgAge / 60_000)} min`)
    }
    if (!lastMsg) warnings.push("never sent a message")

    // Spawn-time identity binding (@km/tribe/spawn-time-identity-binding):
    // a session whose stored PID is dead is a structural zombie — the
    // daemon thinks it's connected but the owning OS process is gone.
    // Surface this so health checks + chief reconciliation can detect
    // and clean up before a second `claude --name @agent/N` collides.
    const pidAlive = !s.pid || s.pid <= 0 ? true : pidStillAlive(s.pid)
    if (s.pid > 0 && !pidAlive) {
      warnings.push(`pid ${s.pid} is dead — session is a zombie`)
    }

    return {
      name: s.name,
      role: s.role,
      domains: parseDomains(s.domains),
      pid: s.pid,
      alive,
      pid_alive: pidAlive,
      last_message: lastMsgAge ? `${Math.round(lastMsgAge / 60_000)} min ago` : "never",
      warnings,
    }
  })

  // Unread direct-message count per recipient — undelivered means the
  // recipient's cursor (sessions.last_delivered_seq) hasn't reached the
  // message's rowid yet. Broadcasts ('*') and event journal rows are
  // excluded. If no session row exists for a recipient name (pre-register
  // or retention has pruned it), all their directs count as unread.
  const unread = ctx.db
    .prepare(`
			SELECT m.recipient, COUNT(*) as count FROM messages m
			WHERE m.recipient != '*'
			AND m.kind = 'direct'
			AND m.rowid > COALESCE(
				(SELECT s.last_delivered_seq FROM sessions s WHERE s.name = m.recipient),
				0
			)
			GROUP BY m.recipient
		`)
    .all() as Array<{ recipient: string; count: number }>

  const stats = {
    messages: (ctx.db.prepare("SELECT COUNT(*) as n FROM messages").get() as { n: number } | undefined)?.n ?? 0,
    events:
      (ctx.db.prepare("SELECT COUNT(*) as n FROM messages WHERE kind = 'event'").get() as { n: number } | undefined)
        ?.n ?? 0,
  }

  const result: Record<string, unknown> = { members, unread, stats, checked_at: new Date().toISOString() }
  // L4 of @km/tribe/stable-coordination: surface the chief-reconciler's
  // four-source reconciliation (live processes / bead claims / worktrees /
  // tribe sessions) inline so any session asking tribe.health() sees
  // orphans in real-time. Opt-in via TRIBE_RECONCILER_SNAPSHOT env var so
  // the bearly daemon stays km-agnostic for standalone deployments.
  const reconciler = readReconcilerSnapshot()
  if (reconciler) result.reconciler = reconciler
  return jsonResult(result)
}

function handleReload(ctx: TribeContext, a: ToolArgs, cleanup: () => void): ToolResult {
  const reason = (a.reason as string) ?? "manual reload"
  logEvent(ctx, "session.reload", undefined, { name: ctx.getName(), reason })
  log.info?.(`reloading: ${reason}`)

  // Schedule the re-exec after the tool response is flushed.
  //
  // We deliberately do NOT spawn the replacement daemon here. A naive
  // `Bun.spawn([execPath, ...process.argv])` re-exec races the old daemon to
  // re-bind the socket, sees "Another daemon is already listening", and exits
  // immediately; meanwhile the old daemon also exits. Net result: NO daemon,
  // and every session sees "No daemon running". (Reproduced 2026-05-21 — a
  // session calling `tribe.reload` repeatedly killed the daemon.)
  //
  // Instead we SIGHUP ourselves. The daemon's `withSignals` factory routes
  // SIGHUP → `withHotReload.reload()`, which closes + unlinks the socket then
  // spawns a DETACHED replacement that binds the freed path fresh — the
  // replacement survives this process's exit, and adapters reconnect
  // transparently. This is the same hardened path `tribe reload` (the CLI)
  // already uses.
  setTimeout(() => {
    cleanup()
    log.info?.(`SIGHUP self (pid=${process.pid}) — hot-reload via detached re-exec`)
    process.kill(process.pid, "SIGHUP")
  }, 100) // small delay so the tool response gets sent first

  return jsonResult({ reloading: true, reason, pid: process.pid })
}

async function handleRetro(ctx: TribeContext, a: ToolArgs): Promise<ToolResult> {
  const { generateRetro, formatMarkdown, parseDuration } = await import("./retro.ts")
  const sinceStr = a.since as string | undefined
  let sinceMs: number | undefined
  if (sinceStr) {
    try {
      sinceMs = parseDuration(sinceStr)
    } catch {
      return jsonResult({ error: `Invalid duration: "${sinceStr}"` })
    }
  }
  const fmt = (a.format as string) ?? "markdown"
  const report = generateRetro(ctx.db, sinceMs)
  // Retro is one of the two string-typed tool results (markdown vs json) —
  // we still emit `structuredContent: { text }` so the shape contract is
  // uniform; chat-surface shows the markdown / pretty JSON as-is.
  if (fmt === "json") {
    return jsonResult(report)
  }
  const markdown = formatMarkdown(report)
  return jsonResult({ text: markdown }, { text: markdown })
}

function handleDebug(_ctx: TribeContext, _a: ToolArgs, opts: HandlerOpts): ToolResult {
  // Prefer the daemon-provided dump when available (richest snapshot: clients
  // Map, per-session cursors). Otherwise synthesize a minimal view from the
  // generic accessors so in-process tests still get meaningful output without
  // wiring getDebugState.
  const state = opts.getDebugState
    ? opts.getDebugState()
    : {
        clients: opts.getActiveSessionInfo(),
        cursors: [],
      }
  return jsonResult(state)
}

// ---------------------------------------------------------------------------
// km-tribe.event-classification handlers
// ---------------------------------------------------------------------------

type FetchRow = {
  id: string
  rowid: number
  type: string
  sender: string
  recipient: string
  content: string
  bead_id: string | null
  ref: string | null
  ts: number
  delivery: string
  topic: string | null
  room_id: string | null
}

function sessionRoster(ctx: TribeContext): SessionRoster {
  return ctx.db.prepare("SELECT name, role FROM sessions").all() as Array<{ name: string; role: string | null }>
}

function filterRowsByTrust(ctx: TribeContext, rows: FetchRow[]): FetchRow[] {
  if (rows.length === 0) return rows
  const roster = sessionRoster(ctx)
  return rows.filter((r) => senderMayUseRegisteredTrustTopic(r.topic, r.sender, roster))
}

function handleFetch(ctx: TribeContext, a: ToolArgs): ToolResult {
  const limit = typeof a.limit === "number" && a.limit > 0 && a.limit <= 500 ? a.limit : 50
  const topics = normalizeStringArray(a.topics)
  if (a.topics !== undefined && topics === null) {
    return jsonResult({ error: "topics must be an array of strings." })
  }

  const cursor = ctx.stmts.getInboxCursor.get({ $id: ctx.sessionId }) as { last_inbox_pull_seq: number } | null
  const currentName = ctx.getName()
  let rows: FetchRow[]
  let shouldAdvance = false
  let cursorBase = cursor?.last_inbox_pull_seq ?? 0

  const ids = normalizeStringArray(a.ids)
  if (a.ids !== undefined && ids === null) {
    return jsonResult({ error: "ids must be an array of strings." })
  }

  if (ids && ids.length > 0) {
    const placeholders = ids.map(() => "?").join(", ")
    rows = ctx.db
      .prepare(`
        SELECT id, rowid, type, sender, recipient, content, bead_id, ref, ts, delivery, topic, room_id
        FROM messages
        WHERE id IN (${placeholders})
          AND kind != 'event'
          AND (sender = ? OR recipient = ? OR recipient = '*')
        ORDER BY rowid ASC
        LIMIT ?
      `)
      .all(...ids, currentName, currentName, limit) as FetchRow[]
    const byId = new Map(rows.map((r) => [r.id, r]))
    rows = ids.map((id) => byId.get(id)).filter((r): r is FetchRow => !!r)
  } else if (typeof a.with === "string" && a.with.length > 0) {
    rows = ctx.db
      .prepare(`
        SELECT id, rowid, type, sender, recipient, content, bead_id, ref, ts, delivery, topic, room_id
        FROM messages
        WHERE kind != 'event'
          AND (
            (sender = $self AND recipient = $peer)
            OR (sender = $peer AND recipient = $self)
          )
        ORDER BY rowid ASC
        LIMIT $limit
      `)
      .all({ $self: currentName, $peer: a.with, $limit: limit }) as FetchRow[]
  } else if (typeof a.from === "string" && a.from.length > 0) {
    rows = ctx.db
      .prepare(`
        SELECT id, rowid, type, sender, recipient, content, bead_id, ref, ts, delivery, topic, room_id
        FROM messages
        WHERE kind != 'event'
          AND sender = $from
          AND (sender = $self OR recipient = $self OR recipient = '*')
        ORDER BY rowid ASC
        LIMIT $limit
      `)
      .all({ $from: a.from, $self: currentName, $limit: limit }) as FetchRow[]
  } else if (typeof a.to === "string" && a.to.length > 0) {
    rows = ctx.db
      .prepare(`
        SELECT id, rowid, type, sender, recipient, content, bead_id, ref, ts, delivery, topic, room_id
        FROM messages
        WHERE kind != 'event'
          AND recipient = $to
          AND (sender = $self OR recipient = $self OR recipient = '*')
        ORDER BY rowid ASC
        LIMIT $limit
      `)
      .all({ $to: a.to, $self: currentName, $limit: limit }) as FetchRow[]
  } else {
    const hasSince = typeof a.since === "number"
    const since = hasSince ? (a.since as number) : cursorBase
    cursorBase = since
    rows = ctx.stmts.getInboxRows.all({
      $since: since,
      $name: currentName,
      $limit: limit,
    }) as FetchRow[]
    shouldAdvance = hasSince ? a.advance === true : a.advance !== false
  }

  const visibleRows = rows
  rows = filterRowsByTrust(ctx, visibleRows)
  const filtered = topics && topics.length > 0 ? rows.filter((r) => matchesGlob(topics, r.topic)) : rows
  const cursorRows = topics && topics.length > 0 ? visibleRows.filter((r) => matchesGlob(topics, r.topic)) : visibleRows
  let outputCursor = filtered.at(-1)?.rowid ?? cursorBase

  if (cursorRows.length > 0 && shouldAdvance) {
    const last = cursorRows.at(-1)
    if (last) {
      ctx.stmts.advanceInboxCursor.run({ $id: ctx.sessionId, $seq: last.rowid, $now: Date.now() })
      outputCursor = last.rowid
    }
  }

  const events = filtered.map((r) => ({
    id: r.id,
    rowid: r.rowid,
    type: r.type,
    from: r.sender,
    to: r.recipient,
    content: r.content,
    bead: r.bead_id,
    ref: r.ref,
    ts: new Date(r.ts).toISOString(),
    delivery: r.delivery,
    topic: r.topic,
    room_id: r.room_id,
  }))
  return jsonResult({ events, cursor: outputCursor })
}

function normalizeStringArray(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((s) => typeof s !== "string")) return null
  return value as string[]
}

function matchesGlob(globs: string[], value: string | null): boolean {
  if (!value) return false
  for (const g of globs) {
    if (g === "*") return true
    if (!g.includes("*") && g === value) return true
    if (g.includes("*")) {
      const re: RegExp = new RegExp("^" + g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$")
      if (re.test(value)) return true
    }
  }
  return false
}

/**
 * Apply a session-level event filter — combines persistent mode + time-bounded
 * mute + per-topic glob list into a single tool call.
 *
 * Empty args clear the filter (mode → 'normal', mute + until → null).
 * `until` is an absolute unix-ms timestamp. `mute` without `until` is persistent.
 *
 * Direct messages always bypass mute/until — only `mode: 'focus'` filters DMs.
 */
function handleFilter(ctx: TribeContext, a: ToolArgs): ToolResult {
  const rawMode = a.mode
  if (rawMode !== undefined && rawMode !== "focus" && rawMode !== "normal" && rawMode !== "ambient") {
    return jsonResult({ error: `Invalid mode: "${String(rawMode)}". Use focus|normal|ambient.` })
  }
  const mode = (rawMode as string | undefined) ?? "normal"

  const rawUntil = a.until
  if (rawUntil !== undefined && (typeof rawUntil !== "number" || rawUntil < 0)) {
    return jsonResult({ error: "until must be a non-negative unix-ms timestamp." })
  }
  const until = (rawUntil as number | undefined) ?? null

  const rawMute = a.mute
  if (rawMute !== undefined && (!Array.isArray(rawMute) || rawMute.some((topic) => typeof topic !== "string"))) {
    return jsonResult({ error: "mute must be an array of strings." })
  }
  const mute = Array.isArray(rawMute) && rawMute.length > 0 ? JSON.stringify(rawMute) : null

  ctx.stmts.setSessionFilter.run({
    $id: ctx.sessionId,
    $mode: mode,
    $until: until,
    $mute: mute,
    $now: Date.now(),
  })

  return jsonResult({
    set: true,
    mode,
    until: until !== null ? new Date(until).toISOString() : null,
    mute: Array.isArray(rawMute) ? rawMute : null,
  })
}

// ---------------------------------------------------------------------------
// Lifecycle snapshots — per-session diagnostic cache.
//
// A session publishes its tool-call-lifecycle snapshot on every state
// transition (S1 of `@km/infra/15630-stuck-agent-observability`); chief
// / observers read the latest snapshot to diagnose stuck-agent situations.
// The daemon is opaque about the payload shape — the publisher owns the
// schema. See `lifecycle-store.ts` for the in-memory store, and the bead
// body for the larger architecture (S1 reducer, S2 observer, S3 typed
// diagnostic ChatEvent, S4 = this surface + chief introspection).
// ---------------------------------------------------------------------------

function lifecycleSnapshotJson(record: LifecycleSnapshotRecord): Record<string, unknown> {
  return {
    sessionName: record.sessionName,
    sessionId: record.sessionId,
    receivedAt: new Date(record.receivedAt).toISOString(),
    payload: record.payload,
  }
}

function handleLifecyclePublish(ctx: TribeContext, a: ToolArgs, opts: HandlerOpts): ToolResult {
  const store = opts.getLifecycleStore?.()
  if (!store) {
    return jsonResult({ error: "lifecycle store unavailable (daemon required)" })
  }
  const payload = a.snapshot
  if (payload === undefined || payload === null) {
    return jsonResult({ error: "snapshot field is required" })
  }
  const record = store.set(ctx.getName(), ctx.sessionId, payload, Date.now())
  return jsonResult({
    published: true,
    sessionName: record.sessionName,
    receivedAt: new Date(record.receivedAt).toISOString(),
  })
}

function handleLifecycle(a: ToolArgs, opts: HandlerOpts): ToolResult {
  const store = opts.getLifecycleStore?.()
  if (!store) {
    return jsonResult({ error: "lifecycle store unavailable (daemon required)" })
  }
  const sessionArg = a.session
  if (sessionArg !== undefined && typeof sessionArg !== "string") {
    return jsonResult({ error: "session field must be a string when provided" })
  }
  if (typeof sessionArg === "string" && sessionArg.length > 0) {
    const record = store.get(sessionArg)
    if (!record) {
      return jsonResult({ session: sessionArg, snapshot: null })
    }
    return jsonResult({ session: sessionArg, snapshot: lifecycleSnapshotJson(record) })
  }
  // No session arg → return all known snapshots, newest first.
  return jsonResult({ snapshots: store.list().map(lifecycleSnapshotJson) })
}
