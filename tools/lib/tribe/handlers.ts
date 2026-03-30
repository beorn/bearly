/**
 * Tribe tool handlers — all MCP tool case implementations.
 */

import type { Database } from "bun:sqlite"
import type { TribeContext } from "./context.ts"
import { validateName, sanitizeMessage } from "./validation.ts"
import { isLeaseHolder, acquireLease, getLeaseInfo } from "./lease.ts"
import { sendMessage, logEvent } from "./messaging.ts"
import { cleanupOldPrunedSessions } from "./session.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToolResult = { content: Array<{ type: string; text: string }> }
type ToolArgs = Record<string, unknown>

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export function handleToolCall(
  ctx: TribeContext,
  name: string,
  a: ToolArgs,
  opts: {
    cleanup: () => void
    userRenamed: boolean
    setUserRenamed: (v: boolean) => void
  },
): ToolResult | Promise<ToolResult> {
  switch (name) {
    case "tribe_send":
      return handleSend(ctx, a)
    case "tribe_broadcast":
      return handleBroadcast(ctx, a)
    case "tribe_sessions":
      return handleSessions(ctx, a)
    case "tribe_history":
      return handleHistory(ctx, a)
    case "tribe_rename":
      return handleRename(ctx, a, opts)
    case "tribe_join":
      return handleJoin(ctx, a)
    case "tribe_health":
      return handleHealth(ctx)
    case "tribe_reload":
      return handleReload(ctx, a, opts.cleanup)
    case "tribe_retro":
      return handleRetro(ctx, a)
    case "tribe_leadership":
      return handleLeadership(ctx)
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function handleSend(ctx: TribeContext, a: ToolArgs): ToolResult {
  const msgType = (a.type as string) ?? "notify"
  // Only lease holders can assign or verdict
  if ((msgType === "assign" || msgType === "verdict") && !isLeaseHolder(ctx.db, ctx.sessionId)) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: "Only the current chief lease holder can send assign/verdict messages" }),
        },
      ],
    }
  }
  const sanitized = sanitizeMessage(a.message as string)
  const result = sendMessage(
    ctx,
    a.to as string,
    sanitized,
    msgType,
    a.bead as string | undefined,
    a.ref as string | undefined,
  )
  logEvent(ctx, `message.sent.${msgType}`, a.bead as string | undefined, {
    to: a.to,
    message_id: result.id,
  })
  return { content: [{ type: "text", text: JSON.stringify({ sent: true, id: result.id }) }] }
}

function handleBroadcast(ctx: TribeContext, a: ToolArgs): ToolResult {
  const sanitized = sanitizeMessage(a.message as string)
  const result = sendMessage(ctx, "*", sanitized, (a.type as string) ?? "notify", a.bead as string | undefined)
  logEvent(ctx, "message.broadcast", a.bead as string | undefined, { message_id: result.id })
  return { content: [{ type: "text", text: JSON.stringify({ sent: true, id: result.id }) }] }
}

function handleSessions(ctx: TribeContext, a: ToolArgs): ToolResult {
  const threshold = Date.now() - 30_000
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
    heartbeat: number
    pruned_at: number | null
  }>

  // Auto-prune: check PID liveness and soft-prune dead sessions
  const dead: string[] = []
  for (const r of rows) {
    if (r.pid === process.pid) continue // don't kill ourselves
    if (r.pruned_at) continue // already pruned
    try {
      process.kill(r.pid, 0) // signal 0 = check if process exists
    } catch {
      dead.push(r.name)
      const pruneTs = Date.now()
      ctx.stmts.pruneSession.run({ $id: r.id, $now: pruneTs, $pruned_name: `${r.name}-pruned-${pruneTs}` })
    }
  }

  // Re-query after pruning
  const liveRows = a.all ? ctx.stmts.allSessions.all() : ctx.stmts.liveSessions.all({ $threshold: threshold })
  const sessions = (
    liveRows as Array<{
      id: string
      name: string
      role: string
      domains: string
      pid: number
      cwd: string
      claude_session_id: string | null
      claude_session_name: string | null
      started_at: number
      heartbeat: number
      pruned_at: number | null
    }>
  ).map((r) => ({
    name: r.name,
    role: r.role,
    domains: JSON.parse(r.domains),
    pid: r.pid,
    cwd: r.cwd,
    claude_session_id: r.claude_session_id,
    claude_session_name: r.claude_session_name,
    alive: r.heartbeat > threshold && !r.pruned_at,
    pruned: !!r.pruned_at,
    uptime_min: Math.round((Date.now() - r.started_at) / 60_000),
    last_heartbeat_sec: Math.round((Date.now() - r.heartbeat) / 1000),
  }))
  const result: Record<string, unknown> = { sessions }
  if (dead.length > 0) result.pruned = dead
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
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
  ctx.stmts.insertAlias.run({ $old_name: oldName, $session_id: ctx.sessionId, $now: Date.now() })
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

