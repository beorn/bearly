/**
 * tribe.lifecycle.publish + tribe.lifecycle — daemon LifecycleSnapshot cache.
 *
 * S4 of `@km/infra/15630-stuck-agent-observability` — chief introspection
 * for stuck-agent diagnosis. Sessions publish their tool-call-lifecycle
 * snapshot on every state transition; chief / observers query the latest
 * snapshot for any session by name.
 *
 * The daemon is opaque about payload shape (publisher-owned schema).
 * Tests cover:
 *
 *   - publish + read roundtrip for a single session
 *   - last-write-wins semantics (multiple publishes from one session)
 *   - list-all returns every cached snapshot, newest first
 *   - unknown session returns { snapshot: null }
 *   - omitting the lifecycle store accessor (test mode) returns an error
 *   - validation: missing snapshot, non-string session arg
 *   - the lifecycle store interface itself
 */

import { describe, it, expect, beforeEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"

import { openDatabase, createStatements } from "../tools/lib/tribe/database.ts"
import { createTribeContext, type TribeContext } from "../tools/lib/tribe/context.ts"
import { handleToolCall, TRIBE_COORD_METHODS } from "../tools/lib/tribe/handlers.ts"
import type { ActiveSessionInfo, HandlerOpts } from "../tools/lib/tribe/handlers.ts"
import { createLifecycleStore, type LifecycleStore } from "../tools/lib/tribe/lifecycle-store.ts"

function dbFixture() {
  const dir = mkdtempSync(join(tmpdir(), "tribe-lifecycle-"))
  const path = join(dir, "tribe.db")
  const db = openDatabase(path)
  const stmts = createStatements(db)
  return { db, stmts, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function makeOpts(store?: LifecycleStore): HandlerOpts {
  const opts: HandlerOpts = {
    cleanup: () => {},
    userRenamed: false,
    setUserRenamed: () => {},
    getActiveSessionIds: () => new Set<string>(),
    getActiveSessionInfo: () => [] as ActiveSessionInfo[],
  }
  if (store) opts.getLifecycleStore = () => store
  return opts
}

function ctxFor(
  db: ReturnType<typeof openDatabase>,
  stmts: ReturnType<typeof createStatements>,
  name: string,
): TribeContext {
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

/** Parse the jsonResult wire shape into a structured object. */
function readResult(result: ReturnType<typeof handleToolCall>): Record<string, unknown> {
  if (result instanceof Promise) throw new Error("handler returned a Promise — lifecycle handlers are sync")
  const structured = (result as { structuredContent?: unknown }).structuredContent
  if (structured) return structured as Record<string, unknown>
  const content = (result as { content?: Array<{ text?: string }> }).content
  const text = content?.[0]?.text
  if (typeof text !== "string") throw new Error("unexpected ToolResult shape")
  return JSON.parse(text) as Record<string, unknown>
}

describe("LifecycleStore (in-memory)", () => {
  it("set + get roundtrips a snapshot", () => {
    const store = createLifecycleStore()
    const record = store.set("@agent/3", "session-3", { currentState: "running", elapsedMs: 1200 }, 1000)
    expect(record).toMatchObject({ sessionName: "@agent/3", sessionId: "session-3", receivedAt: 1000 })
    expect(store.get("@agent/3")).toEqual(record)
  })

  it("set overwrites prior snapshot (last-write-wins)", () => {
    const store = createLifecycleStore()
    store.set("@agent/3", "session-3", { currentState: "running" }, 1000)
    store.set("@agent/3", "session-3", { currentState: "silent-hang" }, 2000)
    const record = store.get("@agent/3")
    expect(record?.payload).toEqual({ currentState: "silent-hang" })
    expect(record?.receivedAt).toBe(2000)
    expect(store.size()).toBe(1)
  })

  it("list returns records sorted newest first", () => {
    const store = createLifecycleStore()
    store.set("@agent/1", "s1", { x: 1 }, 1000)
    store.set("@agent/2", "s2", { x: 2 }, 3000)
    store.set("@agent/3", "s3", { x: 3 }, 2000)
    expect(store.list().map((r) => r.sessionName)).toEqual(["@agent/2", "@agent/3", "@agent/1"])
  })

  it("delete + clear behave", () => {
    const store = createLifecycleStore()
    store.set("a", "s", { x: 1 }, 1000)
    store.set("b", "s", { x: 1 }, 1000)
    expect(store.delete("a")).toBe(true)
    expect(store.delete("a")).toBe(false)
    expect(store.size()).toBe(1)
    store.clear()
    expect(store.size()).toBe(0)
  })
})

describe("tribe.lifecycle.publish + tribe.lifecycle (handler integration)", () => {
  let db: ReturnType<typeof dbFixture>["db"]
  let stmts: ReturnType<typeof dbFixture>["stmts"]
  let cleanup: () => void
  let store: LifecycleStore

  beforeEach(() => {
    const f = dbFixture()
    db = f.db
    stmts = f.stmts
    cleanup = f.cleanup
    store = createLifecycleStore()
    return () => cleanup()
  })

  it("publish + lifecycle roundtrip for a single session", () => {
    const ctx = ctxFor(db, stmts, "@agent/8")
    const payload = {
      currentState: "running",
      activeTool: "Bash",
      elapsedMs: 4500,
      softDeadlineMs: 120000,
      hardDeadlineMs: 600000,
    }
    const publishRes = readResult(
      handleToolCall(ctx, TRIBE_COORD_METHODS.lifecyclePublish, { snapshot: payload }, makeOpts(store)),
    )
    expect(publishRes).toMatchObject({ published: true, sessionName: "@agent/8" })
    expect(typeof publishRes.receivedAt).toBe("string")

    const queryRes = readResult(
      handleToolCall(ctx, TRIBE_COORD_METHODS.lifecycle, { session: "@agent/8" }, makeOpts(store)),
    )
    expect(queryRes.session).toBe("@agent/8")
    const snapshot = queryRes.snapshot as Record<string, unknown>
    expect(snapshot.sessionName).toBe("@agent/8")
    expect(snapshot.payload).toEqual(payload)
    expect(typeof snapshot.receivedAt).toBe("string")
  })

  it("last-write-wins across multiple publishes from the same session", () => {
    const ctx = ctxFor(db, stmts, "@agent/8")
    handleToolCall(
      ctx,
      TRIBE_COORD_METHODS.lifecyclePublish,
      { snapshot: { currentState: "running" } },
      makeOpts(store),
    )
    handleToolCall(
      ctx,
      TRIBE_COORD_METHODS.lifecyclePublish,
      { snapshot: { currentState: "active-long" } },
      makeOpts(store),
    )
    handleToolCall(
      ctx,
      TRIBE_COORD_METHODS.lifecyclePublish,
      { snapshot: { currentState: "silent-hang" } },
      makeOpts(store),
    )
    const queryRes = readResult(
      handleToolCall(ctx, TRIBE_COORD_METHODS.lifecycle, { session: "@agent/8" }, makeOpts(store)),
    )
    const snapshot = queryRes.snapshot as Record<string, unknown>
    expect((snapshot.payload as Record<string, unknown>).currentState).toBe("silent-hang")
  })

  it("list-all returns every cached snapshot, newest first", () => {
    const a = ctxFor(db, stmts, "@agent/1")
    const b = ctxFor(db, stmts, "@agent/2")
    const c = ctxFor(db, stmts, "@agent/3")
    // Publish in non-deterministic order; verify they come back newest first.
    handleToolCall(a, TRIBE_COORD_METHODS.lifecyclePublish, { snapshot: { idx: 1 } }, makeOpts(store))
    // Small delay so receivedAt timestamps differ deterministically; use a
    // microtask-based sleep that doesn't depend on real time precision.
    store.set("@agent/2", b.sessionId, { idx: 2 }, Date.now() + 1)
    store.set("@agent/3", c.sessionId, { idx: 3 }, Date.now() + 2)

    const queryRes = readResult(handleToolCall(a, TRIBE_COORD_METHODS.lifecycle, {}, makeOpts(store)))
    const list = queryRes.snapshots as Array<Record<string, unknown>>
    expect(list).toHaveLength(3)
    expect(list[0]?.sessionName).toBe("@agent/3")
    expect(list[1]?.sessionName).toBe("@agent/2")
    expect(list[2]?.sessionName).toBe("@agent/1")
  })

  it("unknown session returns snapshot: null", () => {
    const ctx = ctxFor(db, stmts, "@agent/9")
    const queryRes = readResult(
      handleToolCall(ctx, TRIBE_COORD_METHODS.lifecycle, { session: "@agent/never-published" }, makeOpts(store)),
    )
    expect(queryRes).toEqual({ session: "@agent/never-published", snapshot: null })
  })

  it("publish without snapshot field returns error", () => {
    const ctx = ctxFor(db, stmts, "@agent/8")
    const res = readResult(handleToolCall(ctx, TRIBE_COORD_METHODS.lifecyclePublish, {}, makeOpts(store)))
    expect(res.error).toBe("snapshot field is required")
    expect(store.size()).toBe(0)
  })

  it("publish with null snapshot returns error (null is not a payload)", () => {
    const ctx = ctxFor(db, stmts, "@agent/8")
    const res = readResult(
      handleToolCall(ctx, TRIBE_COORD_METHODS.lifecyclePublish, { snapshot: null }, makeOpts(store)),
    )
    expect(res.error).toBe("snapshot field is required")
  })

  it("lifecycle with non-string session arg returns validation error", () => {
    const ctx = ctxFor(db, stmts, "@agent/8")
    const res = readResult(handleToolCall(ctx, TRIBE_COORD_METHODS.lifecycle, { session: 42 }, makeOpts(store)))
    expect(res.error).toBe("session field must be a string when provided")
  })

  it("without lifecycle store accessor (test / smoke mode), both tools return an error", () => {
    const ctx = ctxFor(db, stmts, "@agent/8")
    // makeOpts() with no store omits getLifecycleStore — handlers see
    // opts.getLifecycleStore?.() === undefined.
    const publishRes = readResult(
      handleToolCall(ctx, TRIBE_COORD_METHODS.lifecyclePublish, { snapshot: { x: 1 } }, makeOpts()),
    )
    expect(publishRes.error).toBe("lifecycle store unavailable (daemon required)")
    const queryRes = readResult(handleToolCall(ctx, TRIBE_COORD_METHODS.lifecycle, {}, makeOpts()))
    expect(queryRes.error).toBe("lifecycle store unavailable (daemon required)")
  })

  it("payload is stored verbatim — daemon is opaque about schema", () => {
    const ctx = ctxFor(db, stmts, "@agent/8")
    // Hand the daemon a payload with arbitrary nested shape. It should
    // come back unchanged — the daemon doesn't validate, normalize, or
    // strip anything. Publisher-owned schema.
    const payload = {
      anything: "goes",
      nested: { deep: { value: 42 } },
      array: [1, "two", { three: 3 }],
      booleanField: true,
      nullField: null,
    }
    handleToolCall(ctx, TRIBE_COORD_METHODS.lifecyclePublish, { snapshot: payload }, makeOpts(store))
    const queryRes = readResult(
      handleToolCall(ctx, TRIBE_COORD_METHODS.lifecycle, { session: "@agent/8" }, makeOpts(store)),
    )
    const snapshot = queryRes.snapshot as Record<string, unknown>
    expect(snapshot.payload).toEqual(payload)
  })

  it("two sessions publish independently; each readable by its own name", () => {
    const a = ctxFor(db, stmts, "@agent/4")
    const b = ctxFor(db, stmts, "@agent/8")
    handleToolCall(a, TRIBE_COORD_METHODS.lifecyclePublish, { snapshot: { tool: "Bash" } }, makeOpts(store))
    handleToolCall(b, TRIBE_COORD_METHODS.lifecyclePublish, { snapshot: { tool: "Search" } }, makeOpts(store))
    const queryA = readResult(
      handleToolCall(a, TRIBE_COORD_METHODS.lifecycle, { session: "@agent/4" }, makeOpts(store)),
    )
    const queryB = readResult(
      handleToolCall(b, TRIBE_COORD_METHODS.lifecycle, { session: "@agent/8" }, makeOpts(store)),
    )
    expect((queryA.snapshot as Record<string, unknown>).payload).toEqual({ tool: "Bash" })
    expect((queryB.snapshot as Record<string, unknown>).payload).toEqual({ tool: "Search" })
  })
})
