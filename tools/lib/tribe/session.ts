/**
 * Tribe session — registration, cursor recovery, transcript naming, cleanup, heartbeat.
 */

import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { TribeContext } from "./context.ts"
import { acquireLease } from "./lease.ts"
import { sendMessage, logEvent } from "./messaging.ts"

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSession(ctx: TribeContext): void {
  try {
    ctx.stmts.upsertSession.run({
      $id: ctx.sessionId,
      $name: ctx.getName(),
      $role: ctx.sessionRole,
      $domains: JSON.stringify(ctx.domains),
      $pid: process.pid,
      $cwd: process.cwd(),
      $claude_session_id: ctx.claudeSessionId,
      $claude_session_name: ctx.claudeSessionName,
      $now: Date.now(),
    })
  } catch {
    // Name collision — add random suffix and retry
    const fallbackName = `${ctx.getName()}-${Math.random().toString(36).slice(2, 5)}`
    process.stderr.write(`[tribe] name "${ctx.getName()}" taken, using "${fallbackName}"\n`)
    ctx.setName(fallbackName)
    ctx.stmts.upsertSession.run({
      $id: ctx.sessionId,
      $name: ctx.getName(),
      $role: ctx.sessionRole,
      $domains: JSON.stringify(ctx.domains),
      $pid: process.pid,
      $cwd: process.cwd(),
      $claude_session_id: ctx.claudeSessionId,
      $claude_session_name: ctx.claudeSessionName,
      $now: Date.now(),
    })
  }

  ctx.stmts.insertEvent.run({
    $id: randomUUID(),
    $type: "session.joined",
    $session: ctx.getName(),
    $bead_id: null,
    $data: JSON.stringify({ name: ctx.getName(), role: ctx.sessionRole, domains: ctx.domains }),
    $ts: Date.now(),
  })

  // Initialize cursor if needed
  const cursor = ctx.stmts.getCursor.get({ $session_id: ctx.sessionId }) as {
    last_read_ts: number
    last_seq: number | null
  } | null
  if (!cursor) {
    // On reconnect: recover cursor from prior session to avoid re-delivering old messages.
    // Try three strategies in order: claude_session_id match, PID match, then skip-to-latest.
    let initialTs = 0
    let initialSeq = 0
    // Strategy 1: match by claude_session_id (works when env var propagates)
    if (ctx.claudeSessionId) {
      const prior = ctx.db
        .prepare(
          "SELECT last_delivered_ts, last_delivered_seq FROM sessions WHERE claude_session_id = $csid AND id != $id AND last_delivered_ts IS NOT NULL ORDER BY last_delivered_ts DESC LIMIT 1",
        )
        .get({ $csid: ctx.claudeSessionId, $id: ctx.sessionId }) as {
        last_delivered_ts: number
        last_delivered_seq: number | null
      } | null
      if (prior?.last_delivered_ts) {
        initialTs = prior.last_delivered_ts
        initialSeq = prior.last_delivered_seq ?? 0
        process.stderr.write(`[tribe] recovered cursor from prior session (claude_session_id): seq=${initialSeq}\n`)
      }
    }
    // Strategy 2: match by PID (works for /mcp reconnect — same PID, new MCP process)
    if (initialSeq === 0) {
      const priorByPid = ctx.db
        .prepare(
          "SELECT last_delivered_ts, last_delivered_seq FROM sessions WHERE pid = $pid AND id != $id AND last_delivered_seq IS NOT NULL AND last_delivered_seq > 0 ORDER BY heartbeat DESC LIMIT 1",
        )
        .get({ $pid: process.pid, $id: ctx.sessionId }) as {
        last_delivered_ts: number
        last_delivered_seq: number | null
      } | null
      if (priorByPid?.last_delivered_seq) {
        initialTs = priorByPid.last_delivered_ts ?? 0
        initialSeq = priorByPid.last_delivered_seq
        process.stderr.write(`[tribe] recovered cursor from prior session (PID match): seq=${initialSeq}\n`)
      }
    }
    // Strategy 3: if no prior session found, skip to current latest (avoid replaying entire history)
    if (initialSeq === 0) {
      const latest = ctx.db.prepare("SELECT MAX(rowid) as max_seq FROM messages").get() as {
        max_seq: number | null
      } | null
      if (latest?.max_seq) {
        initialSeq = latest.max_seq
        initialTs = Date.now()
        process.stderr.write(`[tribe] no prior cursor found, skipping to latest: seq=${initialSeq}\n`)
      }
    }
    // Backward compat: if no seq available, bootstrap from current max rowid
    if (initialSeq === 0 && initialTs > 0) {
      const maxRow = ctx.db
        .prepare("SELECT MAX(rowid) as max_rowid FROM messages WHERE ts <= $ts")
        .get({ $ts: initialTs }) as { max_rowid: number | null } | null
      initialSeq = maxRow?.max_rowid ?? 0
      process.stderr.write(`[tribe] migrated ts cursor to seq=${initialSeq}\n`)
    }
    ctx.stmts.upsertCursor.run({ $session_id: ctx.sessionId, $ts: initialTs, $seq: initialSeq })
  } else if (!cursor.last_seq) {
    // Backward compat: existing cursor without last_seq — migrate from last_read_ts
    const maxRow = ctx.db
      .prepare("SELECT MAX(rowid) as max_rowid FROM messages WHERE ts <= $ts")
      .get({ $ts: cursor.last_read_ts }) as { max_rowid: number | null } | null
    const migratedSeq = maxRow?.max_rowid ?? 0
    ctx.stmts.upsertCursor.run({ $session_id: ctx.sessionId, $ts: cursor.last_read_ts, $seq: migratedSeq })
    process.stderr.write(`[tribe] migrated existing cursor to seq=${migratedSeq}\n`)
  }
}

