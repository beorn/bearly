/**
 * tribe API minimal surface — five public verbs, no aliases.
 *
 * Contract from hub/bearly/design/tribe-message-bus.md:
 *   - tribe.send({to, message, ...}) handles DMs and `to: "*"` broadcasts.
 *   - tribe.fetch(...) is the only read surface.
 *   - tribe.members, tribe.filter, tribe.join remain as the other user verbs.
 *   - old verbs are removed, not aliased.
 *   - event classification is `topic`, not `plugin_kind`.
 */

import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"

import { createTribeContext } from "../tools/lib/tribe/context.ts"
import { createStatements, openDatabase } from "../tools/lib/tribe/database.ts"
import {
  handleToolCall,
  TRIBE_COORD_METHODS,
  type ActiveSessionInfo,
  type HandlerOpts,
} from "../tools/lib/tribe/handlers.ts"
import { sendMessage } from "../tools/lib/tribe/messaging.ts"
import { TOOLS_LIST } from "@bearly/tribe-client/lib/tools-list"

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tribe-api-surface-"))
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
    getActiveSessionIds: () => new Set<string>(),
    getActiveSessionInfo: () => [] as ActiveSessionInfo[],
  }
}

function ctxFor(
  db: ReturnType<typeof openDatabase>,
  stmts: ReturnType<typeof createStatements>,
  name: string,
  role: "member" | "daemon" = "member",
) {
  const sessionId = randomUUID()
  const now = Date.now()
  db.prepare(
    `INSERT INTO sessions (id, name, role, domains, pid, started_at, updated_at)
     VALUES ($id, $name, $role, '[]', 0, $now, $now)`,
  ).run({ $id: sessionId, $name: name, $role: role, $now: now })
  return createTribeContext({
    db,
    stmts,
    sessionId,
    sessionRole: role,
    initialName: name,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
}

function parseTool<T>(result: Awaited<ReturnType<typeof handleToolCall>>): T {
  return JSON.parse(result.content[0]!.text) as T
}

describe("tribe API minimal surface", () => {
  it("registers only the public verbs plus admin verbs — no chief verbs (F12)", () => {
    const names = TOOLS_LIST.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        "debug",
        "fetch",
        "filter",
        "health",
        "join",
        "lifecycle",
        "lifecycle.publish",
        "members",
        "pending",
        "reload",
        "rename",
        "retro",
        "send",
      ].sort(),
    )
    // F12 of @km/tribe/15496-coordination-drift — the tribe-wire daemon is
    // role-agnostic; chief coordination verbs were removed entirely.
    expect(names).not.toContain("chief")
    expect(names).not.toContain("claim-chief")
    expect(names).not.toContain("release-chief")
    expect(Object.values(TRIBE_COORD_METHODS)).not.toContain("tribe.chief")
    expect(Object.values(TRIBE_COORD_METHODS)).not.toContain("tribe.claim-chief")
    expect(Object.values(TRIBE_COORD_METHODS)).not.toContain("tribe.release-chief")
    expect(Object.values(TRIBE_COORD_METHODS)).not.toContain("tribe.broadcast")
    expect(Object.values(TRIBE_COORD_METHODS)).not.toContain("tribe.history")
    expect(Object.values(TRIBE_COORD_METHODS)).not.toContain("tribe.inbox")
    expect(Object.values(TRIBE_COORD_METHODS)).not.toContain("tribe.ping")
  })

  it("rejects removed verbs with a migration hint instead of aliasing", async () => {
    const f = fixture()
    const ctx = ctxFor(f.db, f.stmts, "alice")
    for (const method of ["tribe.broadcast", "tribe.history", "tribe.inbox", "tribe.ping", "tribe.read"]) {
      expect(() => handleToolCall(ctx, method, {}, makeOpts())).toThrow(`${method} removed; use send/fetch/filter`)
    }
    f.cleanup()
  })
})

