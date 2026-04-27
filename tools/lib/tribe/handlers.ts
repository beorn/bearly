/**
 * Tribe tool handlers — all MCP tool case implementations.
 */

import type { Database } from "bun:sqlite"
import { createLogger } from "loggily"
import type { TribeContext } from "./context.ts"
import type { TribeRole } from "./config.ts"

const log = createLogger("tribe:handlers")
import { validateName, sanitizeMessage } from "./validation.ts"
import { sendMessage, logEvent } from "./messaging.ts"

// ---------------------------------------------------------------------------
// Canonical tribe-coordination daemon RPC method names.
// ---------------------------------------------------------------------------

export const TRIBE_COORD_METHODS = {
  send: "tribe.send",
  broadcast: "tribe.broadcast",
  members: "tribe.members",
  history: "tribe.history",
  rename: "tribe.rename",
  health: "tribe.health",
  join: "tribe.join",
  reload: "tribe.reload",
  retro: "tribe.retro",
  chief: "tribe.chief",
  claimChief: "tribe.claim-chief",
  releaseChief: "tribe.release-chief",
  debug: "tribe.debug",
  inbox: "tribe.inbox",
  filter: "tribe.filter",
} as const

export type TribeCoordMethod = (typeof TRIBE_COORD_METHODS)[keyof typeof TRIBE_COORD_METHODS]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToolResult = { content: Array<{ type: string; text: string }> }
type ToolArgs = Record<string, unknown>

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
  /** Return the ctx.sessionId of the current chief (derived or explicitly claimed), or null. */
  getChiefId: () => string | null
  /** Return the current chief's id + name + whether the role was explicitly claimed. */
  getChiefInfo: () => { id: string; name: string; claimed: boolean } | null
  /** Explicitly claim chief for the given session. Idempotent. */
  claimChief: (sessionId: string, name: string) => void
  /** Release an explicit chief claim (if this session holds it). Idempotent. */
  releaseChief: (sessionId: string) => void
  /**
   * Return ctx.sessionId of every currently-connected eligible session — used
   * to compute `alive` on DB-sourced session rows without a heartbeat timer.
   * Excludes daemon / watch-* / pending-*.
   */
  getActiveSessionIds: () => Set<string>
  /** Realtime snapshot of connected sessions (daemon clients Map). */
  getActiveSessionInfo: () => ActiveSessionInfo[]
  /** Optional: dump daemon internals for `tribe.debug`. Daemon-only (tests using
   *  handlers directly can omit this — `tribe.debug` then returns a minimal
   *  snapshot synthesized from the other accessors). */
  getDebugState?: () => Record<string, unknown>
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
    case TRIBE_COORD_METHODS.broadcast:
      return handleBroadcast(ctx, a)
    case TRIBE_COORD_METHODS.members:
      return handleSessions(ctx, a, opts)
    case TRIBE_COORD_METHODS.history:
      return handleHistory(ctx, a)
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
    case TRIBE_COORD_METHODS.chief:
      return handleChief(ctx, opts)
    case TRIBE_COORD_METHODS.claimChief:
      return handleClaimChief(ctx, opts)
    case TRIBE_COORD_METHODS.releaseChief:
      return handleReleaseChief(ctx, opts)
    case TRIBE_COORD_METHODS.debug:
      return handleDebug(ctx, a, opts)
    case TRIBE_COORD_METHODS.inbox:
      return handleInbox(ctx, a)
    case TRIBE_COORD_METHODS.filter:
      return handleFilter(ctx, a)
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function handleSend(ctx: TribeContext, a: ToolArgs, opts: HandlerOpts): ToolResult {
  const msgType = (a.type as string) ?? "notify"
  // Only the current chief can assign or verdict
  if ((msgType === "assign" || msgType === "verdict") && opts.getChiefId() !== ctx.sessionId) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: "Only the current chief can send assign/verdict messages" }),
        },
      ],
    }
  }
  const sanitized = sanitizeMessage(a.message as string)
  // Dead-letter fallback for `to: "chief"` when no chief exists:
  // drain to '*' with a `[no-chief]` prefix so the message still reaches the
  // tribe rather than vanishing into an unread queue no one polls.
  const { recipient, content, routedFromChief } = routeChiefFallback(opts, a.to as string, sanitized)
  const result = sendMessage(
    ctx,
    recipient,
    content,
    msgType,
    a.bead as string | undefined,
    a.ref as string | undefined,
  )
  logEvent(ctx, `message.sent.${msgType}`, a.bead as string | undefined, {
    to: a.to,
    message_id: result.id,
    routedFromChief: routedFromChief || undefined,
  })
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ sent: true, id: result.id, routedFromChief: routedFromChief || undefined }),
      },
    ],
  }
}

