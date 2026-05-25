/**
 * @km/tribe/fetch-with-recent-default — tribe.fetch defaults for peer-filtered branches.
 *
 * Verifies the spec from `@km/tribe/fetch-with-recent-default`:
 *
 *  (1) `tribe.fetch({with: "@X"})` defaults to 24h newest-first.
 *  (2) `tribe.fetch({with: "@X", all: true})` returns full history.
 *  (3) `tribe.fetch({with: "@X", since: "7d"})` honors duration override.
 *  (4) `tribe.fetch({with: "@X", order: "asc"})` honors order override.
 *  (5) Same defaults apply to `from:` and `to:` branches.
 *  (6) Default-drain `tribe.fetch({limit: 50})` semantics unchanged
 *      (cursor-based rowid scan, ASC, no time-window).
 *  (7) Default-drain rejects duration `since` (rowid semantics, not time).
 *  (8) Invalid `order` / `since` shapes return jsonResult({error}).
 *
 * Pattern 9 fix from coordination retro 2026-05-24.
 */

import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createStatements, openDatabase, type TribeStatements } from "./database.ts"
import { createTribeContext, type TribeContext } from "./context.ts"
import { handleFetch, parseFetchDurationMs } from "./handlers.ts"

interface FetchOk {
  events: Array<{
    id: string
    from: string
    to: string | null
    content: string
    ts: string
    rowid: number
  }>
  cursor: number
}

interface FetchErr {
  error: string
}

function unwrap(result: { content: Array<{ type: string; text: string }> }): FetchOk | FetchErr {
  return JSON.parse(result.content[0]!.text) as FetchOk | FetchErr
}

function isErr(r: FetchOk | FetchErr): r is FetchErr {
  return "error" in r
}

