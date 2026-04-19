/**
 * Tribe tool handlers — all MCP tool case implementations.
 */

import type { Database } from "bun:sqlite"
import { createLogger } from "loggily"
import type { TribeContext } from "./context.ts"

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
  leadership: "tribe.leadership",
  claimChief: "tribe.claim-chief",
  releaseChief: "tribe.release-chief",
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
    case TRIBE_COORD_METHODS.leadership:
      return handleLeadership(ctx, opts)
    case TRIBE_COORD_METHODS.claimChief:
      return handleClaimChief(ctx, opts)
    case TRIBE_COORD_METHODS.releaseChief:
      return handleReleaseChief(ctx, opts)
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
  opts: { userRenamed: boolean; setUserRenamed: (v: boolean) => void },
): ToolResult {
  const newName = a.new_name as string
  // Validate name format
  const nameError = validateName(newName)
  if (nameError) {
    return { content: [{ type: "text", text: JSON.stringify({ error: nameError }) }] }
  }
  // Check if name is taken
  const existing = ctx.stmts.checkNameTaken.get({ $name: newName, $session_id: ctx.sessionId })
  if (existing) {
    return { content: [{ type: "text", text: JSON.stringify({ error: `Name "${newName}" is already taken` }) }] }
  }
  const oldName = ctx.getName()
  ctx.stmts.renameSession.run({ $new_name: newName, $session_id: ctx.sessionId })
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

  // Check if name is taken by another session
  const taken = ctx.stmts.checkNameTaken.get({ $name: joinName, $session_id: ctx.sessionId })
  if (taken) {
    return { content: [{ type: "text", text: JSON.stringify({ error: `Name "${joinName}" is already taken` }) }] }
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
  ctx.setRole(joinRole as "chief" | "member")

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

  // Unread message count per recipient (direct messages only)
  const unread = ctx.db
    .prepare(`
			SELECT m.recipient, COUNT(*) as count FROM messages m
			WHERE m.recipient != '*'
			AND NOT EXISTS (
				SELECT 1 FROM reads r
				JOIN sessions s ON r.session_id = s.id
				WHERE r.message_id = m.id AND s.name = m.recipient
			)
			GROUP BY m.recipient
		`)
    .all() as Array<{ recipient: string; count: number }>

  const stats = {
    messages: (ctx.db.prepare("SELECT COUNT(*) as n FROM messages").get() as any)?.n ?? 0,
    events: (ctx.db.prepare("SELECT COUNT(*) as n FROM messages WHERE type LIKE 'event.%'").get() as any)?.n ?? 0,
    reads: (ctx.db.prepare("SELECT COUNT(*) as n FROM reads").get() as any)?.n ?? 0,
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

function handleLeadership(_ctx: TribeContext, opts: HandlerOpts): ToolResult {
  const info = opts.getChiefInfo()
  if (!info) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ leader: null, message: "No chief — no eligible sessions connected" }),
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