function routeChiefFallback(
  opts: HandlerOpts,
  to: string,
  content: string,
): { recipient: string; content: string; routedFromChief: boolean } {
  if (to !== "chief") return { recipient: to, content, routedFromChief: false }
  if (opts.getChiefId() !== null) {
    return { recipient: to, content, routedFromChief: false }
  }
  // No chief — drain to the tribe so somebody sees it.
  return { recipient: "*", content: `[no-chief] ${content}`, routedFromChief: true }
}

function handleBroadcast(ctx: TribeContext, a: ToolArgs): ToolResult {
  const sanitized = sanitizeMessage(a.message as string)
  const result = sendMessage(ctx, "*", sanitized, (a.type as string) ?? "notify", a.bead as string | undefined)
  logEvent(ctx, "message.broadcast", a.bead as string | undefined, { message_id: result.id })
  return { content: [{ type: "text", text: JSON.stringify({ sent: true, id: result.id }) }] }
}

function handleSessions(ctx: TribeContext, a: ToolArgs, opts: HandlerOpts): ToolResult {
  // Liveness is determined by the daemon's in-memory clients Map — there is
  // no DB-level tri-state (live / pruned / dead). DB rows persist only for
  // cursor recovery across reconnects.
  const activeIds = opts.getActiveSessionIds()
  const rows = ctx.stmts.allSessions.all() as Array<{
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
      domains: JSON.parse(r.domains),
      pid: r.pid,
      cwd: r.cwd,
      claude_session_id: r.claude_session_id,
      claude_session_name: r.claude_session_name,
      alive: activeIds.has(r.id),
      uptime_min: Math.round((Date.now() - r.started_at) / 60_000),
      last_seen_sec: Math.round((Date.now() - r.updated_at) / 1000),
      parent: parent && parent !== r.name ? parent : undefined,
    }
  })
  return { content: [{ type: "text", text: JSON.stringify({ sessions }, null, 2) }] }
}

