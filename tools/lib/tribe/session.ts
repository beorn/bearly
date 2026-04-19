/**
 * Tribe session — registration, cursor recovery, transcript naming, cleanup.
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createLogger } from "loggily"
import type { TribeContext } from "./context.ts"

const log = createLogger("tribe:session")
import { sendMessage, logEvent } from "./messaging.ts"

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register a session in the DB.
 *
 * The `isActive` callback tells the registrar whether a pre-existing row that
 * holds the desired name belongs to a currently-connected session. If the
 * holder is no longer active (its socket is gone from the daemon's `clients`
 * Map), we overwrite its row — there is no point in preserving a dead row's
 * name. If the holder IS active, we fall back to a random suffix so two
 * living sessions never share a name.
 *
 * This replaces the old heartbeat-based eviction: before Phase 2 of
 * km-tribe.plateau we evicted rows with `heartbeat < cutoff`; now that
 * liveness lives in the daemon's Map (not a DB timer), the Map is the only
 * source of truth.
 */
export function registerSession(
  ctx: TribeContext,
  projectId?: string,
  isActive?: (sessionId: string) => boolean,
  identityToken?: string | null,
): void {
  const desiredName = ctx.getName()
  const now = Date.now()

  // If another row holds our desired name, and its session is NOT currently
  // connected, drop the stale row so we can claim the name cleanly.
  const holder = ctx.db
    .prepare("SELECT id FROM sessions WHERE name = $name AND id != $id")
    .get({ $name: desiredName, $id: ctx.sessionId }) as { id: string } | null
  if (holder) {
    const holderActive = isActive ? isActive(holder.id) : false
    if (!holderActive) {
      ctx.db.prepare("DELETE FROM sessions WHERE id = $id").run({ $id: holder.id })
      log.debug?.(`evicted stale session row holding name "${desiredName}"`)
    }
  }

  try {
    ctx.stmts.upsertSession.run({
      $id: ctx.sessionId,
      $name: desiredName,
      $role: ctx.sessionRole,
      $domains: JSON.stringify(ctx.domains),
      $pid: process.pid,
      $cwd: process.cwd(),
      $project_id: projectId ?? null,
      $claude_session_id: ctx.claudeSessionId,
      $claude_session_name: ctx.claudeSessionName,
      $identity_token: identityToken ?? null,
      $now: now,
    })
  } catch {
    // Name still taken (race or active holder) — add random suffix
    const fallbackName = `${desiredName}-${Math.random().toString(36).slice(2, 5)}`
    log.debug?.(`name "${desiredName}" taken by active session, using "${fallbackName}"`)
    ctx.setName(fallbackName)
    ctx.stmts.upsertSession.run({
      $id: ctx.sessionId,
      $name: ctx.getName(),
      $role: ctx.sessionRole,
      $domains: JSON.stringify(ctx.domains),
      $pid: process.pid,
      $cwd: process.cwd(),
      $project_id: projectId ?? null,
      $claude_session_id: ctx.claudeSessionId,
      $claude_session_name: ctx.claudeSessionName,
      $identity_token: identityToken ?? null,
      $now: now,
    })
  }

  logEvent(ctx, "session.joined", undefined, {
    name: ctx.getName(),
    role: ctx.sessionRole,
    domains: ctx.domains,
  })

  // Initialize cursor if needed
  const cursor = ctx.stmts.getCursor.get({ $session_id: ctx.sessionId }) as {
    last_read_ts: number
    last_seq: number | null
  } | null
  if (!cursor) {
    // On reconnect: recover cursor from prior session to avoid re-delivering old messages.
    // Try strategies in order: identity_token (most specific), claude_session_id,
    // PID, then skip-to-latest.
    let initialTs = 0
    let initialSeq = 0
    // Strategy 0: identity-token match (stable across Claude Code restarts)
    if (identityToken) {
      const prior = ctx.db
        .prepare(
          "SELECT id, name, role, last_delivered_ts, last_delivered_seq FROM sessions WHERE identity_token = $tok AND id != $id ORDER BY updated_at DESC LIMIT 1",
        )
        .get({ $tok: identityToken, $id: ctx.sessionId }) as {
        id: string
        name: string
        role: string
        last_delivered_ts: number | null
        last_delivered_seq: number | null
      } | null
      if (prior?.last_delivered_seq) {
        initialTs = prior.last_delivered_ts ?? 0
        initialSeq = prior.last_delivered_seq
        log.info?.(`recovered cursor from prior session (identity_token): seq=${initialSeq}`)
      }
    }
    // Strategy 1: match by claude_session_id (works when env var propagates)
    if (initialSeq === 0 && ctx.claudeSessionId) {
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
        log.info?.(`recovered cursor from prior session (claude_session_id): seq=${initialSeq}`)
      }
    }
    // Strategy 2: match by PID (works for /mcp reconnect — same PID, new MCP process)
    if (initialSeq === 0) {
      const priorByPid = ctx.db
        .prepare(
          "SELECT last_delivered_ts, last_delivered_seq FROM sessions WHERE pid = $pid AND id != $id AND last_delivered_seq IS NOT NULL AND last_delivered_seq > 0 ORDER BY updated_at DESC LIMIT 1",
        )
        .get({ $pid: process.pid, $id: ctx.sessionId }) as {
        last_delivered_ts: number
        last_delivered_seq: number | null
      } | null
      if (priorByPid?.last_delivered_seq) {
        initialTs = priorByPid.last_delivered_ts ?? 0
        initialSeq = priorByPid.last_delivered_seq
        log.info?.(`recovered cursor from prior session (PID match): seq=${initialSeq}`)
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
        log.info?.(`no prior cursor found, skipping to latest: seq=${initialSeq}`)
      }
    }
    // Backward compat: if no seq available, bootstrap from current max rowid
    if (initialSeq === 0 && initialTs > 0) {
      const maxRow = ctx.db
        .prepare("SELECT MAX(rowid) as max_rowid FROM messages WHERE ts <= $ts")
        .get({ $ts: initialTs }) as { max_rowid: number | null } | null
      initialSeq = maxRow?.max_rowid ?? 0
      log.info?.(`migrated ts cursor to seq=${initialSeq}`)
    }
    ctx.stmts.upsertCursor.run({ $session_id: ctx.sessionId, $ts: initialTs, $seq: initialSeq })
  } else if (!cursor.last_seq) {
    // Backward compat: existing cursor without last_seq — migrate from last_read_ts
    const maxRow = ctx.db
      .prepare("SELECT MAX(rowid) as max_rowid FROM messages WHERE ts <= $ts")
      .get({ $ts: cursor.last_read_ts }) as { max_rowid: number | null } | null
    const migratedSeq = maxRow?.max_rowid ?? 0
    ctx.stmts.upsertCursor.run({ $session_id: ctx.sessionId, $ts: cursor.last_read_ts, $seq: migratedSeq })
    log.info?.(`migrated existing cursor to seq=${migratedSeq}`)
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
  ctx.stmts.renameSession.run({ $new_name: slug, $session_id: ctx.sessionId, $now: Date.now() })
  ctx.setName(slug)
  sendMessage(ctx, "*", `Member "${oldName}" is now "${slug}"`, "notify")
  logEvent(ctx, "session.renamed", undefined, { old_name: oldName, new_name: slug, source: "initial-slug" })
  log.info?.(`initial name from /rename: ${oldName} → ${slug}`)
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** Delete old data based on TTL: reads/messages/event_log after 7 days */
export function cleanupOldData(ctx: TribeContext): void {
  const SHORT_TTL = 7 * 24 * 60 * 60 * 1000 // 7 days
  const now_ms = Date.now()

  const readsDel = ctx.db.prepare("DELETE FROM reads WHERE read_at < $cutoff").run({ $cutoff: now_ms - SHORT_TTL })
  const eventLogDel = ctx.db.prepare("DELETE FROM event_log WHERE ts < $cutoff").run({ $cutoff: now_ms - SHORT_TTL })
  const msgsDel = ctx.db.prepare("DELETE FROM messages WHERE ts < $cutoff").run({ $cutoff: now_ms - SHORT_TTL })
  // Clean dedup keys older than 1 day (they only need to survive the poll race window)
  ctx.stmts.cleanupDedup.run({ $cutoff: now_ms - 24 * 60 * 60 * 1000 })

  const total = (readsDel.changes ?? 0) + (eventLogDel.changes ?? 0) + (msgsDel.changes ?? 0)
  if (total > 0) {
    log.info?.(`cleanup: ${readsDel.changes} reads, ${eventLogDel.changes} event_log, ${msgsDel.changes} msgs deleted`)
  }
}