function makeContext(db: Database, stmts: TribeStatements, name: string): TribeContext {
  return createTribeContext({
    db,
    stmts,
    sessionId: `sess-${name}`,
    sessionRole: "member",
    initialName: name,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
}

/** Insert a message with an explicit `ts` so tests can simulate stale history. */
function insertAt(
  stmts: TribeStatements,
  args: {
    id: string
    sender: string
    recipient: string
    ts: number
    content?: string
    type?: string
  },
): void {
  stmts.insertMessage.run({
    $id: args.id,
    $type: args.type ?? "notify",
    $sender: args.sender,
    $recipient: args.recipient,
    $kind: "direct",
    $content: args.content ?? "msg",
    $bead_id: null,
    $ref: null,
    $ts: args.ts,
    $delivery: "push",
    $topic: null,
    $room_id: null,
    $request: null,
    $reply: null,
  })
}

const NOOP_OPTS = {} as unknown // handleFetch ignores opts

describe("parseFetchDurationMs", () => {
  it("parses common durations", () => {
    expect(parseFetchDurationMs("30s")).toBe(30_000)
    expect(parseFetchDurationMs("5m")).toBe(5 * 60_000)
    expect(parseFetchDurationMs("24h")).toBe(24 * 3_600_000)
    expect(parseFetchDurationMs("7d")).toBe(7 * 86_400_000)
  })

  it("rejects invalid shapes", () => {
    expect(parseFetchDurationMs("")).toBeNull()
    expect(parseFetchDurationMs("24")).toBeNull()
    expect(parseFetchDurationMs("h")).toBeNull()
    expect(parseFetchDurationMs("24x")).toBeNull()
    expect(parseFetchDurationMs("1.5h")).toBeNull()
    expect(parseFetchDurationMs("-1h")).toBeNull()
  })

  it("trims whitespace", () => {
    expect(parseFetchDurationMs("  24h  ")).toBe(24 * 3_600_000)
  })

  it("allows 0", () => {
    expect(parseFetchDurationMs("0s")).toBe(0)
  })
})

describe("handleFetch — peer-filtered defaults (with/from/to)", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements
  let chiefCtx: TribeContext

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fetch-recent-default-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
    chiefCtx = makeContext(db, stmts, "@chief")
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("with: returns newest-first by default", () => {
    const now = Date.now()
    insertAt(stmts, { id: "m1-old", sender: "@chief", recipient: "@agent/8", ts: now - 3 * 3_600_000, content: "old" })
    insertAt(stmts, { id: "m2-mid", sender: "@agent/8", recipient: "@chief", ts: now - 2 * 3_600_000, content: "mid" })
    insertAt(stmts, { id: "m3-new", sender: "@chief", recipient: "@agent/8", ts: now - 60_000, content: "new" })

    const out = unwrap(handleFetch(chiefCtx, { with: "@agent/8" }) as never)
    if (isErr(out)) throw new Error(`unexpected error: ${out.error}`)
    expect(out.events.map((e) => e.content)).toEqual(["new", "mid", "old"])
  })

  it("with: defaults to 24h window — excludes older history", () => {
    const now = Date.now()
    insertAt(stmts, {
      id: "stale",
      sender: "@chief",
      recipient: "@agent/8",
      ts: now - 48 * 3_600_000,
      content: "stale",
    })
    insertAt(stmts, { id: "fresh", sender: "@chief", recipient: "@agent/8", ts: now - 60_000, content: "fresh" })

    const out = unwrap(handleFetch(chiefCtx, { with: "@agent/8" }) as never)
    if (isErr(out)) throw new Error(`unexpected error: ${out.error}`)
    expect(out.events.map((e) => e.content)).toEqual(["fresh"])
  })

  it("with: all=true returns full history (ignores 24h window)", () => {
    const now = Date.now()
    insertAt(stmts, {
      id: "stale",
      sender: "@chief",
      recipient: "@agent/8",
      ts: now - 48 * 3_600_000,
      content: "stale",
    })
    insertAt(stmts, { id: "fresh", sender: "@chief", recipient: "@agent/8", ts: now - 60_000, content: "fresh" })

    const out = unwrap(handleFetch(chiefCtx, { with: "@agent/8", all: true }) as never)
    if (isErr(out)) throw new Error(`unexpected error: ${out.error}`)
    expect(out.events.map((e) => e.content).sort()).toEqual(["fresh", "stale"])
  })

  it("with: since='7d' honors duration override", () => {
    const now = Date.now()
    insertAt(stmts, {
      id: "old10d",
      sender: "@chief",
      recipient: "@agent/8",
      ts: now - 10 * 86_400_000,
      content: "old10d",
    })
    insertAt(stmts, {
      id: "mid5d",
      sender: "@chief",
      recipient: "@agent/8",
      ts: now - 5 * 86_400_000,
      content: "mid5d",
    })
    insertAt(stmts, { id: "fresh", sender: "@chief", recipient: "@agent/8", ts: now - 60_000, content: "fresh" })

    const out = unwrap(handleFetch(chiefCtx, { with: "@agent/8", since: "7d" }) as never)
    if (isErr(out)) throw new Error(`unexpected error: ${out.error}`)
    expect(out.events.map((e) => e.content).sort()).toEqual(["fresh", "mid5d"])
  })

  it("with: explicit epoch-ms since honored", () => {
    const now = Date.now()
    insertAt(stmts, { id: "before", sender: "@chief", recipient: "@agent/8", ts: now - 10_000, content: "before" })
    insertAt(stmts, { id: "after", sender: "@chief", recipient: "@agent/8", ts: now - 1_000, content: "after" })

    const out = unwrap(handleFetch(chiefCtx, { with: "@agent/8", since: now - 5_000 }) as never)
    if (isErr(out)) throw new Error(`unexpected error: ${out.error}`)
    expect(out.events.map((e) => e.content)).toEqual(["after"])
  })

  it("with: order='asc' returns oldest-first", () => {
    const now = Date.now()
    insertAt(stmts, { id: "first", sender: "@chief", recipient: "@agent/8", ts: now - 3 * 3_600_000, content: "first" })
    insertAt(stmts, {
      id: "second",
      sender: "@chief",
      recipient: "@agent/8",
      ts: now - 2 * 3_600_000,
      content: "second",
    })
    insertAt(stmts, { id: "third", sender: "@chief", recipient: "@agent/8", ts: now - 60_000, content: "third" })

    const out = unwrap(handleFetch(chiefCtx, { with: "@agent/8", order: "asc" }) as never)
    if (isErr(out)) throw new Error(`unexpected error: ${out.error}`)
    expect(out.events.map((e) => e.content)).toEqual(["first", "second", "third"])
  })

  it("from: defaults to 24h newest-first (same treatment as with:)", () => {
    const now = Date.now()
    insertAt(stmts, {
      id: "stale",
      sender: "@chief",
      recipient: "@agent/8",
      ts: now - 48 * 3_600_000,
      content: "stale",
    })
    insertAt(stmts, {
      id: "fresh-new",
      sender: "@chief",
      recipient: "@agent/8",
      ts: now - 60_000,
      content: "fresh-new",
    })
    insertAt(stmts, {
      id: "fresh-mid",
      sender: "@chief",
      recipient: "@agent/8",
      ts: now - 2 * 3_600_000,
      content: "fresh-mid",
    })
    const a8 = makeContext(db, stmts, "@agent/8")
    const out = unwrap(handleFetch(a8, { from: "@chief" }) as never)
    if (isErr(out)) throw new Error(`unexpected error: ${out.error}`)
    expect(out.events.map((e) => e.content)).toEqual(["fresh-new", "fresh-mid"])
  })

  it("to: defaults to 24h newest-first (same treatment as with:)", () => {
    const now = Date.now()
    insertAt(stmts, {
      id: "stale",
      sender: "@chief",
      recipient: "@agent/8",
      ts: now - 48 * 3_600_000,
      content: "stale",
    })
    insertAt(stmts, { id: "fresh", sender: "@chief", recipient: "@agent/8", ts: now - 60_000, content: "fresh" })
    const out = unwrap(handleFetch(chiefCtx, { to: "@agent/8" }) as never)
    if (isErr(out)) throw new Error(`unexpected error: ${out.error}`)
    expect(out.events.map((e) => e.content)).toEqual(["fresh"])
  })

  it("with: respects limit even with all=true", () => {
    const now = Date.now()
    for (let i = 0; i < 10; i++) {
      insertAt(stmts, { id: `m${i}`, sender: "@chief", recipient: "@agent/8", ts: now - i * 60_000, content: `m${i}` })
    }
    const out = unwrap(handleFetch(chiefCtx, { with: "@agent/8", all: true, limit: 3 }) as never)
    if (isErr(out)) throw new Error(`unexpected error: ${out.error}`)
    expect(out.events).toHaveLength(3)
    // Default order is desc → newest 3 → m0, m1, m2 (since m0 is now-0 = newest)
    expect(out.events.map((e) => e.content)).toEqual(["m0", "m1", "m2"])
  })
})

describe("handleFetch — default-drain branch (unchanged)", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements
  let a8Ctx: TribeContext

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fetch-default-drain-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
    a8Ctx = makeContext(db, stmts, "@agent/8")
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("default-drain returns rows ASC by rowid (legacy unchanged)", () => {
    const now = Date.now()
    insertAt(stmts, { id: "a", sender: "@chief", recipient: "@agent/8", ts: now - 3_600_000, content: "a" })
    insertAt(stmts, { id: "b", sender: "@chief", recipient: "@agent/8", ts: now - 60_000, content: "b" })
    insertAt(stmts, { id: "c", sender: "@chief", recipient: "@agent/8", ts: now - 30_000, content: "c" })

    const out = unwrap(handleFetch(a8Ctx, {}) as never)
    if (isErr(out)) throw new Error(`unexpected error: ${out.error}`)
    expect(out.events.map((e) => e.content)).toEqual(["a", "b", "c"])
  })

  it("default-drain returns ALL history (no 24h window) — stale msgs still drained", () => {
    const now = Date.now()
    insertAt(stmts, {
      id: "ancient",
      sender: "@chief",
      recipient: "@agent/8",
      ts: now - 30 * 86_400_000,
      content: "ancient",
    })
    insertAt(stmts, { id: "recent", sender: "@chief", recipient: "@agent/8", ts: now - 60_000, content: "recent" })

    const out = unwrap(handleFetch(a8Ctx, {}) as never)
    if (isErr(out)) throw new Error(`unexpected error: ${out.error}`)
    // Default-drain has no time-window — it scans by rowid cursor.
    expect(out.events.map((e) => e.content).sort()).toEqual(["ancient", "recent"])
  })

  it("default-drain rejects duration `since` (rowid semantics, not time)", () => {
    const out = unwrap(handleFetch(a8Ctx, { since: "7d" }) as never)
    expect(isErr(out)).toBe(true)
    if (isErr(out)) {
      expect(out.error).toMatch(/Duration .* with\/from\/to/)
    }
  })

  it("default-drain accepts numeric `since` as rowid cursor", () => {
    const now = Date.now()
    insertAt(stmts, { id: "a", sender: "@chief", recipient: "@agent/8", ts: now - 60_000, content: "a" })
    insertAt(stmts, { id: "b", sender: "@chief", recipient: "@agent/8", ts: now - 30_000, content: "b" })

    const out = unwrap(handleFetch(a8Ctx, { since: 0 }) as never)
    if (isErr(out)) throw new Error(`unexpected error: ${out.error}`)
    // Numeric since=0 → scan from start; both rows visible.
    expect(out.events.map((e) => e.content)).toEqual(["a", "b"])
  })
})

