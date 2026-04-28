/**
 * withBroadcast — owns the broadcast pipeline that delivers messages from
 * SQLite (via the messageTap) to connected sockets.
 *
 * Three responsibilities:
 *
 *   1. Per-session delivery filter (focus / normal / ambient + snooze) and
 *      per-client coalescing into batched `<channel>` notifications.
 *   2. Ad-hoc `broadcastNotification(method, params, exclude)` — writes a
 *      JSON-RPC notification to every connected socket (excluding `exclude`).
 *   3. `broadcastLog(msg, type)` — writes daemon warn/error log lines onto
 *      the wire so all sessions see degraded daemon state. The loggily writer
 *      that pipes warn/error log lines through this is also installed here.
 *
 * The broadcast scrubber (regex + optional Haiku rewrite) lives in
 * `broadcast-scrubber.ts` so it stays unit-testable independently of the
 * daemon plumbing.
 *
 * Cleanup: the loggily writer is installed once-per-process via `addWriter`,
 * which has no remove API. We gate it behind a Scope-cleared flag so a
 * disposed scope's writer goes silent. (Survives the hot-reload re-exec because
 * the new process has a fresh module-level `currentBroadcast`.)
 */

import { addWriter, createLogger } from "loggily"
import { type MessageInsertedInfo, type TribeContext } from "../context.ts"
import { activityFromMessage, writeActivity } from "../activity-log.ts"
import { type BeadSnapshot, readBeadSnapshot } from "../bead-snapshot.ts"
import { createCoalescer, type PendingBroadcast } from "../broadcast-coalescer.ts"
import { deriveReplyHint, sendMessage, type ReplyHint } from "../messaging.ts"
import { makeNotification } from "../socket.ts"
import { hasInjectionTrigger, rewriteViaHaiku, scrubInjectionShape } from "../broadcast-scrubber.ts"
import type { BaseTribe } from "./base.ts"
import type { WithClientRegistry } from "./with-client-registry.ts"
import type { WithDaemonContext } from "./with-daemon-context.ts"
import type { WithDatabase } from "./with-database.ts"
import type { WithProjectRoot } from "./with-project-root.ts"

const log = createLogger("tribe:broadcast")

// ---------------------------------------------------------------------------
// Notification-only marker — see comments in tribe-daemon.ts for the full
// rationale. The MCP wrapper only renders source/from/type/message_id by
// default, so the "do not respond" signal must be encoded in the type string.
// ---------------------------------------------------------------------------

const NOTIFICATION_ONLY_MARKER = "notification-only:do-not-acknowledge-or-respond-to"

function isNotificationOnlyType(type: string): boolean {
  if (type === "session" || type === "status" || type === "delta") return true
  if (type.startsWith("chief:")) return true
  if (type.startsWith("github:")) return true
  return false
}

function markedType(type: string): string {
  return isNotificationOnlyType(type) ? `${NOTIFICATION_ONLY_MARKER}:${type}` : type
}

function singleEventNotification(ev: PendingBroadcast): string {
  const params: Record<string, unknown> = {
    from: ev.sender,
    type: markedType(ev.type),
    content: ev.content,
    bead_id: ev.bead_id,
    message_id: ev.id,
    plugin_kind: ev.pluginKind,
  }
  // km-tribe.task-assignment-stale-snapshot: surface fresh bead state +
  // re-issue counter on assign envelopes so the receiver can see current
  // status/title/notes regardless of how stale the chief's in-context cache
  // is. Only attached when both fields are populated by the broadcast
  // pipeline (i.e. type === 'assign' and bead_id is set).
  if (ev.beadState) params.bead_state = ev.beadState
  if (ev.reissueCount !== undefined) params.reissue_count = ev.reissueCount
  return makeNotification("channel", params)
}

