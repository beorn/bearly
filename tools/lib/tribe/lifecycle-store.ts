/**
 * Lifecycle store — in-memory last-write-wins cache for per-session
 * tool-call-lifecycle snapshots.
 *
 * Used by `tribe.lifecycle.publish` (sessions push their latest snapshot
 * after each state transition) and `tribe.lifecycle` (chief / observers
 * pull the latest snapshot for diagnosis). Lives in the daemon process —
 * lost on daemon restart, which is fine: sessions re-publish on the next
 * transition; the store carries diagnostic state, not durable identity.
 *
 * The daemon is intentionally opaque about the snapshot payload — it
 * stores whatever JSON the publisher hands over. The schema is owned by
 * the publishing side (silvercode's ToolCallLifecycle observer, today).
 * Keeping the daemon opaque means new fields can ship without daemon
 * changes, and the same surface works for any future publisher.
 */

export type LifecycleSnapshotRecord = {
  /** Tribe session name (e.g. `@agent/8`). The lookup key. */
  sessionName: string
  /** Daemon-internal session id of the publisher, for tracing. */
  sessionId: string
  /** Wall-clock ms when the daemon received this snapshot. */
  receivedAt: number
  /** Opaque payload — schema owned by the publisher (see module doc). */
  payload: unknown
}

export interface LifecycleStore {
  /** Last-write-wins update. Returns the stored record. */
  set(sessionName: string, sessionId: string, payload: unknown, now: number): LifecycleSnapshotRecord
  /** Latest snapshot for a session name; undefined if none published. */
  get(sessionName: string): LifecycleSnapshotRecord | undefined
  /** Every cached record, sorted by `receivedAt` descending (newest first). */
  list(): LifecycleSnapshotRecord[]
  /** Drop a session's snapshot (used on rename / disconnect). */
  delete(sessionName: string): boolean
  /** Test/admin only — wipe everything. */
  clear(): void
  /** Number of cached records. */
  size(): number
}

export function createLifecycleStore(): LifecycleStore {
  const map = new Map<string, LifecycleSnapshotRecord>()
  return {
    set(sessionName, sessionId, payload, now): LifecycleSnapshotRecord {
      const record: LifecycleSnapshotRecord = { sessionName, sessionId, receivedAt: now, payload }
      map.set(sessionName, record)
      return record
    },
    get(sessionName): LifecycleSnapshotRecord | undefined {
      return map.get(sessionName)
    },
    list(): LifecycleSnapshotRecord[] {
      return [...map.values()].sort((a, b) => b.receivedAt - a.receivedAt)
    },
    delete(sessionName): boolean {
      return map.delete(sessionName)
    },
    clear(): void {
      map.clear()
    },
    size(): number {
      return map.size
    },
  }
}
