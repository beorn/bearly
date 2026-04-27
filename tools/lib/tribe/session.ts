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

  // Matrix-shape: every session is a member of its project's default room.
  // Today there's one room per project (`room:<project_id>` or `room:default`
  // for unscoped sessions); future multi-room work adds sub-rooms without
  // changing this invariant. Format mirrors migration v10's backfill.
  joinDefaultRoom(ctx, projectId ?? null, ctx.sessionRole, now)

  logEvent(ctx, "session.joined", undefined, {
    name: ctx.getName(),
    role: ctx.sessionRole,
    domains: ctx.domains,
  })

  // km-tribe.delivery-correctness P1.3: the old cursor-init block seeded a
  // per-session entry in the now-dropped `cursors` table with multi-strategy
  // recovery (identity_token → claude_session_id → pid → skip-to-latest).
  // Nothing in the post-event-bus code path reads from `cursors`. The daemon
  // seeds `sessions.last_delivered_seq` directly in replayOrBootstrap, using
  // identity_token adoption for stable-identity recovery — this redundant
  // block went away with the table.
}

// ---------------------------------------------------------------------------
// Matrix-shape rooms (km-tribe.matrix-shape)
// ---------------------------------------------------------------------------

/** Canonical room id for a project. `null` projectId → 'room:default'. */
export function defaultRoomId(projectId: string | null): string {
  return `room:${projectId ?? "default"}`
}

/** Idempotently ensure (room, room_member) rows exist for this session in the
 *  project's default room. Mirrors the schema-v10 backfill format so live writes
 *  and migration history stay shape-compatible. */
export function joinDefaultRoom(ctx: TribeContext, projectId: string | null, role: string, now: number): void {
  const roomId = defaultRoomId(projectId)
  ctx.db
    .prepare(
      "INSERT INTO rooms (id, project_id, name, created_at) VALUES ($id, $pid, $name, $now) ON CONFLICT(id) DO NOTHING",
    )
    .run({ $id: roomId, $pid: projectId, $name: projectId ?? "default", $now: now })
  ctx.db
    .prepare(
      "INSERT INTO room_members (room_id, session_id, joined_at, role) VALUES ($room, $sid, $now, $role) ON CONFLICT(room_id, session_id) DO NOTHING",
    )
    .run({ $room: roomId, $sid: ctx.sessionId, $now: now, $role: role })
}

/** Backfill any sessions in the table that don't have a corresponding row in
 *  room_members for their project's default room. Used at daemon startup to
 *  bring forward historic state from before the matrix-shape invariant existed
 *  (and as a safety net for any code path that might insert into `sessions`
 *  without going through registerSession). Returns count of rows inserted. */
export function backfillDefaultRoomMembers(ctx: TribeContext): number {
  const now = Date.now()
  const orphaned = ctx.db
    .prepare(`
      SELECT s.id, s.role, COALESCE(s.project_id, 'default') AS pid, s.project_id AS project_id, s.started_at
      FROM sessions s
      LEFT JOIN room_members rm
        ON rm.session_id = s.id
        AND rm.room_id = 'room:' || COALESCE(s.project_id, 'default')
      WHERE rm.session_id IS NULL
    `)
    .all() as Array<{ id: string; role: string; pid: string; project_id: string | null; started_at: number }>
  if (orphaned.length === 0) return 0
  const insertRoom = ctx.db.prepare(
    "INSERT INTO rooms (id, project_id, name, created_at) VALUES ($id, $pid, $name, $now) ON CONFLICT(id) DO NOTHING",
  )
  const insertMember = ctx.db.prepare(
    "INSERT INTO room_members (room_id, session_id, joined_at, role) VALUES ($room, $sid, $now, $role) ON CONFLICT(room_id, session_id) DO NOTHING",
  )
  for (const row of orphaned) {
    const roomId = `room:${row.pid}`
    insertRoom.run({ $id: roomId, $pid: row.project_id, $name: row.pid, $now: now })
    insertMember.run({ $room: roomId, $sid: row.id, $now: row.started_at ?? now, $role: row.role })
    log.warn?.("backfilled missing room_members row for active session", { sessionId: row.id, roomId })
  }
  return orphaned.length
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

/** Delete old messages based on TTL (7 days). `event_log` was merged into
 *  `messages WHERE kind='event'` by migration v8, so the single
 *  `DELETE FROM messages` statement reclaims both direct/broadcast traffic
 *  and journal events. The `reads` table was dropped by migration v9
 *  (km-tribe.delivery-correctness P1.3). */
export function cleanupOldData(ctx: TribeContext): void {
  const SHORT_TTL = 7 * 24 * 60 * 60 * 1000 // 7 days
  const now_ms = Date.now()

  const msgsDel = ctx.db.prepare("DELETE FROM messages WHERE ts < $cutoff").run({ $cutoff: now_ms - SHORT_TTL })
  // Clean dedup keys older than 1 day (they only need to survive the poll race window)
  ctx.stmts.cleanupDedup.run({ $cutoff: now_ms - 24 * 60 * 60 * 1000 })

  if ((msgsDel.changes ?? 0) > 0) {
    log.info?.(`cleanup: ${msgsDel.changes} msgs deleted`)
  }
}
