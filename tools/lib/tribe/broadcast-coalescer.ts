/**
 * Broadcast coalescer — merges multiple `broadcast`-kind messages to the same
 * recipient within a short window into one MCP notification.
 *
 * Why: each raw `<channel source="plugin:tribe:tribe" …>…</channel>` tag that
 * arrives during a Claude Code turn goes into that turn's context as a
 * system-reminder. Under heavy tribe activity the transcript fills with these
 * tags and the model pattern-matches to "transcript continuation," which
 * amplifies any malformed hook stdout into role-prefix hallucination cascades.
 * Coalescing bursts cuts the number of tags and reduces context saturation.
 *
 * Design:
 *  - Per-connection queue + single flush timer.
 *  - Default window 400ms (override via `batchMs` constructor arg).
 *  - 0 = disabled (enqueue writes through immediately).
 *  - Cap at `maxEventsPerBatch` events per flush; excess is truncated with a
 *    "+N more events truncated" marker so one burst can't itself become
 *    context-saturating.
 *  - Single event out of a burst keeps the original notification shape
 *    (back-compat). N>1 uses a consolidated `type: "delta"` notification.
 *  - Direct messages are NEVER batched — the caller is responsible for
 *    routing direct messages around the coalescer.
 */

export type PendingBroadcast = {
  id: string
  ts: number
  rowid: number
  type: string
  sender: string
  content: string // already scrubbed by caller
  bead_id: string | null
  /** Per-event reply hint derived at delivery time from kind + sender role +
   *  recipient (km-tribe.filter-collapse). Used by the focus-mode filter and
   *  by the batched-broadcast aggregator; not surfaced on the wire. */
  replyHint: "yes" | "no" | "optional"
  /** Originating plugin event id (e.g. `git:commit`); null for human messages. */
  pluginKind: string | null
}

export type Notification = string // pre-serialized JSON-RPC line

export type CoalescerDeps = {
  /** Build a single-event notification in the wire format the caller expects. */
  singleEvent: (ev: PendingBroadcast) => Notification
  /** Build a consolidated notification for N>1 events. */
  batched: (events: PendingBroadcast[], droppedCount: number) => Notification
  /** Write to a live client. Returns false if the write failed (caller usually ignores). */
  write: (connId: string, payload: Notification) => boolean
  /** Advance per-event delivery cursor. Called once per event after a successful write. */
  onDelivered: (connId: string, ev: PendingBroadcast) => void
  /** setTimeout indirection so tests can use fake timers without leaking real ones. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

export type Coalescer = {
  enqueue(connId: string, ev: PendingBroadcast): void
  flush(connId: string): void
  flushAll(): void
  discard(connId: string): void
  pendingCount(connId: string): number
}

type TimerHandle = unknown // platform-varying: NodeJS.Timeout | number | bun TimerID
type Queue = {
  events: PendingBroadcast[]
  timer: TimerHandle | null
}

export function createCoalescer(opts: { batchMs: number; maxEventsPerBatch: number; deps: CoalescerDeps }): Coalescer {
  const { batchMs, maxEventsPerBatch } = opts
  const { singleEvent, batched, write, onDelivered } = opts.deps
  const setTimer: (fn: () => void, ms: number) => unknown = opts.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer: (t: unknown) => void =
    opts.deps.clearTimer ?? ((t) => clearTimeout(t as Parameters<typeof clearTimeout>[0]))
  const queues = new Map<string, Queue>()

  function flushOne(connId: string): void {
    const q = queues.get(connId)
    if (!q) return
    if (q.timer) {
      clearTimer(q.timer)
      q.timer = null
    }
    const events = q.events
    if (events.length === 0) return
    q.events = []

    const kept = events.length > maxEventsPerBatch ? events.slice(0, maxEventsPerBatch) : events
    const dropped = events.length - kept.length

    const payload = kept.length === 1 ? singleEvent(kept[0]!) : batched(kept, dropped)
    const ok = write(connId, payload)
    if (!ok) return
    for (const ev of kept) onDelivered(connId, ev)
  }

  return {
    enqueue(connId, ev) {
      if (batchMs === 0) {
        // Batching disabled — write through immediately, no queue entry.
        const ok = write(connId, singleEvent(ev))
        if (ok) onDelivered(connId, ev)
        return
      }
      let q = queues.get(connId)
      if (!q) {
        q = { events: [], timer: null }
        queues.set(connId, q)
      }
      q.events.push(ev)
      if (!q.timer) {
        q.timer = setTimer(() => flushOne(connId), batchMs)
      }
    },
    flush(connId) {
      flushOne(connId)
    },
    flushAll() {
      for (const connId of queues.keys()) flushOne(connId)
    },
    discard(connId) {
      const q = queues.get(connId)
      if (!q) return
      if (q.timer) clearTimer(q.timer)
      queues.delete(connId)
    },
    pendingCount(connId) {
      return queues.get(connId)?.events.length ?? 0
    },
  }
}