describe("tribe.fetch", () => {
  let f: ReturnType<typeof fixture>
  beforeEach(() => {
    f = fixture()
  })

  it("default drain returns pending rows and advances the pull cursor", async () => {
    const sender = ctxFor(f.db, f.stmts, "daemon", "daemon")
    const reader = ctxFor(f.db, f.stmts, "codex")
    sendMessage(sender, "*", "ambient", "status", undefined, undefined, "broadcast", {
      delivery: "pull",
      topic: "git:commit",
    })
    sendMessage(sender, "codex", "direct", "notify", undefined, undefined, "direct", {
      topic: "chief:query",
    })

    const first = parseTool<{ events: Array<{ content: string; topic: string | null }>; cursor: number }>(
      await handleToolCall(reader, "tribe.fetch", { limit: 50 }, makeOpts()),
    )
    expect(first.events.map((e) => e.content)).toEqual(["ambient", "direct"])
    expect(first.events.map((e) => e.topic)).toEqual(["git:commit", "chief:query"])

    const second = parseTool<{ events: unknown[]; cursor: number }>(
      await handleToolCall(reader, "tribe.fetch", { limit: 50 }, makeOpts()),
    )
    expect(second.events).toHaveLength(0)
    expect(second.cursor).toBe(first.cursor)
  })

  it("supports id fetch, topic scan, and bilateral history without cursor advance", async () => {
    const alice = ctxFor(f.db, f.stmts, "alice")
    const bob = ctxFor(f.db, f.stmts, "bob")
    const ids = [
      sendMessage(alice, "bob", "dm-1", "notify", undefined, undefined, "direct", { topic: "chat:dm" }).id,
      sendMessage(bob, "alice", "dm-2", "notify", undefined, undefined, "direct", { topic: "chat:dm" }).id,
      sendMessage(alice, "*", "github", "status", undefined, undefined, "broadcast", {
        delivery: "pull",
        topic: "github:push",
      }).id,
    ]

    const byId = parseTool<{ events: Array<{ id: string; content: string }> }>(
      await handleToolCall(bob, "tribe.fetch", { ids: [ids[0]] }, makeOpts()),
    )
    expect(byId.events).toMatchObject([{ id: ids[0], content: "dm-1" }])
    const cursorAfterId = f.stmts.getInboxCursor.get({ $id: bob.sessionId }) as { last_inbox_pull_seq: number }
    expect(cursorAfterId.last_inbox_pull_seq).toBe(0)

    const scan = parseTool<{ events: Array<{ content: string; topic: string | null }> }>(
      await handleToolCall(bob, "tribe.fetch", { since: 0, topics: ["github:*"], limit: 50 }, makeOpts()),
    )
    expect(scan.events).toMatchObject([{ content: "github", topic: "github:push" }])
    const cursorAfterScan = f.stmts.getInboxCursor.get({ $id: bob.sessionId }) as { last_inbox_pull_seq: number }
    expect(cursorAfterScan.last_inbox_pull_seq).toBe(0)

    const history = parseTool<{ events: Array<{ content: string }> }>(
      await handleToolCall(alice, "tribe.fetch", { with: "bob", limit: 50 }, makeOpts()),
    )
    expect(history.events.map((e) => e.content)).toEqual(["dm-1", "dm-2"])
  })

  it("snapshot filters select the newest window and display it oldest-to-newest", async () => {
    const alice = ctxFor(f.db, f.stmts, "alice")
    const bob = ctxFor(f.db, f.stmts, "bob")
    const carol = ctxFor(f.db, f.stmts, "carol")

    for (let i = 0; i < 5; i++) {
      sendMessage(alice, "*", `from-alice-${i}`, "notify", undefined, undefined, "broadcast")
    }
    sendMessage(carol, "*", "from-carol", "notify", undefined, undefined, "broadcast")

    const fromAlice = parseTool<{ events: Array<{ content: string }> }>(
      await handleToolCall(bob, "tribe.fetch", { from: "alice", limit: 3 }, makeOpts()),
    )
    expect(fromAlice.events.map((e) => e.content)).toEqual(["from-alice-2", "from-alice-3", "from-alice-4"])

    for (let i = 0; i < 5; i++) {
      sendMessage(alice, "bob", `to-bob-${i}`, "notify", undefined, undefined, "direct")
    }
    sendMessage(alice, "carol", "to-carol", "notify", undefined, undefined, "direct")

    const toBob = parseTool<{ events: Array<{ content: string }> }>(
      await handleToolCall(alice, "tribe.fetch", { to: "bob", limit: 3 }, makeOpts()),
    )
    expect(toBob.events.map((e) => e.content)).toEqual(["to-bob-2", "to-bob-3", "to-bob-4"])

    for (let i = 0; i < 5; i++) {
      sendMessage(i % 2 === 0 ? alice : bob, i % 2 === 0 ? "bob" : "alice", `with-bob-${i}`, "notify")
    }
    sendMessage(carol, "alice", "with-carol", "notify")

    const withBob = parseTool<{ events: Array<{ content: string }> }>(
      await handleToolCall(alice, "tribe.fetch", { with: "bob", limit: 3 }, makeOpts()),
    )
    expect(withBob.events.map((e) => e.content)).toEqual(["with-bob-2", "with-bob-3", "with-bob-4"])
  })
})

describe("tribe topic schema", () => {
  it("uses topic/filter_mute columns and does not create plugin_kind/filter_kinds", () => {
    const f = fixture()
    const messageCols = (f.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map(
      (r) => r.name,
    )
    const sessionCols = (f.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map(
      (r) => r.name,
    )
    expect(messageCols).toContain("topic")
    expect(messageCols).not.toContain("plugin_kind")
    expect(sessionCols).toContain("filter_mute")
    expect(sessionCols).not.toContain("filter_kinds")
    f.cleanup()
  })
})
