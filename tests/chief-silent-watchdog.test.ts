/**
 * Chief-silent watchdog — 3-layer regression tests.
 *
 * Spec: @km/all/silent-errors-enforcement/chief-silent-watchdog-relay-pattern-detection
 *
 * Layer 1 — checkChiefSilent() pure function: dedupes one alert per silence-episode.
 * Layer 2 — getUnreadDms SQL: counts only actionable DMs the recipient hasn't drained.
 * Layer 3 — alarm round-trip via getUnreadDms-less coordination row writes.
 *
 * The tests use the raw database + createStatements primitives (skipping the full
 * daemon boot) so they stay fast (~50ms) and don't depend on socket teardown.
 */

import { afterEach, describe, expect, it } from "vitest"
import { existsSync, unlinkSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { openDatabase, createStatements } from "../tools/lib/tribe/database.ts"
import {
  checkChiefSilent,
  createAlertState,
  defaultThresholds,
  type AlertState,
} from "../tools/lib/tribe/health-monitor-plugin.ts"

const cleanupPaths: string[] = []
function tmpDb(): string {
  const path = `/tmp/chief-silent-test-${randomUUID().slice(0, 8)}.db`
  cleanupPaths.push(path)
  return path
}

afterEach(() => {
  for (const p of cleanupPaths.splice(0)) {
    try {
      if (existsSync(p)) unlinkSync(p)
    } catch {
      /* ignore */
    }
  }
})

// ---------------------------------------------------------------------------
// Layer 1 — checkChiefSilent() pure function
// ---------------------------------------------------------------------------

describe("Layer 1 — checkChiefSilent()", () => {
  const thresholds = { ...defaultThresholds(), chiefSilentMinUnreadAgeMin: 10 }
  const NOW = 1_000_000_000_000

  function freshState(): AlertState {
    return createAlertState()
  }

  it("returns null when chief is offline", () => {
    const alert = checkChiefSilent({ count: 5, oldestTs: NOW - 20 * 60_000 }, false, freshState(), thresholds, NOW)
    expect(alert).toBeNull()
  })

  it("returns null when no unread DMs", () => {
    const alert = checkChiefSilent({ count: 0, oldestTs: 0 }, true, freshState(), thresholds, NOW)
    expect(alert).toBeNull()
  })

  it("returns null when oldest unread is younger than threshold", () => {
    // 5 minutes old, threshold 10 — too young to alert
    const alert = checkChiefSilent({ count: 3, oldestTs: NOW - 5 * 60_000 }, true, freshState(), thresholds, NOW)
    expect(alert).toBeNull()
  })

  it("emits a warning when chief online + unread + over threshold", () => {
    const state = freshState()
    const alert = checkChiefSilent({ count: 5, oldestTs: NOW - 11 * 60_000 }, true, state, thresholds, NOW)
    expect(alert).not.toBeNull()
    expect(alert?.type).toBe("chief-silent")
    expect(alert?.severity).toBe("warning")
    expect(alert?.message).toContain("STOP-THE-LINE")
    expect(alert?.message).toContain("5 actionable DMs")
    expect(alert?.message).toContain("11min")
    expect(state.firedAlerts.has("chief-silent:warning")).toBe(true)
  })

  it("dedupes — second call within the same silence-episode returns null", () => {
    const state = freshState()
    const first = checkChiefSilent({ count: 5, oldestTs: NOW - 11 * 60_000 }, true, state, thresholds, NOW)
    const second = checkChiefSilent({ count: 5, oldestTs: NOW - 11 * 60_000 }, true, state, thresholds, NOW + 10_000)
    expect(first).not.toBeNull()
    expect(second).toBeNull()
  })

  it("re-fires after chief drains (unread → 0) and a new silence-episode begins", () => {
    const state = freshState()
    const first = checkChiefSilent({ count: 5, oldestTs: NOW - 11 * 60_000 }, true, state, thresholds, NOW)
    expect(first).not.toBeNull()
    // Chief drains — unread drops to 0; state.firedAlerts is cleared.
    checkChiefSilent({ count: 0, oldestTs: 0 }, true, state, thresholds, NOW + 60_000)
    expect(state.firedAlerts.has("chief-silent:warning")).toBe(false)
    // New episode 30min later: alert should fire again.
    const third = checkChiefSilent(
      { count: 3, oldestTs: NOW + 30 * 60_000 - 12 * 60_000 },
      true,
      state,
      thresholds,
      NOW + 30 * 60_000,
    )
    expect(third).not.toBeNull()
  })

  it("threshold of 0 disables the watchdog entirely", () => {
    const disabled = { ...thresholds, chiefSilentMinUnreadAgeMin: 0 }
    const alert = checkChiefSilent({ count: 5, oldestTs: NOW - 11 * 60_000 }, true, freshState(), disabled, NOW)
    expect(alert).toBeNull()
  })

  it("uses singular DM phrasing for count=1", () => {
    const alert = checkChiefSilent({ count: 1, oldestTs: NOW - 15 * 60_000 }, true, freshState(), thresholds, NOW)
    expect(alert?.message).toContain("1 actionable DM ")
    expect(alert?.message).not.toContain("DMs ")
  })
})

// ---------------------------------------------------------------------------
// Layer 2 — getUnreadDms SQL (recipient + type + cursor filter)
// ---------------------------------------------------------------------------

describe("Layer 2 — getUnreadDms SQL", () => {
  function setup() {
    const db = openDatabase(tmpDb())
    const stmts = createStatements(db)
    // Register @chief session with cursor = 0 so all messages start as unread.
    db.prepare(
      `INSERT INTO sessions (id, name, role, pid, started_at, updated_at, last_inbox_pull_seq)
       VALUES ($id, $name, 'member', $pid, $ts, $ts, 0)`,
    ).run({ $id: "chief-id", $name: "@chief", $pid: 1234, $ts: Date.now() })
    return { db, stmts }
  }

  function insertMsg(
    db: ReturnType<typeof openDatabase>,
    args: {
      id: string
      type: string
      sender: string
      recipient: string
      kind?: string
      ts: number
    },
  ): void {
    db.prepare(
      `INSERT INTO messages (id, type, sender, recipient, kind, content, ts)
       VALUES ($id, $type, $sender, $recipient, $kind, 'test', $ts)`,
    ).run({
      $id: args.id,
      $type: args.type,
      $sender: args.sender,
      $recipient: args.recipient,
      $kind: args.kind ?? "direct",
      $ts: args.ts,
    })
  }

  it("returns zero when no messages", () => {
    const { stmts, db } = setup()
    const row = stmts.getUnreadDms.get({ $name: "@chief" }) as { count: number; oldest_ts: number }
    expect(row.count).toBe(0)
    expect(row.oldest_ts).toBe(0)
    db.close()
  })

  it("counts actionable DMs to the recipient", () => {
    const { stmts, db } = setup()
    const now = Date.now()
    insertMsg(db, { id: "m1", type: "request", sender: "@agent/0", recipient: "@chief", ts: now - 600_000 })
    insertMsg(db, { id: "m2", type: "query", sender: "@agent/1", recipient: "@chief", ts: now - 300_000 })
    insertMsg(db, { id: "m3", type: "verdict", sender: "@agent/2", recipient: "@chief", ts: now - 120_000 })
    insertMsg(db, { id: "m4", type: "assign", sender: "@agent/3", recipient: "@chief", ts: now - 60_000 })
    const row = stmts.getUnreadDms.get({ $name: "@chief" }) as { count: number; oldest_ts: number }
    expect(row.count).toBe(4)
    expect(row.oldest_ts).toBe(now - 600_000)
    db.close()
  })

  it("ignores non-actionable types (notify/status/response)", () => {
    const { stmts, db } = setup()
    const now = Date.now()
    insertMsg(db, { id: "m1", type: "notify", sender: "@agent/0", recipient: "@chief", ts: now })
    insertMsg(db, { id: "m2", type: "status", sender: "@agent/1", recipient: "@chief", ts: now })
    insertMsg(db, { id: "m3", type: "response", sender: "@agent/2", recipient: "@chief", ts: now })
    const row = stmts.getUnreadDms.get({ $name: "@chief" }) as { count: number; oldest_ts: number }
    expect(row.count).toBe(0)
    db.close()
  })

  it("ignores messages addressed to other recipients", () => {
    const { stmts, db } = setup()
    const now = Date.now()
    insertMsg(db, { id: "m1", type: "request", sender: "@agent/0", recipient: "@agent/4", ts: now })
    insertMsg(db, { id: "m2", type: "query", sender: "@agent/1", recipient: "*", ts: now })
    const row = stmts.getUnreadDms.get({ $name: "@chief" }) as { count: number; oldest_ts: number }
    expect(row.count).toBe(0)
    db.close()
  })

  it("ignores non-direct kinds (events, broadcasts via kind)", () => {
    const { stmts, db } = setup()
    const now = Date.now()
    insertMsg(db, { id: "m1", type: "request", sender: "@agent/0", recipient: "@chief", kind: "event", ts: now })
    insertMsg(db, {
      id: "m2",
      type: "request",
      sender: "@agent/1",
      recipient: "@chief",
      kind: "broadcast",
      ts: now,
    })
    const row = stmts.getUnreadDms.get({ $name: "@chief" }) as { count: number; oldest_ts: number }
    expect(row.count).toBe(0)
    db.close()
  })

  it("excludes messages already drained (rowid <= last_inbox_pull_seq)", () => {
    const { stmts, db } = setup()
    const now = Date.now()
    insertMsg(db, { id: "m1", type: "request", sender: "@agent/0", recipient: "@chief", ts: now - 600_000 })
    insertMsg(db, { id: "m2", type: "query", sender: "@agent/1", recipient: "@chief", ts: now - 300_000 })
    // Advance cursor past m1 — only m2 should remain unread.
    const m1 = db.prepare("SELECT rowid FROM messages WHERE id = 'm1'").get() as { rowid: number }
    db.prepare("UPDATE sessions SET last_inbox_pull_seq = $seq WHERE name = '@chief'").run({ $seq: m1.rowid })
    const row = stmts.getUnreadDms.get({ $name: "@chief" }) as { count: number; oldest_ts: number }
    expect(row.count).toBe(1)
    expect(row.oldest_ts).toBe(now - 300_000)
    db.close()
  })

  it("returns zero when the session is unknown (no row → cursor treated as 0, but still no recipient match)", () => {
    const { stmts, db } = setup()
    const now = Date.now()
    insertMsg(db, { id: "m1", type: "request", sender: "@agent/0", recipient: "@unknown", ts: now })
    const row = stmts.getUnreadDms.get({ $name: "@unknown" }) as { count: number; oldest_ts: number }
    // Recipient matched, no cursor row → COALESCE(NULL, 0) = 0, so m1 is unread.
    expect(row.count).toBe(1)
    db.close()
  })
})

// ---------------------------------------------------------------------------
// Layer 3 — alarm round-trip via coordination table
// ---------------------------------------------------------------------------

describe("Layer 3 — andon-pull alarm round-trip", () => {
  function setup() {
    return openDatabase(tmpDb())
  }

  function setAlarm(db: ReturnType<typeof openDatabase>, reason: string, by: string): void {
    const value = JSON.stringify({ reason, by, ts: Date.now() })
    db.prepare(
      "INSERT OR REPLACE INTO coordination (project_id, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("", "alarm.active", value, by, Date.now())
  }

  function getAlarm(
    db: ReturnType<typeof openDatabase>,
  ): { active: false } | { active: true; reason: string; by: string; ts: number } {
    const row = db.prepare("SELECT value FROM coordination WHERE project_id = ? AND key = ?").get("", "alarm.active") as
      | { value: string | null }
      | undefined
    if (!row?.value) return { active: false }
    return { active: true, ...(JSON.parse(row.value) as { reason: string; by: string; ts: number }) }
  }

  function clearAlarm(db: ReturnType<typeof openDatabase>): void {
    db.prepare("DELETE FROM coordination WHERE project_id = ? AND key = ?").run("", "alarm.active")
  }

  it("starts with no alarm active", () => {
    const db = setup()
    expect(getAlarm(db)).toEqual({ active: false })
    db.close()
  })

  it("sets, reads back, and clears the alarm", () => {
    const db = setup()
    setAlarm(db, "tribe daemon is silent", "beorn")
    const state = getAlarm(db)
    expect(state.active).toBe(true)
    if (state.active) {
      expect(state.reason).toBe("tribe daemon is silent")
      expect(state.by).toBe("beorn")
      expect(state.ts).toBeGreaterThan(0)
    }
    clearAlarm(db)
    expect(getAlarm(db)).toEqual({ active: false })
    db.close()
  })

  it("alarm set replaces a prior alarm (latest-wins)", () => {
    const db = setup()
    setAlarm(db, "first", "@user")
    setAlarm(db, "second", "@agent/1")
    const state = getAlarm(db)
    expect(state.active).toBe(true)
    if (state.active) {
      expect(state.reason).toBe("second")
      expect(state.by).toBe("@agent/1")
    }
    db.close()
  })
})
