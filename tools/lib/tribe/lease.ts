/**
 * Tribe leader lease — distributed chief election via SQLite.
 */

import { Database } from "bun:sqlite"

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const LEASE_DURATION_MS = 60_000

export function acquireLease(db: Database, id: string, name: string): boolean {
  const leaseUntil = Date.now() + LEASE_DURATION_MS
  const acquired = Date.now()
  // Try insert first (no leader yet)
  try {
    db.run(
      `INSERT INTO leadership (role, holder_id, holder_name, term, lease_until, acquired_at)
       VALUES ('chief', $id, $name, 1, $lease_until, $acquired)`,
      { $id: id, $name: name, $lease_until: leaseUntil, $acquired: acquired },
    )
    return true
  } catch {
    // Row exists — try to take over if expired or renew if same holder
    const result = db.run(
      `UPDATE leadership SET holder_id = $id, holder_name = $name, term = term + 1,
         lease_until = $lease_until, acquired_at = $acquired
       WHERE role = 'chief' AND (lease_until < $now OR holder_id = $id)`,
      { $id: id, $name: name, $lease_until: leaseUntil, $acquired: acquired, $now: Date.now() },
    )
    return result.changes > 0
  }
}

export function isLeaseHolder(db: Database, id: string): boolean {
  const row = db
    .prepare("SELECT holder_id FROM leadership WHERE role = 'chief' AND holder_id = $id AND lease_until > $now")
    .get({ $id: id, $now: Date.now() }) as { holder_id: string } | null
  return !!row
}

export function getLeaseInfo(
  db: Database,
): {
  holder_name: string
  holder_id: string
  term: number
  lease_until: number
  acquired_at: number
} | null {
  return db
    .prepare("SELECT holder_name, holder_id, term, lease_until, acquired_at FROM leadership WHERE role = 'chief'")
    .get() as {
    holder_name: string
    holder_id: string
    term: number
    lease_until: number
    acquired_at: number
  } | null
}