function handleHistory(ctx: TribeContext, a: ToolArgs): ToolResult {
  const who = (a.with as string) ?? ctx.getName()
  const limit = (a.limit as number) ?? 20
  const rows = ctx.stmts.messageHistory.all({ $name: who, $limit: limit }) as Array<{
    id: string
    type: string
    sender: string
    recipient: string
    content: string
    bead_id: string
    ref: string
    ts: number
    read_at: number
  }>
  const messages = rows.map((r) => ({
    id: r.id,
    type: r.type,
    from: r.sender,
    to: r.recipient,
    content: r.content,
    bead: r.bead_id,
    ref: r.ref,
    ts: new Date(r.ts).toISOString(),
    read: !!r.read_at,
  }))
  return { content: [{ type: "text", text: JSON.stringify(messages, null, 2) }] }
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
  // Validate name format
  const nameError = validateName(newName)
  if (nameError) {
    return { content: [{ type: "text", text: JSON.stringify({ error: nameError }) }] }
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
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Name "${newName}" is already taken` }) }],
      }
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
  ctx.stmts.renameSession.run({ $new_name: newName, $session_id: ctx.sessionId, $now: Date.now() })
  ctx.setName(newName)
  opts.setUserRenamed(true) // Explicit rename — name is now sticky, won't be overridden
  // Broadcast the rename
  sendMessage(ctx, "*", `Member "${oldName}" is now "${newName}"`, "notify")
  logEvent(ctx, "session.renamed", undefined, { old_name: oldName, new_name: newName })
  return {
    content: [{ type: "text", text: JSON.stringify({ renamed: true, old_name: oldName, new_name: newName }) }],
  }
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
    return { content: [{ type: "text", text: JSON.stringify({ error: joinNameError }) }] }
  }

  // Check if name is taken. Like handleRename, reclaim from non-active holders
  // by tombstoning the dead row (preserves message journal addressability).
  const taken = ctx.stmts.checkNameTaken.get({ $name: joinName, $session_id: ctx.sessionId }) as
    | { id: string }
    | undefined
  if (taken) {
    const isActive = opts.getActiveSessionIds().has(taken.id)
    if (isActive) {
      return { content: [{ type: "text", text: JSON.stringify({ error: `Name "${joinName}" is already taken` }) }] }
    }
    const tombstoneName = `${joinName}-dead-${taken.id.slice(0, 8)}`
    ctx.db
      .prepare("UPDATE sessions SET name = $tomb, updated_at = $now WHERE id = $id")
      .run({ $tomb: tombstoneName, $now: Date.now(), $id: taken.id })
    log.info?.(`reclaimed name "${joinName}" from dead session ${taken.id} (tombstoned as "${tombstoneName}")`)
  }

  // Joining with role=chief is now an explicit claim — derived chief otherwise.
  if (joinRole === "chief") {
    opts.claimChief(ctx.sessionId, joinName)
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

  logEvent(ctx, "session.joined", undefined, { name: joinName, role: joinRole, domains: joinDomains, rejoin: true })

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          joined: true,
          name: joinName,
          role: joinRole,
          domains: joinDomains,
          previous_name: joinName !== prevName ? prevName : undefined,
        }),
      },
    ],
  }
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

    return {
      name: s.name,
      role: s.role,
      domains: JSON.parse(s.domains),
      alive,
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
    messages: (ctx.db.prepare("SELECT COUNT(*) as n FROM messages").get() as any)?.n ?? 0,
    events: (ctx.db.prepare("SELECT COUNT(*) as n FROM messages WHERE kind = 'event'").get() as any)?.n ?? 0,
  }

  const result: Record<string, unknown> = { members, unread, stats, checked_at: new Date().toISOString() }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  }
}

function handleReload(ctx: TribeContext, a: ToolArgs, cleanup: () => void): ToolResult {
  const reason = (a.reason as string) ?? "manual reload"
  logEvent(ctx, "session.reload", undefined, { name: ctx.getName(), reason })
  log.info?.(`reloading: ${reason}`)

  // Schedule re-exec after responding to the tool call
  setTimeout(() => {
    cleanup()
    // Re-exec the same script with the same args — picks up latest code from disk
    const args = process.argv.slice(1) // drop the bun/node executable
    log.info?.(`exec: ${process.execPath} ${args.join(" ")}`)
    // Use Bun.spawn to replace the process
    const child = Bun.spawn([process.execPath, ...args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    })
    // Forward exit
    child.exited.then((code) => process.exit(code ?? 0))
  }, 100) // small delay so the tool response gets sent first

  return {
    content: [{ type: "text", text: JSON.stringify({ reloading: true, reason, pid: process.pid }) }],
  }
}

async function handleRetro(ctx: TribeContext, a: ToolArgs): Promise<ToolResult> {
  const { generateRetro, formatMarkdown, parseDuration } = await import("./retro.ts")
  const sinceStr = a.since as string | undefined
  let sinceMs: number | undefined
  if (sinceStr) {
    try {
      sinceMs = parseDuration(sinceStr)
    } catch {
      return { content: [{ type: "text", text: JSON.stringify({ error: `Invalid duration: "${sinceStr}"` }) }] }
    }
  }
  const fmt = (a.format as string) ?? "markdown"
  const report = generateRetro(ctx.db, sinceMs)
  const text = fmt === "json" ? JSON.stringify(report, null, 2) : formatMarkdown(report)
  return { content: [{ type: "text", text }] }
}

function handleChief(_ctx: TribeContext, opts: HandlerOpts): ToolResult {
  const info = opts.getChiefInfo()
  if (!info) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ chief: null, message: "No chief — no eligible sessions connected" }),
        },
      ],
    }
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            holder_name: info.name,
            holder_id: info.id,
            claimed: info.claimed,
            source: info.claimed ? "explicit-claim" : "derived-from-connection-order",
          },
          null,
          2,
        ),
      },
    ],
  }
}

function handleClaimChief(ctx: TribeContext, opts: HandlerOpts): ToolResult {
  opts.claimChief(ctx.sessionId, ctx.getName())
  return {
    content: [{ type: "text", text: JSON.stringify({ chief: ctx.getName(), claimed: true }) }],
  }
}

function handleReleaseChief(ctx: TribeContext, opts: HandlerOpts): ToolResult {
  opts.releaseChief(ctx.sessionId)
  const info = opts.getChiefInfo()
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ released: true, chief: info?.name ?? null }),
      },
    ],
  }
}

function handleDebug(_ctx: TribeContext, _a: ToolArgs, opts: HandlerOpts): ToolResult {
  // Prefer the daemon-provided dump when available (richest snapshot: clients
  // Map, chief claim, per-session cursors). Otherwise synthesize a minimal
  // view from the generic accessors so in-process tests still get meaningful
  // output without wiring getDebugState.
  const state = opts.getDebugState
    ? opts.getDebugState()
    : {
        clients: opts.getActiveSessionInfo(),
        chief: opts.getChiefInfo(),
        chiefClaim: null,
        cursors: [],
      }
  return { content: [{ type: "text", text: JSON.stringify(state) }] }
}

// ---------------------------------------------------------------------------
// km-tribe.event-classification handlers
// ---------------------------------------------------------------------------

type InboxRow = {
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
  plugin_kind: string | null
  room_id: string | null
}

function handleInbox(ctx: TribeContext, a: ToolArgs): ToolResult {
  const limit = typeof a.limit === "number" && a.limit > 0 && a.limit <= 500 ? a.limit : 50
  const cursor = ctx.stmts.getInboxCursor.get({ $id: ctx.sessionId }) as { last_inbox_pull_seq: number } | null
  const sinceArg = typeof a.since === "number" ? a.since : null
  const since = sinceArg !== null ? sinceArg : (cursor?.last_inbox_pull_seq ?? 0)

  const rows = ctx.stmts.getInboxRows.all({
    $since: since,
    $name: ctx.getName(),
    $limit: limit,
  }) as InboxRow[]

  // Optional plugin_kind glob filter — applied in JS to keep SQL simple.
  const kindGlobs = Array.isArray(a.kinds) ? (a.kinds as string[]).filter((s) => typeof s === "string") : null
  const filtered = kindGlobs && kindGlobs.length > 0 ? rows.filter((r) => matchesGlob(kindGlobs, r.plugin_kind)) : rows

  // Advance the cursor only when not using `since` arg (since=arg means caller
  // controls iteration explicitly and shouldn't bump the persistent cursor).
  if (filtered.length > 0 && sinceArg === null) {
    const maxSeq = filtered[filtered.length - 1]!.rowid
    ctx.stmts.advanceInboxCursor.run({ $id: ctx.sessionId, $seq: maxSeq, $now: Date.now() })
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
    plugin_kind: r.plugin_kind,
    room_id: r.room_id,
  }))
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ events, cursor: events.length > 0 ? events[events.length - 1]!.rowid : since }, null, 2),
      },
    ],
  }
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
 * mute + per-kind glob list into a single tool call. Replaces the old
 * tribe.mode + tribe.snooze + tribe.dismiss trio.
 *
 * Empty args clear the filter (mode → 'normal', kinds + until → null).
 * `until` is an absolute unix-ms timestamp; absent = persistent.
 *
 * Direct messages always bypass kinds/until — only `mode: 'focus'` filters DMs.
 */
function handleFilter(ctx: TribeContext, a: ToolArgs): ToolResult {
  const rawMode = a.mode
  if (rawMode !== undefined && rawMode !== "focus" && rawMode !== "normal" && rawMode !== "ambient") {
    return {
      content: [
        { type: "text", text: JSON.stringify({ error: `Invalid mode: "${String(rawMode)}". Use focus|normal|ambient.` }) },
      ],
    }
  }
  const mode = (rawMode as string | undefined) ?? "normal"

  const rawUntil = a.until
  if (rawUntil !== undefined && (typeof rawUntil !== "number" || rawUntil < 0)) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "until must be a non-negative unix-ms timestamp." }) }],
    }
  }
  const until = (rawUntil as number | undefined) ?? null

  const rawKinds = a.kinds
  if (rawKinds !== undefined && (!Array.isArray(rawKinds) || rawKinds.some((k) => typeof k !== "string"))) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "kinds must be an array of strings." }) }],
    }
  }
  const kinds = Array.isArray(rawKinds) && rawKinds.length > 0 ? JSON.stringify(rawKinds) : null

  ctx.stmts.setSessionFilter.run({
    $id: ctx.sessionId,
    $mode: mode,
    $until: until,
    $kinds: kinds,
    $now: Date.now(),
  })

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          set: true,
          mode,
          until: until !== null ? new Date(until).toISOString() : null,
          kinds: Array.isArray(rawKinds) ? rawKinds : null,
        }),
      },
    ],
  }
}
