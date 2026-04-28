/**
 * tribe.filter — unit coverage for the unified filter tool (km-tribe.filter-collapse).
 *
 * tribe.filter({mode?, kinds?, until?}) collapses the previous tribe.mode +
 * tribe.snooze + tribe.dismiss trio into a single tool. Tests cover:
 *
 *   - Persistent mode (focus / normal / ambient) writes filter_mode
 *   - Time-bounded mute (kinds + until) writes filter_kinds + filter_until
 *   - Empty args clear the filter (mode → 'normal', kinds + until → null)
 *   - Validation: rejects invalid mode, negative until, non-string kinds
 *   - Direct DM bypass — only `mode: focus` filters DMs (kinds/until apply
 *     to broadcasts only); coverage at the shouldDeliver call site lives in
 *     tribe-classification-delivery.test.ts (daemon spawn).
 */

import { describe, it, expect, beforeEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"

import { openDatabase, createStatements } from "../tools/lib/tribe/database.ts"
import { createTribeContext } from "../tools/lib/tribe/context.ts"
import { handleToolCall } from "../tools/lib/tribe/handlers.ts"
import type { ActiveSessionInfo, HandlerOpts } from "../tools/lib/tribe/handlers.ts"

function dbFixture() {
  const dir = mkdtempSync(join(tmpdir(), "tribe-filter-"))
  const path = join(dir, "tribe.db")
  const db = openDatabase(path)
  const stmts = createStatements(db)
  return { db, stmts, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function makeOpts(): HandlerOpts {
  return {
    cleanup: () => {},
    userRenamed: false,
    setUserRenamed: () => {},
    getChiefId: () => null,
    getChiefInfo: () => null,
    claimChief: () => {},
    releaseChief: () => {},
    getActiveSessionIds: () => new Set<string>(),
    getActiveSessionInfo: () => [] as ActiveSessionInfo[],
  }
}

function ctxFor(db: ReturnType<typeof openDatabase>, stmts: ReturnType<typeof createStatements>, name: string) {
  const sessionId = randomUUID()
  const now = Date.now()
  db.prepare(
    `INSERT INTO sessions (id, name, role, domains, pid, started_at, updated_at)
     VALUES ($id, $name, 'member', '[]', 0, $now, $now)`,
  ).run({ $id: sessionId, $name: name, $now: now })
  return createTribeContext({
    db,
    stmts,
    sessionId,
    sessionRole: "member",
    initialName: name,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
}

function readFilter(db: ReturnType<typeof openDatabase>, sessionId: string) {
  return db.prepare("SELECT filter_mode, filter_until, filter_kinds FROM sessions WHERE id = ?").get(sessionId) as {
    filter_mode: string
    filter_until: number | null
    filter_kinds: string | null
  }
}

// ---------------------------------------------------------------------------
// 1. Persistent mode
// ---------------------------------------------------------------------------

describe("tribe.filter — persistent mode (focus / normal / ambient)", () => {
  let f: ReturnType<typeof dbFixture>
  beforeEach(() => {
    f = dbFixture()
  })

  it("sets and persists filter_mode = 'focus'", async () => {
    const ctx = ctxFor(f.db, f.stmts, "alice")
    await handleToolCall(ctx, "tribe.filter", { mode: "focus" }, makeOpts())
    const row = readFilter(f.db, ctx.sessionId)
    expect(row.filter_mode).toBe("focus")
    expect(row.filter_until).toBeNull()
    expect(row.filter_kinds).toBeNull()
  })

  it("sets filter_mode = 'ambient' (escape hatch)", async () => {
    const ctx = ctxFor(f.db, f.stmts, "bob")
    await handleToolCall(ctx, "tribe.filter", { mode: "ambient" }, makeOpts())
    const row = readFilter(f.db, ctx.sessionId)
    expect(row.filter_mode).toBe("ambient")
  })

  it("rejects invalid mode", async () => {
    const ctx = ctxFor(f.db, f.stmts, "alice")
    const r = (await handleToolCall(ctx, "tribe.filter", { mode: "screaming" }, makeOpts())) as {
      content: Array<{ type: string; text: string }>
    }
    const parsed = JSON.parse(r.content[0]!.text) as { error?: string }
    expect(parsed.error).toContain("Invalid mode")
  })
})

// ---------------------------------------------------------------------------
// 2. Time-bounded mute (kinds + until)
// ---------------------------------------------------------------------------

describe("tribe.filter — time-bounded mute (kinds + until)", () => {
  let f: ReturnType<typeof dbFixture>
  beforeEach(() => {
    f = dbFixture()
  })

  it("sets filter_until + filter_kinds for kind-scoped mute", async () => {
    const ctx = ctxFor(f.db, f.stmts, "alice")
    const future = Date.now() + 600_000
    await handleToolCall(ctx, "tribe.filter", { kinds: ["github:*"], until: future }, makeOpts())
    const row = readFilter(f.db, ctx.sessionId)
    expect(row.filter_until).toBe(future)
    expect(JSON.parse(row.filter_kinds!)).toEqual(["github:*"])
    // Mode defaults to 'normal' when not specified.
    expect(row.filter_mode).toBe("normal")
  })

  it("kinds without until = persistent kind silence", async () => {
    const ctx = ctxFor(f.db, f.stmts, "alice")
    await handleToolCall(ctx, "tribe.filter", { kinds: ["bead:status", "github:*"] }, makeOpts())
    const row = readFilter(f.db, ctx.sessionId)
    expect(row.filter_until).toBeNull()
    expect(JSON.parse(row.filter_kinds!)).toEqual(["bead:status", "github:*"])
  })

  it("rejects negative until", async () => {
    const ctx = ctxFor(f.db, f.stmts, "alice")
    const r = (await handleToolCall(ctx, "tribe.filter", { until: -1 }, makeOpts())) as {
      content: Array<{ type: string; text: string }>
    }
    const parsed = JSON.parse(r.content[0]!.text) as { error?: string }
    expect(parsed.error).toContain("until")
  })

  it("rejects non-string entries in kinds", async () => {
    const ctx = ctxFor(f.db, f.stmts, "alice")
    const r = (await handleToolCall(ctx, "tribe.filter", { kinds: ["github:*", 7] }, makeOpts())) as {
      content: Array<{ type: string; text: string }>
    }
    const parsed = JSON.parse(r.content[0]!.text) as { error?: string }
    expect(parsed.error).toContain("kinds")
  })
})

// ---------------------------------------------------------------------------
// 3. Empty args clear
// ---------------------------------------------------------------------------

describe("tribe.filter — empty args clear the filter", () => {
  it("clears mode to 'normal' and nullifies kinds + until", async () => {
    const f = dbFixture()
    const ctx = ctxFor(f.db, f.stmts, "alice")
    // First, set a non-trivial filter.
    await handleToolCall(
      ctx,
      "tribe.filter",
      { mode: "focus", kinds: ["bead:status"], until: Date.now() + 60_000 },
      makeOpts(),
    )
    const set = readFilter(f.db, ctx.sessionId)
    expect(set.filter_mode).toBe("focus")
    expect(set.filter_kinds).not.toBeNull()
    expect(set.filter_until).not.toBeNull()

    // Now clear with empty args.
    await handleToolCall(ctx, "tribe.filter", {}, makeOpts())
    const cleared = readFilter(f.db, ctx.sessionId)
    expect(cleared.filter_mode).toBe("normal")
    expect(cleared.filter_kinds).toBeNull()
    expect(cleared.filter_until).toBeNull()
    f.cleanup()
  })
})

// ---------------------------------------------------------------------------
// 4. Combined filter — mode + kinds + until in one call
// ---------------------------------------------------------------------------

describe("tribe.filter — combined mode + kinds + until in one call", () => {
  it("persists all three dimensions atomically", async () => {
    const f = dbFixture()
    const ctx = ctxFor(f.db, f.stmts, "alice")
    const future = Date.now() + 30_000
    await handleToolCall(
      ctx,
      "tribe.filter",
      { mode: "focus", kinds: ["github:*", "bead:status"], until: future },
      makeOpts(),
    )
    const row = readFilter(f.db, ctx.sessionId)
    expect(row.filter_mode).toBe("focus")
    expect(row.filter_until).toBe(future)
    expect(JSON.parse(row.filter_kinds!)).toEqual(["github:*", "bead:status"])
    f.cleanup()
  })
})