function batchedNotification(events: PendingBroadcast[], dropped: number): string {
  const lines = events.map((e) => `[${e.sender}] ${e.type}: ${e.content.replace(/\n/g, " ")}`)
  if (dropped > 0) lines.push(`(+${dropped} more events truncated)`)
  const total = events.length + dropped
  const header = `${total} tribe event${total === 1 ? "" : "s"}`
  const content = `${header}\n${lines.join("\n")}`
  const last = events[events.length - 1]
  return makeNotification("channel", {
    from: "daemon",
    type: markedType("delta"),
    content,
    bead_id: null,
    message_id: last?.id ?? null,
    events_count: total,
    plugin_kind: null,
  })
}

function broadcastBatchMs(): number {
  const raw = process.env.TRIBE_BROADCAST_BATCH_MS
  if (raw === undefined) return 400
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 400
}

// ---------------------------------------------------------------------------
// Per-session delivery filter — unified focus mode + time-bounded mute +
// per-kind glob list (km-tribe.filter-collapse). Reads the filter shape that
// `tribe.filter` writes (sessions.filter_mode/filter_until/filter_kinds).
// ---------------------------------------------------------------------------

type SessionFilter = {
  filter_mode: string
  filter_until: number | null
  filter_kinds: string | null
}

function shouldDeliver(
  info: { replyHint: ReplyHint; pluginKind: string | null },
  filter: SessionFilter | undefined,
): boolean {
  if (!filter) return true // No session row yet — default-allow
  const mode = filter.filter_mode || "normal"
  if (mode === "ambient") return true
  if (mode === "focus") {
    return info.replyHint === "yes"
  }
  // mode === 'normal' — apply the time-bounded mute when active
  const now = Date.now()
  if (!filter.filter_until || filter.filter_until <= now) return true
  const kinds = filter.filter_kinds ? safeJsonArray(filter.filter_kinds) : null
  if (!kinds || kinds.length === 0) return false // mute covers all kinds
  if (!info.pluginKind) return true
  return !kinds.some((g) => globMatch(g, info.pluginKind!))
}

function safeJsonArray(s: string): string[] | null {
  try {
    const parsed = JSON.parse(s)
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) return parsed as string[]
    return null
  } catch {
    return null
  }
}

/** Minimal glob: '*' matches anything within a kind segment. */
function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true
  if (!pattern.includes("*")) return pattern === value
  const re = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$")
  return re.test(value)
}

// ---------------------------------------------------------------------------
// Process-wide loggily writer — installed once at module load, reads the
// active broadcast handle from a swap slot. Hot-reload re-execs the process,
// so the next daemon's broadcast handle replaces the previous one.
// ---------------------------------------------------------------------------

let currentBroadcastLog: ((msg: string, type: string) => void) | null = null

