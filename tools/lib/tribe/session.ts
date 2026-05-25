/**
 * Tribe session — registration, delivery offsets, transcript naming, cleanup.
 */

import { createLogger } from "loggily"
import { readTranscriptSlug } from "@bearly/tribe-client/lib/transcript"
import type { TribeContext } from "./context.ts"

const log = createLogger("tribe:session")
import { sendMessage, logEvent } from "./messaging.ts"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a session can't register or rename because the desired name is
 *  held by another active session. `existing_names` enumerates the currently-
 *  connected names so callers can suggest alternatives without an extra
 *  `tribe.sessions` round-trip. `holder_pid` (when known) is the OS PID of
 *  the live process currently holding the name — surfaces actionable info
 *  for spawn-time identity-binding (the user can verify the conflict is a
 *  real second instance, not a stale daemon-side ghost). */
export class NameConflictError extends Error {
  constructor(
    readonly desiredName: string,
    readonly existing_names: string[],
    readonly holder_pid: number | null = null,
  ) {
    super(
      holder_pid != null
        ? `Name "${desiredName}" is already taken by live pid ${holder_pid}`
        : `Name "${desiredName}" is already taken`,
    )
    this.name = "NameConflictError"
  }
}

function listSessionNames(ctx: TribeContext, isActive?: (sessionId: string) => boolean): string[] {
  const rows = ctx.db.prepare("SELECT id, name FROM sessions").all() as Array<{ id: string; name: string }>
  return rows
    .filter((r) => (isActive ? isActive(r.id) : true))
    .map((r) => r.name)
    .sort()
}

/** True iff the given OS PID exists and we have permission to signal it.
 *  Used by spawn-time identity binding to differentiate "zombie session
 *  the daemon thinks is alive but whose owning process is gone" from
 *  "real second instance of the same name". A zero PID means "unknown"
 *  (we don't store PIDs for pre-pid-binding sessions) — be conservative
 *  and treat it as alive so we don't accidentally evict a legitimate
 *  holder whose pid we just don't know about. */
