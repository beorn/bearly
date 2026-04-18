/**
 * Chief auto-promotion — pure function + side-effect wrapper tests.
 * Covers km-tribe.chief-auto-election Layer 2.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Database } from "bun:sqlite"
import {
  CHIEF_PROMOTION_GRACE_MS,
  CHIEF_PROMOTION_HEARTBEAT_MS,
  pickPromotionCandidate,
  tryAutoPromote,
  type PromotionCandidate,
} from "../tools/lib/tribe/chief-promotion.ts"
import { acquireLease, getLeaseInfo } from "../tools/lib/tribe/lease.ts"
import { openDatabase, createStatements } from "../tools/lib/tribe/database.ts"
import { createTribeContext } from "../tools/lib/tribe/context.ts"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { existsSync, unlinkSync } from "node:fs"

// ---------------------------------------------------------------------------
// Pure decision function
// ---------------------------------------------------------------------------

describe("pickPromotionCandidate", () => {
  const NOW = 1_700_000_000_000 // arbitrary fixed "now"

  function candidate(overrides: Partial<PromotionCandidate>): PromotionCandidate {
    return {
      id: "id-" + (overrides.name ?? "c"),
      name: "worker",
      pid: 1000,
      started_at: NOW - 60_000,
      heartbeat: NOW,
      ...overrides,
    }
  }

  test("no lease row → no-lease (never-been-chief)", () => {
    const d = pickPromotionCandidate(null, [candidate({ name: "a" })], NOW)
    expect(d.action).toBe("no-lease")
  })

  test("live lease → lease-live, no promotion", () => {
    const lease = { holder_name: "chief-1", lease_until: NOW + 30_000 }
    const d = pickPromotionCandidate(lease, [candidate({ name: "a" })], NOW)
    expect(d.action).toBe("lease-live")
    if (d.action === "lease-live") expect(d.expiresInMs).toBe(30_000)
  })

  test("expired but within grace → within-grace, no promotion", () => {
    // 2 minutes expired, grace is 5 minutes
    const lease = { holder_name: "chief-1", lease_until: NOW - 2 * 60_000 }
    const d = pickPromotionCandidate(lease, [candidate({ name: "a" })], NOW)
    expect(d.action).toBe("within-grace")
    if (d.action === "within-grace") expect(d.expiredByMs).toBe(2 * 60_000)
  })

  test("past grace with no live candidates → no-candidates", () => {
    const lease = { holder_name: "chief-1", lease_until: NOW - 6 * 60_000 }
    // Heartbeat too stale — session not eligible
    const stale = candidate({ name: "a", heartbeat: NOW - CHIEF_PROMOTION_HEARTBEAT_MS - 1 })
    const d = pickPromotionCandidate(lease, [stale], NOW)
    expect(d.action).toBe("no-candidates")
  })

  test("past grace with live candidates → promote longest-running", () => {
    const lease = { holder_name: "chief-1", lease_until: NOW - 6 * 60_000 }
    const older = candidate({ name: "zed", started_at: NOW - 10 * 60_000 })
    const newer = candidate({ name: "alice", started_at: NOW - 1 * 60_000 })
    const d = pickPromotionCandidate(lease, [newer, older], NOW)
    expect(d.action).toBe("promote")
    if (d.action === "promote") {
      // "zed" wins by longest-running despite alphabetically later.
      expect(d.candidate.name).toBe("zed")
      expect(d.previousHolderName).toBe("chief-1")
      expect(d.expiredByMs).toBe(6 * 60_000)
    }
  })

  test("tie on started_at broken alphabetically", () => {
    const lease = { holder_name: "chief-1", lease_until: NOW - 6 * 60_000 }
    const a = candidate({ name: "zeta", started_at: NOW - 5 * 60_000 })
    const b = candidate({ name: "alpha", started_at: NOW - 5 * 60_000 })
    const d = pickPromotionCandidate(lease, [a, b], NOW)
    expect(d.action).toBe("promote")
    if (d.action === "promote") expect(d.candidate.name).toBe("alpha")
  })

  test("grace boundary: exactly at grace_ms → still within-grace (strict less-than cutoff)", () => {
    const lease = { holder_name: "chief-1", lease_until: NOW - CHIEF_PROMOTION_GRACE_MS }
    const d = pickPromotionCandidate(lease, [candidate({ name: "a" })], NOW)
    expect(d.action).not.toBe("promote")
  })

  test("grace boundary: 1ms past grace → promote", () => {
    const lease = { holder_name: "chief-1", lease_until: NOW - CHIEF_PROMOTION_GRACE_MS - 1 }
    const d = pickPromotionCandidate(lease, [candidate({ name: "a" })], NOW)
    expect(d.action).toBe("promote")
  })
})

// ---------------------------------------------------------------------------
// Side-effect wrapper
// ---------------------------------------------------------------------------

describe("tryAutoPromote", () => {
  let dbPath: string
  let db: Database
  let ctx: ReturnType<typeof createTribeContext>

  beforeEach(() => {
    dbPath = join(tmpdir(), `tribe-chief-promo-${randomUUID()}.db`)
    db = openDatabase(dbPath)
    const stmts = createStatements(db)
    ctx = createTribeContext({
      db,
      stmts,
      sessionId: "daemon-session-id",
      sessionRole: "chief",
      initialName: "daemon",
      domains: [],
      claudeSessionId: null,
      claudeSessionName: null,
    })
  })

  afterEach(() => {
    db.close()
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = dbPath + suffix
      if (existsSync(p)) unlinkSync(p)
    }
  })

  function candidate(overrides: Partial<PromotionCandidate> & { name: string }): PromotionCandidate {
    return {
      id: `id-${overrides.name}`,
      pid: 1000,
      started_at: Date.now() - 60_000,
      heartbeat: Date.now(),
      ...overrides,
    }
  }

  test("no lease row → returns no-lease, does not write", () => {
    const d = tryAutoPromote(db, [candidate({ name: "alice" })], ctx)
    expect(d.action).toBe("no-lease")
    expect(getLeaseInfo(db)).toBeNull()
  })

  test("live lease → no-op", () => {
    acquireLease(db, "some-id", "some-chief")
    const d = tryAutoPromote(db, [candidate({ name: "alice" })], ctx)
    expect(d.action).toBe("lease-live")
  })

  test("expired past grace + candidate → writes new lease + broadcasts", () => {
    // Manually set an expired lease row.
    db.run(
      `INSERT INTO leadership (role, holder_id, holder_name, term, epoch, lease_until, acquired_at)
       VALUES ('chief', 'old-id', 'old-chief', 1, 1, $lease, $acq)`,
      { $lease: Date.now() - 10 * 60_000, $acq: Date.now() - 60 * 60_000 } as never,
    )

    const alice = candidate({
      name: "alice",
      id: "id-alice",
      started_at: Date.now() - 10 * 60_000,
    })
    const d = tryAutoPromote(db, [alice], ctx)
    expect(d.action).toBe("promote")

    // Lease now belongs to alice.
    const info = getLeaseInfo(db)
    expect(info?.holder_name).toBe("alice")
    expect(info?.holder_id).toBe("id-alice")

    // Broadcast message was written with the right type and content shape.
    const msgs = db.prepare("SELECT type, content, recipient FROM messages ORDER BY ts DESC LIMIT 1").all() as Array<{
      type: string
      content: string
      recipient: string
    }>
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.type).toBe("chief:auto-promoted")
    expect(msgs[0]?.recipient).toBe("*")
    expect(msgs[0]?.content).toContain("alice")
    expect(msgs[0]?.content).toContain("old-chief")
  })

  test("second call after promotion is idempotent (renews own lease, does not re-broadcast)", () => {
    // Seed expired lease.
    db.run(
      `INSERT INTO leadership (role, holder_id, holder_name, term, epoch, lease_until, acquired_at)
       VALUES ('chief', 'old-id', 'old-chief', 1, 1, $lease, $acq)`,
      { $lease: Date.now() - 10 * 60_000, $acq: Date.now() - 60 * 60_000 } as never,
    )
    const alice = candidate({ name: "alice", id: "id-alice", started_at: Date.now() - 10 * 60_000 })
    tryAutoPromote(db, [alice], ctx)

    // Second call: lease now live (alice just took it). Should be lease-live, no new broadcast.
    const d2 = tryAutoPromote(db, [alice], ctx)
    expect(d2.action).toBe("lease-live")

    const msgCount = (db.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }).c
    expect(msgCount).toBe(1) // just the one from the first call
  })
})
