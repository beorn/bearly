/**
 * tribe.join response carries the notification-semantics primer.
 *
 * Bead: @km/code/15654 (Part 1).
 *
 * Every agent calls `tribe.join` exactly once at startup, so the response
 * payload is the one reliable injection point for the convention text —
 * works for silvercode, raw Claude Code, codex, anything that speaks tribe
 * MCP. The primer teaches:
 *
 *   - notifications (`from: daemon`, broadcasts `to: "*"`) are AMBIENT
 *     awareness only — never act on them.
 *   - direct messages (`to: <self>`) or any `assign` / `query` / `request`
 *     / `verdict` typed message are the ACTIONABLE channel.
 *   - bare `<ack/>` (or `<ack id="..."/>` to correlate) is the canonical
 *     no-action-no-comment reply; silvercode suppresses bare-ack replies
 *     from the chat bubble.
 */

import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { createTribeContext } from "../tools/lib/tribe/context.ts"
import { createStatements, openDatabase } from "../tools/lib/tribe/database.ts"
import {
  handleToolCall,
  TRIBE_COORD_METHODS,
  TRIBE_JOIN_PRIMER,
  type ActiveSessionInfo,
  type HandlerOpts,
} from "../tools/lib/tribe/handlers.ts"

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tribe-join-primer-"))
  const dbPath = join(dir, "tribe.db")
  const db = openDatabase(dbPath)
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

describe("tribe.join response — notification-semantics primer (15654 Part 1)", () => {
  let cleanups: Array<() => void> = []

  afterEach(() => {
    while (cleanups.length > 0) {
      const c = cleanups.pop()
      try {
        c?.()
      } catch {
        // ignore cleanup failures — temp dirs only
      }
    }
  })

  it("returns primer text in the response payload", async () => {
    const f = fixture()
    cleanups.push(f.cleanup)
    const ctx = ctxFor(f.db, f.stmts, "placeholder")

    const result = await handleToolCall(ctx, TRIBE_COORD_METHODS.join, { name: "@agent/0" }, makeOpts())
    const payload = parseTool<{ joined: boolean; primer: string }>(result)

    expect(payload.joined).toBe(true)
    expect(payload.primer).toBe(TRIBE_JOIN_PRIMER)
  })

  it("primer teaches the canonical notification-vs-action distinction", () => {
    // Pin the load-bearing phrases — if these wordings drift, an agent reading
    // the primer may not learn the right discrimination. Sibling agents (codex,
    // claude-code) need consistent language to follow the convention.
    expect(TRIBE_JOIN_PRIMER).toContain("AMBIENT")
    expect(TRIBE_JOIN_PRIMER).toContain("actionable")
    expect(TRIBE_JOIN_PRIMER).toContain("DO NOT act on them")
  })

  it("primer teaches the `<ack/>` reply convention with both bare + id forms", () => {
    expect(TRIBE_JOIN_PRIMER).toContain("<ack/>")
    expect(TRIBE_JOIN_PRIMER).toContain('<ack id="<msgid>"/>')
    expect(TRIBE_JOIN_PRIMER).toContain("silvercode suppresses bare-ack")
  })

  it("primer names the actionable message types explicitly", () => {
    expect(TRIBE_JOIN_PRIMER).toContain("`type: assign`/`query`/`request`/`verdict`")
  })

  it("primer is stable across renames (idempotent join)", async () => {
    const f = fixture()
    cleanups.push(f.cleanup)
    const ctx = ctxFor(f.db, f.stmts, "placeholder")

    const first = parseTool<{ primer: string }>(
      await handleToolCall(ctx, TRIBE_COORD_METHODS.join, { name: "@agent/0" }, makeOpts()),
    )
    const second = parseTool<{ primer: string }>(
      await handleToolCall(ctx, TRIBE_COORD_METHODS.join, { name: "@agent/0" }, makeOpts()),
    )
    expect(second.primer).toBe(first.primer)
  })

  it("primer is present even when the session inherits via identity_token", async () => {
    // Identity-token rejoin path — verify the primer is still attached.
    const f = fixture()
    cleanups.push(f.cleanup)
    const ctx = ctxFor(f.db, f.stmts, "placeholder")

    const result = await handleToolCall(
      ctx,
      TRIBE_COORD_METHODS.join,
      { name: "@agent/5", identity_token: "token-xyz" },
      makeOpts(),
    )
    const payload = parseTool<{ primer: string }>(result)
    expect(payload.primer).toBe(TRIBE_JOIN_PRIMER)
  })
})