function handleJoin(ctx: TribeContext, a: ToolArgs): ToolResult {
  const joinName = a.name as string
  const joinRole = (a.role as string) ?? ctx.sessionRole
  const joinDomains = (a.domains as string[]) ?? ctx.domains

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

  // If joining as chief, try to acquire lease
  if (joinRole === "chief") {
    const leased = acquireLease(ctx.db, ctx.sessionId, joinName)
    if (!leased) {
      const info = getLeaseInfo(ctx.db)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: `chief lease held by ${info?.holder_name ?? "unknown"}` }),
          },
        ],
      }
    }
  }

  const prevName = ctx.getName()
  // If name changed, create an alias for the old name
  if (joinName !== prevName) {
    ctx.stmts.insertAlias.run({ $old_name: prevName, $session_id: ctx.sessionId, $now: Date.now() })
  }

  ctx.stmts.updateSessionMeta.run({
    $id: ctx.sessionId,
    $name: joinName,
    $role: joinRole,
    $domains: JSON.stringify(joinDomains),
    $now: Date.now(),
  })
  ctx.setName(joinName)

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

function handleHealth(ctx: TribeContext): ToolResult {
  const threshold = Date.now() - 30_000
  const silentThreshold = Date.now() - 300_000 // 5 minutes

  // Only check non-pruned sessions
  const activeSessions = ctx.stmts.activeSessions.all() as Array<{
    id: string
    name: string
    role: string
    domains: string
    pid: number
    started_at: number
    heartbeat: number
    pruned_at: number | null
  }>

  // Auto-prune: check PID liveness and soft-prune dead sessions
  const pruned: string[] = []
  for (const s of activeSessions) {
    if (s.pid === process.pid) continue
    try {
      process.kill(s.pid, 0)
    } catch {
      pruned.push(s.name)
      const pruneTs = Date.now()
      ctx.stmts.pruneSession.run({ $id: s.id, $now: pruneTs, $pruned_name: `${s.name}-pruned-${pruneTs}` })
    }
  }

  // Clean up sessions pruned more than 24 hours ago
  cleanupOldPrunedSessions(ctx)

  // Re-query active sessions after pruning
  const liveSessions = ctx.stmts.activeSessions.all() as typeof activeSessions

  const members = liveSessions.map((s) => {
    const alive = s.heartbeat > threshold
    // Find last message from this member
    const lastMsg = ctx.db
      .prepare("SELECT ts FROM messages WHERE sender = $name ORDER BY ts DESC LIMIT 1")
      .get({ $name: s.name }) as { ts: number } | null

    const lastMsgAge = lastMsg ? Date.now() - lastMsg.ts : null
    const warnings: string[] = []
    if (!alive) warnings.push("heartbeat timeout — session may be dead")
    if (alive && lastMsgAge && lastMsgAge > silentThreshold) {
      warnings.push(`no message in ${Math.round(lastMsgAge / 60_000)} min`)
    }
    if (!alive && !lastMsg) warnings.push("never sent a message")

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
    events: (ctx.db.prepare("SELECT COUNT(*) as n FROM events").get() as any)?.n ?? 0,
    reads: (ctx.db.prepare("SELECT COUNT(*) as n FROM reads").get() as any)?.n ?? 0,
  }

  const result: Record<string, unknown> = { members, unread, stats, checked_at: new Date().toISOString() }
  if (pruned.length > 0) result.pruned = pruned
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
  process.stderr.write(`[tribe] reloading: ${reason}\n`)

  // Schedule re-exec after responding to the tool call
  setTimeout(() => {
    cleanup()
    // Re-exec the same script with the same args — picks up latest code from disk
    const args = process.argv.slice(1) // drop the bun/node executable
    process.stderr.write(`[tribe] exec: ${process.execPath} ${args.join(" ")}\n`)
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
  const { generateRetro, formatMarkdown, parseDuration } = await import("../../tribe-retro.ts")
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

function handleLeadership(ctx: TribeContext): ToolResult {
  const info = getLeaseInfo(ctx.db)
  if (!info) {
    return {
      content: [{ type: "text", text: JSON.stringify({ leader: null, message: "No chief lease has been acquired" }) }],
    }
  }
  const expiresIn = Math.max(0, Math.round((info.lease_until - Date.now()) / 1000))
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            holder_name: info.holder_name,
            holder_id: info.holder_id,
            term: info.term,
            expires_in_seconds: expiresIn,
            expired: expiresIn === 0,
            acquired_at: new Date(info.acquired_at).toISOString(),
          },
          null,
          2,
        ),
      },
    ],
  }
}