describe("handleFetch — validation", () => {
  let tmpDir: string
  let db: Database
  let stmts: TribeStatements
  let ctx: TribeContext

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fetch-validation-"))
    db = openDatabase(join(tmpDir, "tribe.db"))
    stmts = createStatements(db)
    ctx = makeContext(db, stmts, "@chief")
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("rejects invalid order", () => {
    const out = unwrap(handleFetch(ctx, { with: "@x", order: "newest" }) as never)
    expect(isErr(out)).toBe(true)
    if (isErr(out)) expect(out.error).toMatch(/order/)
  })

  it("rejects non-boolean all", () => {
    const out = unwrap(handleFetch(ctx, { with: "@x", all: "yes" }) as never)
    expect(isErr(out)).toBe(true)
    if (isErr(out)) expect(out.error).toMatch(/all/)
  })

  it("rejects malformed duration `since`", () => {
    const out = unwrap(handleFetch(ctx, { with: "@x", since: "later" }) as never)
    expect(isErr(out)).toBe(true)
    if (isErr(out)) expect(out.error).toMatch(/since/)
  })

  it("rejects non-string non-number `since`", () => {
    const out = unwrap(handleFetch(ctx, { with: "@x", since: true }) as never)
    expect(isErr(out)).toBe(true)
    if (isErr(out)) expect(out.error).toMatch(/since/)
  })
})