addWriter((formatted, level) => {
  if (level !== "warn" && level !== "error") return
  const fn = currentBroadcastLog
  if (!fn) return
  // Strip ANSI codes and trim for clean tribe messages
  const clean = formatted.replace(/\x1b\[[0-9;]*m/g, "").trim()
  if (clean.length === 0) return
  fn(clean, level === "error" ? "health:daemon:error" : "health:daemon:warn")
})

// ---------------------------------------------------------------------------
// Broadcast capability surface
// ---------------------------------------------------------------------------

export interface Broadcast {
  /** Direct JSON-RPC notification to every connected client (or all-but-one). */
  notify(method: string, params?: Record<string, unknown>, exclude?: string): void
  /** Push a single event to one client (helper for replay/bootstrap). */
  pushToClient(connId: string, method: string, params?: Record<string, unknown>): void
  /** Persist `sessions.last_delivered_{ts,seq}` for a recipient. Idempotent. */
  persistDeliveredCursor(sessionId: string, ts: number, seq: number): void
  /** Synchronous fanout — invoked by the messageTap on every message insert. */
  toConnected(info: MessageInsertedInfo): Promise<void>
  /** Daemon warn/error log line → ambient broadcast on the wire. */
  log(msg: string, type: string): void
  /** Flush + discard a connection's coalescer state on disconnect. */
  flushConnection(connId: string): void
  discardConnection(connId: string): void
  /** The message tap used on daemonCtx — assign to per-client ctx in dispatcher. */
  messageTap: (info: MessageInsertedInfo) => void
}

export interface WithBroadcast {
  readonly broadcast: Broadcast
}

/**
 * withBroadcast — install the broadcast capability on the daemon value and
 * route the daemon's own ctx.onMessageInserted through the activity-log +
 * fanout tap. Must come AFTER withClientRegistry, withDatabase,
 * withDaemonContext, AND withProjectRoot in the pipe — projectRoot is read on
 * every assign-typed delivery to enrich the channel envelope with fresh bead
 * state (see km-tribe.task-assignment-stale-snapshot).
 */
export function withBroadcast<
  T extends BaseTribe & WithDatabase & WithDaemonContext & WithClientRegistry & WithProjectRoot,
>(): (t: T) => T & WithBroadcast {
  return (t) => {
    const { db, stmts, daemonCtx, registry, projectRoot } = t
    const { clients } = registry

    function notify(method: string, params?: Record<string, unknown>, exclude?: string): void {
      const msg = makeNotification(method, params)
      for (const [connId, client] of clients) {
        if (connId === exclude) continue
        try {
          client.socket.write(msg)
        } catch {
          /* dead client — cleaned up on disconnect */
        }
      }
    }

    function pushToClient(connId: string, method: string, params?: Record<string, unknown>): void {
      const client = clients.get(connId)
      if (!client) return
      try {
        client.socket.write(makeNotification(method, params))
      } catch {
        /* dead */
      }
    }

    function persistDeliveredCursor(sessionId: string, ts: number, seq: number): void {
      try {
        stmts.updateLastDelivered.run({ $id: sessionId, $ts: ts, $seq: seq })
      } catch {
        /* best effort — session row may not exist yet (daemon-self, watch-*) */
      }
    }

    const coalescer = createCoalescer({
      batchMs: broadcastBatchMs(),
      maxEventsPerBatch: 50,
      deps: {
        singleEvent: singleEventNotification,
        batched: batchedNotification,
        write(connId, payload) {
          const client = clients.get(connId)
          if (!client) return false
          try {
            client.socket.write(payload)
            return true
          } catch {
            return false
          }
        },
        onDelivered(connId, ev) {
          const client = clients.get(connId)
          if (!client) return
          persistDeliveredCursor(client.ctx.sessionId, ev.ts, ev.rowid)
        },
      },
    })

    async function toConnected(info: MessageInsertedInfo): Promise<void> {
      // Journal-only rows (kind='event') stay durable but are never delivered.
      if (info.kind === "event") return
      // 'pull' rows are inbox-only — durable but not fanned out.
      if (info.delivery === "pull") return

      // Neutralize transcript-shaped triggers. Skip Haiku entirely if the
      // original content has no trigger patterns AND the regex scrub was a
      // no-op — short structured messages don't need paraphrasing.
      const hadTrigger = hasInjectionTrigger(info.content)
      let cleaned = scrubInjectionShape(info.content)
      if (hadTrigger || cleaned !== info.content) {
        cleaned = await rewriteViaHaiku(cleaned)
      }

      // Derive the channel-envelope reply hint from durable metadata
      // (km-tribe.filter-collapse: the response_expected column was dropped).
      // Used only by the `focus` mode of tribe.filter — the wire envelope no
      // longer carries the hint.
      const replyHint = deriveReplyHint({
        kind: info.kind,
        recipient: info.recipient,
        senderRole: info.senderRole,
      })

      // km-tribe.task-assignment-stale-snapshot: enrich assign-typed envelopes
      // with fresh bead state from `.beads/backup/issues.jsonl` and a re-issue
      // counter so receivers don't have to trust the sender's in-context
      // snapshot. Both lookups are best-effort and silently fall back when the
      // bead journal isn't reachable.
      let beadState: BeadSnapshot | null = null
      let reissueCount: number | undefined
      if (info.type === "assign" && info.bead_id) {
        beadState = readBeadSnapshot(info.bead_id, projectRoot)
        try {
          const row = stmts.countPriorAssigns.get({
            $sender: info.sender,
            $recipient: info.recipient,
            $bead_id: info.bead_id,
            $rowid: info.rowid,
          }) as { count: number } | undefined
          // Prior count is exclusive of this message — first delivery → 0,
          // second delivery for the same triple → 1.
          reissueCount = row?.count ?? 0
        } catch {
          /* statement absent (e.g. unmigrated DB) — leave reissueCount undefined */
        }
      }

      const pending: PendingBroadcast = {
        id: info.id,
        ts: info.ts,
        rowid: info.rowid,
        type: info.type,
        sender: info.sender,
        content: cleaned,
        bead_id: info.bead_id,
        replyHint,
        pluginKind: info.pluginKind,
        beadState,
        reissueCount,
      }

      for (const [connId, client] of clients) {
        // Don't echo a message back to its own sender.
        if (client.name === info.sender) continue
        const isWatch = client.role === "watch"
        if (!isWatch) {
          if (info.recipient !== "*" && info.recipient !== client.name) continue
        }
        if (client.role === "pending") continue

        // km-tribe.filter-collapse: per-session unified filter
        // (mode + time-bounded mute + per-kind globs). Direct messages bypass
        // the kinds/until dimensions — only `mode: focus` filters DMs.
        if (info.kind !== "direct" && !isWatch) {
          const sessionFilter = stmts.getSessionFilter.get({ $id: client.ctx.sessionId }) as SessionFilter | undefined
          if (!shouldDeliver({ replyHint, pluginKind: info.pluginKind }, sessionFilter)) continue
        }

        // Direct messages bypass coalescing — they're time-sensitive.
        if (info.kind === "direct") {
          try {
            client.socket.write(singleEventNotification(pending))
            persistDeliveredCursor(client.ctx.sessionId, info.ts, info.rowid)
          } catch {
            /* dead */
          }
          continue
        }

        coalescer.enqueue(connId, pending)
      }
    }

    const broadcastLogFn = (msg: string, type: string): void => {
      sendMessage(daemonCtx, "*", msg, type, undefined, undefined, "broadcast", {
        delivery: "pull",
        pluginKind: type,
      })
    }

    // Install the activity-log + fanout tap on the daemon's ctx so logActivity()
    // and the health-monitor / plugin writers all flow through it.
    const messageTap = (info: MessageInsertedInfo): void => {
      writeActivity(activityFromMessage(info))
      // Fire-and-forget: toConnected is async (Haiku rewrite path is awaited
      // inside). Swallow rejections so a flaky LLM can't kill the tap.
      void toConnected(info).catch(() => {})
    }
    daemonCtx.onMessageInserted = messageTap

    // Wire the process-wide loggily writer to this broadcast's log fn. On
    // scope close (shutdown), reset the slot so the writer goes silent.
    currentBroadcastLog = broadcastLogFn
    t.scope.defer(() => {
      if (currentBroadcastLog === broadcastLogFn) currentBroadcastLog = null
      daemonCtx.onMessageInserted = undefined
    })

    log.info?.("broadcast pipeline ready (coalescer + scrubber + log writer)")

    const broadcast: Broadcast = {
      notify,
      pushToClient,
      persistDeliveredCursor,
      toConnected,
      log: broadcastLogFn,
      flushConnection: (connId) => coalescer.flush(connId),
      discardConnection: (connId) => coalescer.discard(connId),
      messageTap,
    }

    return { ...t, broadcast }
  }
}

// Re-export so callers (tests, surface adapters) can import the message-shape
// helpers directly without reaching into the scrubber module.
export { hasInjectionTrigger, scrubInjectionShape } from "../broadcast-scrubber.ts"
