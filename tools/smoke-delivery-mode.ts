#!/usr/bin/env bun
/**
 * smoke-delivery-mode — bun-runnable smoke test for tribe delivery routing.
 *
 * Covers km-bearly.tribe-dm-delivery-gap-for-mcp-only-clients Option G:
 *
 *   - registerSession persists delivery mode on the session row
 *   - getSessionDeliveryById returns the right mode (broadcast pipeline
 *     reads this to skip socket fanout for pull-mode recipients)
 *   - handleJoin updates delivery in place
 *   - default delivery is 'push' (back-compat invariant)
 *   - tribe.fetch is registered and drains an empty pull-mode queue
 *
 * Runs under bun (real bun:sqlite). Vitest can't host these checks because
 * the repo aliases bun:sqlite to a no-op shim (see plugins/llm/tests/stubs/
 * bun-sqlite.ts) — fine for LLM regression suite, useless for SQL-touching
 * code. Daemon integration tests in tests/tribe-daemon.test.ts use the
 * spawn-a-daemon pattern to side-step the same constraint.
 *
 *   bun tools/smoke-delivery-mode.ts
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase, createStatements } from "./lib/tribe/database.ts"
import { createTribeContext } from "./lib/tribe/context.ts"
import { registerSession } from "./lib/tribe/session.ts"
import { handleToolCall, TRIBE_COORD_METHODS } from "./lib/tribe/handlers.ts"

function makeCtx(delivery?: "push" | "pull", name = "test-session") {
  const dir = mkdtempSync(join(tmpdir(), "tribe-delivery-"))
  const db = openDatabase(join(dir, "tribe.db"))
  const stmts = createStatements(db)
  const sessionId = `id-${name}`
  const ctx = createTribeContext({
    db,
    stmts,
    sessionId,
    sessionRole: "member",
    initialName: name,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
  registerSession(ctx, "test-project", () => false, null, 99999, delivery)
  return { ctx, db, stmts, sessionId, name }
}

const HANDLER_OPTS = {
  cleanup: () => {},
  userRenamed: false,
  setUserRenamed: () => {},
  getChiefId: () => null,
  getChiefInfo: () => null,
  claimChief: () => {},
  releaseChief: () => {},
  getActiveSessionIds: () => new Set<string>(),
  getActiveSessionInfo: () => [],
}

const assertions: Array<{ name: string; ok: boolean; detail?: string }> = []
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = got === want
  assertions.push({
    name,
    ok,
    detail: ok ? undefined : `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`,
  })
}

// 1. default delivery = push
{
  const { db, name } = makeCtx()
  const row = db.prepare("SELECT delivery FROM sessions WHERE name = $name").get({ $name: name }) as {
    delivery: string
  }
  eq("default delivery is push", row.delivery, "push")
}

// 2. registerSession persists pull
{
  const { db, name } = makeCtx("pull")
  const row = db.prepare("SELECT delivery FROM sessions WHERE name = $name").get({ $name: name }) as {
    delivery: string
  }
  eq("registerSession persists pull", row.delivery, "pull")
}

// 3. getSessionDeliveryById routing lookup
{
  const push = makeCtx("push", "claude-r")
  const pull = makeCtx("pull", "codex-r")
  const pushRow = push.stmts.getSessionDeliveryById.get({ $id: push.sessionId }) as { delivery: string }
  const pullRow = pull.stmts.getSessionDeliveryById.get({ $id: pull.sessionId }) as { delivery: string }
  eq("routing lookup push", pushRow.delivery, "push")
  eq("routing lookup pull", pullRow.delivery, "pull")
}

// 4. getSessionDeliveryById returns null/undefined for unknown session
{
  const { stmts } = makeCtx()
  const row = stmts.getSessionDeliveryById.get({ $id: "nonexistent" })
  eq("routing lookup unknown is falsy", row == null, true)
}

// 5. handleJoin transitions push → pull
{
  const { ctx, db, name } = makeCtx("push", "claude-becomes-pull")
  const result = handleToolCall(
    ctx,
    TRIBE_COORD_METHODS.join,
    { name, role: "member", delivery: "pull" },
    HANDLER_OPTS,
  ) as { content: Array<{ text: string }> }
  const parsed = JSON.parse(result.content[0]!.text) as { joined: boolean; delivery: string }
  eq("handleJoin response.delivery=pull", parsed.delivery, "pull")
  const row = db.prepare("SELECT delivery FROM sessions WHERE name = $name").get({ $name: name }) as {
    delivery: string
  }
  eq("handleJoin persists pull", row.delivery, "pull")
}

// 6. handleJoin without delivery preserves existing mode (back-compat)
{
  const { ctx, db, name } = makeCtx("pull", "codex-rejoining")
  const result = handleToolCall(ctx, TRIBE_COORD_METHODS.join, { name, role: "member" }, HANDLER_OPTS) as {
    content: Array<{ text: string }>
  }
  const parsed = JSON.parse(result.content[0]!.text) as { delivery: string }
  eq("rejoin without delivery preserves pull", parsed.delivery, "pull")
  const row = db.prepare("SELECT delivery FROM sessions WHERE name = $name").get({ $name: name }) as {
    delivery: string
  }
  eq("rejoin persists pull", row.delivery, "pull")
}

// 7. tribe.fetch is registered and drains an empty pull-mode queue
{
  const { ctx } = makeCtx("pull", "codex-fetch")
  const result = handleToolCall(ctx, TRIBE_COORD_METHODS.fetch, {}, HANDLER_OPTS) as {
    content: Array<{ text: string }>
  }
  const parsed = JSON.parse(result.content[0]!.text) as { events: unknown[] }
  eq("fetch returns events array", Array.isArray(parsed.events), true)
  eq("fetch fresh session = 0 events", parsed.events.length, 0)
}

const failed = assertions.filter((a) => !a.ok)
for (const a of assertions) {
  process.stdout.write(`${a.ok ? "✓" : "✗"} ${a.name}${a.detail ? ` — ${a.detail}` : ""}\n`)
}
process.stdout.write(`\n${assertions.length - failed.length}/${assertions.length} pass\n`)
if (failed.length > 0) process.exit(1)