// ---------------------------------------------------------------------------
// Transcript-based naming
// ---------------------------------------------------------------------------

export function resolveTranscriptPath(claudeSessionId: string | null): string | null {
  if (!claudeSessionId) return null
  const cwd = process.cwd()
  const projectKey = "-" + cwd.replace(/\//g, "-")
  const transcriptPath = resolve(process.env.HOME ?? "~", ".claude/projects", projectKey, `${claudeSessionId}.jsonl`)
  return existsSync(transcriptPath) ? transcriptPath : null
}

/** Read the slug from the transcript — used once at startup to set initial name */
export function readTranscriptSlug(transcriptPath: string | null): string | null {
  if (!transcriptPath) return null
  try {
    const size = Bun.file(transcriptPath).size
    if (size === 0) return null
    const text = new TextDecoder().decode(
      new Uint8Array(readFileSync(transcriptPath).buffer.slice(Math.max(0, size - 4096))),
    )
    const lines = text.trimEnd().split("\n")
    const lastLine = lines[lines.length - 1]
    if (!lastLine) return null
    const data = JSON.parse(lastLine) as { slug?: string }
    return data.slug ?? null
  } catch {
    return null
  }
}

/** One-time: if session has a generic member-N name, try to set it from the transcript slug */
export function tryInitialRename(ctx: TribeContext, transcriptPath: string | null): void {
  if (!ctx.getName().startsWith("member-")) return // Already has a real name
  const slug = readTranscriptSlug(transcriptPath)
  if (!slug || slug === ctx.getName()) return

  const existing = ctx.stmts.checkNameTaken.get({ $name: slug, $session_id: ctx.sessionId })
  if (existing) return

  const oldName = ctx.getName()
  ctx.stmts.insertAlias.run({ $old_name: oldName, $session_id: ctx.sessionId, $now: Date.now() })
  ctx.stmts.renameSession.run({ $new_name: slug, $session_id: ctx.sessionId })
  ctx.setName(slug)
  sendMessage(ctx, "*", `Member "${oldName}" is now "${slug}"`, "notify")
  logEvent(ctx, "session.renamed", undefined, { old_name: oldName, new_name: slug, source: "initial-slug" })
  process.stderr.write(`[tribe] initial name from /rename: ${oldName} → ${slug}\n`)
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** Delete sessions pruned more than 24 hours ago */
export function cleanupOldPrunedSessions(ctx: TribeContext): void {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  const result = ctx.stmts.deleteOldPrunedSessions.run({ $cutoff: cutoff })
  if (result.changes > 0) {
    process.stderr.write(`[tribe] cleaned up ${result.changes} old pruned session(s)\n`)
  }
}

/** Delete old data based on TTL: reads after 7 days, messages/events/aliases after 30 days */
export function cleanupOldData(ctx: TribeContext): void {
  const READS_TTL = 7 * 24 * 60 * 60 * 1000 // 7 days
  const DATA_TTL = 30 * 24 * 60 * 60 * 1000 // 30 days
  const now_ms = Date.now()

  const readsDel = ctx.db.prepare("DELETE FROM reads WHERE read_at < $cutoff").run({ $cutoff: now_ms - READS_TTL })
  const eventsDel = ctx.db.prepare("DELETE FROM events WHERE ts < $cutoff").run({ $cutoff: now_ms - DATA_TTL })
  const msgsDel = ctx.db.prepare("DELETE FROM messages WHERE ts < $cutoff").run({ $cutoff: now_ms - DATA_TTL })
  const aliasesDel = ctx.db
    .prepare("DELETE FROM aliases WHERE renamed_at < $cutoff")
    .run({ $cutoff: now_ms - DATA_TTL })
  // Clean dedup keys older than 1 day (they only need to survive the poll race window)
  ctx.stmts.cleanupDedup.run({ $cutoff: now_ms - 24 * 60 * 60 * 1000 })

  const total = (readsDel.changes ?? 0) + (eventsDel.changes ?? 0) + (msgsDel.changes ?? 0) + (aliasesDel.changes ?? 0)
  if (total > 0) {
    process.stderr.write(
      `[tribe] cleanup: ${readsDel.changes} reads, ${eventsDel.changes} events, ${msgsDel.changes} msgs, ${aliasesDel.changes} aliases deleted\n`,
    )
  }
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export function sendHeartbeat(ctx: TribeContext): void {
  // Check if we were pruned — if so, log a rejoin event
  const session = ctx.db.prepare("SELECT pruned_at FROM sessions WHERE id = ?").get(ctx.sessionId) as {
    pruned_at: number | null
  } | null
  if (session?.pruned_at) {
    logEvent(ctx, "session.rejoined", undefined, {
      name: ctx.getName(),
      role: ctx.sessionRole,
      domains: ctx.domains,
    })
    process.stderr.write(`[tribe] ${ctx.getName()} rejoined tribe (was pruned)\n`)
    // Re-register to restore name (pruning renames to free the original name)
    registerSession(ctx)
    return
  }
  ctx.stmts.heartbeat.run({ $id: ctx.sessionId, $now: Date.now() })

  // Renew leader lease if chief
  if (ctx.sessionRole === "chief") {
    acquireLease(ctx.db, ctx.sessionId, ctx.getName())
  }
}