export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

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
  clientPid?: number,
  delivery?: "push" | "pull",
  clientCwd?: string,
  account?: string | null,
  provider?: string | null,
): void {
  const desiredName = ctx.getName()
  const now = Date.now()
  // The client's OS PID is the source of truth for "is this session real?";
  // process.pid here is the DAEMON's PID (we run inside the daemon process).
  // Fall back to 0 (= unknown) if the caller didn't supply one.
  const pid = clientPid && clientPid > 0 ? clientPid : 0

  // If another row holds our desired name, drop it if either (a) its session
  // is NOT currently connected, OR (b) the daemon thinks it's connected but
  // the owning OS PID is actually dead (zombie session — socket-close handler
  // hasn't fired yet, e.g. parent crashed with the socket inherited by a
  // child shell that hasn't exited). PID liveness is the structural fence:
  // L4 of @km/tribe/spawn-time-identity-binding requires that no two live
  // PIDs share a persona at once, but a dead-pid placeholder must yield.
  const holder = ctx.db
    .prepare("SELECT id, pid FROM sessions WHERE name = $name AND id != $id")
    .get({ $name: desiredName, $id: ctx.sessionId }) as { id: string; pid: number } | null
  if (holder) {
    const holderActive = isActive ? isActive(holder.id) : false
    if (!holderActive) {
      ctx.db.prepare("DELETE FROM sessions WHERE id = $id").run({ $id: holder.id })
      log.debug?.(`evicted stale session row holding name "${desiredName}"`)
    } else if (!isPidAlive(holder.pid)) {
      // Daemon's clients map still has this session, but its PID is dead.
      // The socket-close handler will catch up eventually, but spawn-time
      // identity binding can't wait for that. Take over now.
      ctx.db.prepare("DELETE FROM sessions WHERE id = $id").run({ $id: holder.id })
      log.info?.(`evicted zombie session row "${desiredName}" (stored pid ${holder.pid} dead)`)
    }
  }

  // If the name is still taken after eviction attempts, check PID liveness
  // one more time (the holder's socket may linger after process exit). If the
  // holder's PID is genuinely alive, auto-suffix so registration always succeeds.
  let finalName = desiredName
  const takenCheck = ctx.db
    .prepare("SELECT id, pid FROM sessions WHERE name = $name AND id != $id")
    .get({ $name: finalName, $id: ctx.sessionId }) as { id: string; pid: number } | null
  if (takenCheck && isActive?.(takenCheck.id)) {
    // One more PID liveness check — catches the common restart case where
    // the old process exited but the socket-close handler hasn't fired yet.
    if (takenCheck.pid > 0 && !isPidAlive(takenCheck.pid)) {
      ctx.db.prepare("DELETE FROM sessions WHERE id = $id").run({ $id: takenCheck.id })
      log.info?.(`evicted zombie holder "${desiredName}" (pid ${takenCheck.pid} dead) during registration`)
    } else {
      // Genuinely two live sessions want the same name — auto-suffix.
      for (let n = 2; n <= 100; n++) {
        const candidate = `${desiredName}-${n}`
        const taken = ctx.db
          .prepare("SELECT id FROM sessions WHERE name = $name AND id != $id")
          .get({ $name: candidate, $id: ctx.sessionId }) as { id: string } | null
        if (!taken || !isActive(taken.id)) {
          finalName = candidate
          log.info?.(`name "${desiredName}" taken by active session; auto-assigned "${finalName}"`)
          ctx.setName(finalName)
          break
        }
      }
    }
  }

  try {
    ctx.stmts.upsertSession.run({
      $id: ctx.sessionId,
      $name: finalName,
      $role: ctx.sessionRole,
      $domains: JSON.stringify(ctx.domains),
      $pid: pid,
      $cwd: clientCwd || process.cwd(),
      $project_id: projectId ?? null,
      $claude_session_id: ctx.claudeSessionId,
      $claude_session_name: ctx.claudeSessionName,
      $identity_token: identityToken ?? null,
      $now: now,
      $delivery: delivery ?? "push",
      $account: account ?? null,
      $provider: provider ?? null,
    })
  } catch {
    // Shouldn't happen after auto-suffix, but surface as typed error if it does.
    throw new NameConflictError(finalName, listSessionNames(ctx, isActive), holder?.pid ?? null)
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
  // Nothing in the post-event-bus code path reads from `cursors`. Reconnects
  // now reset `sessions.last_delivered_seq`/`last_inbox_pull_seq` to the log
  // tail during registration, so no stale delivery cursor is inherited.
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
// Transcript-based naming — moved to `@bearly/tribe-client/lib/transcript`
// (the pure file-reader half; this file keeps the TribeContext-coupled
// `tryInitialRename` below, which imports the readers from the new home).
// ---------------------------------------------------------------------------

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

/** Archive old messages before trimming the hot log. `event_log` was merged
 *  into `messages WHERE kind='event'` by migration v8, so this retention path
 *  covers both direct/broadcast traffic and journal events. */
export function cleanupOldData(ctx: TribeContext): void {
  const SHORT_TTL = 7 * 24 * 60 * 60 * 1000 // 7 days
  const now_ms = Date.now()
  const cutoff = now_ms - SHORT_TTL

  const archived = ctx.stmts.archiveExpiredMessages.run({ $cutoff: cutoff, $archived_at: now_ms })
  const msgsDel = ctx.stmts.deleteExpiredMessages.run({ $cutoff: cutoff })
  // Clean dedup keys older than 1 day (they only need to survive the poll race window)
  ctx.stmts.cleanupDedup.run({ $cutoff: now_ms - 24 * 60 * 60 * 1000 })

  if ((msgsDel.changes ?? 0) > 0) {
    log.info?.(`cleanup: ${archived.changes ?? 0} msgs archived, ${msgsDel.changes} msgs deleted`)
  }
}
