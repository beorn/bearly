/**
 * km-tribe.matrix-shape — integration tests for the rooms / room_members
 * tables exercising path.
 *
 * Three groups:
 *   1. registerSession populates room_members for the project's default room.
 *   2. tribe.members handler sources its list from sessions JOIN room_members.
 *   3. The backfillDefaultRoomMembers invariant fixes orphan session rows.
 *
 * Most coverage is in-process (database + handlers + session module directly)
 * to stay fast and deterministic. One end-to-end test spawns a daemon, writes
 * to its DB between runs, and confirms backfill on the next boot.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { resolve, dirname } from "node:path"

import { openDatabase, createStatements } from "../tools/lib/tribe/database.ts"
import { createTribeContext } from "../tools/lib/tribe/context.ts"
import {
  registerSession,
  joinDefaultRoom,
  defaultRoomId,
  backfillDefaultRoomMembers,
} from "../tools/lib/tribe/session.ts"
import { handleToolCall } from "../tools/lib/tribe/handlers.ts"
import type { ActiveSessionInfo, HandlerOpts } from "../tools/lib/tribe/handlers.ts"
import { connectToDaemon, type DaemonClient } from "../tools/lib/tribe/socket.ts"

// ---------------------------------------------------------------------------
// In-process fixtures
// ---------------------------------------------------------------------------

function dbFixture() {
  const dir = mkdtempSync(join(tmpdir(), "tribe-rooms-"))
  const path = join(dir, "tribe.db")
  const db = openDatabase(path)
  const stmts = createStatements(db)
  return { db, stmts, path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function ctxFor(
  db: ReturnType<typeof openDatabase>,
  stmts: ReturnType<typeof createStatements>,
  name: string,
  role = "member",
) {
  return createTribeContext({
    db,
    stmts,
    sessionId: randomUUID(),
    sessionRole: role as "member" | "chief" | "watch" | "pending",
    initialName: name,
    domains: [],
    claudeSessionId: null,
    claudeSessionName: null,
  })
}

function makeOpts(activeIds: Set<string>): HandlerOpts {
  return {
    cleanup: () => {},
    userRenamed: false,
    setUserRenamed: () => {},
    getChiefId: () => null,
    getChiefInfo: () => null,
    claimChief: () => {},
    releaseChief: () => {},
    getActiveSessionIds: () => activeIds,
    getActiveSessionInfo: () => [] as ActiveSessionInfo[],
  }
}

function countRoomMembers(db: ReturnType<typeof openDatabase>, sessionId?: string): number {
  if (sessionId) {
    return (db.prepare("SELECT COUNT(*) AS n FROM room_members WHERE session_id = ?").get(sessionId) as { n: number }).n
  }
  return (db.prepare("SELECT COUNT(*) AS n FROM room_members").get() as { n: number }).n
}

function countRooms(db: ReturnType<typeof openDatabase>): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM rooms").get() as { n: number }).n
}

// ---------------------------------------------------------------------------
// 1. registerSession + joinDefaultRoom
// ---------------------------------------------------------------------------

describe("registerSession populates room_members", () => {
  let f: ReturnType<typeof dbFixture>
  beforeEach(() => {
    f = dbFixture()
  })
  afterEach(() => f.cleanup())

  it("inserts a rooms row + room_members row for a session with a project_id", () => {
    const ctx = ctxFor(f.db, f.stmts, "alpha")
    registerSession(ctx, "myproject")

    const room = f.db.prepare("SELECT id, project_id, name FROM rooms").get() as {
      id: string
      project_id: string | null
      name: string
    } | null
    expect(room).toEqual({ id: "room:myproject", project_id: "myproject", name: "myproject" })

    const member = f.db
      .prepare("SELECT room_id, session_id, role FROM room_members WHERE session_id = ?")
      .get(ctx.sessionId) as { room_id: string; session_id: string; role: string } | null
    expect(member).toEqual({ room_id: "room:myproject", session_id: ctx.sessionId, role: "member" })
  })

  it("inserts into 'room:default' for a session without a project_id", () => {
    const ctx = ctxFor(f.db, f.stmts, "alpha")
    registerSession(ctx)
    const room = f.db.prepare("SELECT id, project_id FROM rooms WHERE id = 'room:default'").get() as {
      id: string
      project_id: string | null
    } | null
    expect(room?.id).toBe("room:default")
    expect(room?.project_id).toBeNull()
    expect(countRoomMembers(f.db, ctx.sessionId)).toBe(1)
  })

  it("is idempotent — re-registering the same session does not duplicate", () => {
    const ctx = ctxFor(f.db, f.stmts, "alpha")
    registerSession(ctx, "p")
    registerSession(ctx, "p")
    registerSession(ctx, "p")
    expect(countRooms(f.db)).toBe(1)
    expect(countRoomMembers(f.db, ctx.sessionId)).toBe(1)
  })

  it("two sessions in the same project share a room with two member rows", () => {
    const a = ctxFor(f.db, f.stmts, "alpha")
    const b = ctxFor(f.db, f.stmts, "beta")
    registerSession(a, "p")
    registerSession(b, "p")
    expect(countRooms(f.db)).toBe(1)
    expect(countRoomMembers(f.db)).toBe(2)
  })

  it("defaultRoomId formats predictably", () => {
    expect(defaultRoomId(null)).toBe("room:default")
    expect(defaultRoomId("foo")).toBe("room:foo")
  })

  it("joinDefaultRoom is callable independently and idempotent", () => {
    const ctx = ctxFor(f.db, f.stmts, "alpha")
    // No registerSession — directly insert sessions row + call joinDefaultRoom.
    f.stmts.upsertSession.run({
      $id: ctx.sessionId,
      $name: ctx.getName(),
      $role: ctx.sessionRole,
      $domains: "[]",
      $pid: 0,
      $cwd: null,
      $project_id: "manual",
      $claude_session_id: null,
      $claude_session_name: null,
      $identity_token: null,
      $now: Date.now(),
    } as never)
    joinDefaultRoom(ctx, "manual", ctx.sessionRole, Date.now())
    joinDefaultRoom(ctx, "manual", ctx.sessionRole, Date.now())
    expect(countRoomMembers(f.db, ctx.sessionId)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 2. tribe.members handler queries room_members
// ---------------------------------------------------------------------------

describe("tribe.members sources from sessions JOIN room_members", () => {
  let f: ReturnType<typeof dbFixture>
  beforeEach(() => {
    f = dbFixture()
  })
  afterEach(() => f.cleanup())

  function callMembers(callerCtx: ReturnType<typeof ctxFor>, opts: HandlerOpts, all = false) {
    const r = handleToolCall(callerCtx, "tribe.members", { all }, opts)
    if (r instanceof Promise) throw new Error("expected sync result")
    const text = (r.content as Array<{ type: string; text: string }>)[0]!.text
    return JSON.parse(text) as { sessions: Array<Record<string, unknown>> }
  }

  it("returns sessions that are room members AND currently connected", () => {
    const a = ctxFor(f.db, f.stmts, "alpha")
    const b = ctxFor(f.db, f.stmts, "beta")
    registerSession(a, "p")
    registerSession(b, "p")
    const opts = makeOpts(new Set([a.sessionId, b.sessionId]))
    const result = callMembers(a, opts)
    const names = result.sessions.map((s) => s.name).sort()
    expect(names).toEqual(["alpha", "beta"])
  })

  it("filters out sessions whose row is not in room_members", () => {
    const a = ctxFor(f.db, f.stmts, "alpha")
    const b = ctxFor(f.db, f.stmts, "beta")
    registerSession(a, "p")
    registerSession(b, "p")
    // Manually delete b from room_members — simulates a row that registered
    // before the matrix-shape invariant existed and never got backfilled.
    f.db.prepare("DELETE FROM room_members WHERE session_id = ?").run(b.sessionId)
    const opts = makeOpts(new Set([a.sessionId, b.sessionId]))
    const result = callMembers(a, opts)
    const names = result.sessions.map((s) => s.name)
    expect(names).toEqual(["alpha"])
    expect(names).not.toContain("beta")
  })

  it("with a.all=true still requires room_members membership", () => {
    const a = ctxFor(f.db, f.stmts, "alpha")
    const b = ctxFor(f.db, f.stmts, "beta")
    registerSession(a, "p")
    registerSession(b, "p")
    // No active ids — `all=true` should still return both because both have
    // room_members rows; the filter is only on the room_members JOIN, not on
    // liveness.
    const opts = makeOpts(new Set<string>())
    const result = callMembers(a, opts, true)
    const names = result.sessions.map((s) => s.name).sort()
    expect(names).toEqual(["alpha", "beta"])
  })

  it("alive flag mirrors the active-id set", () => {
    const a = ctxFor(f.db, f.stmts, "alpha")
    const b = ctxFor(f.db, f.stmts, "beta")
    registerSession(a, "p")
    registerSession(b, "p")
    const opts = makeOpts(new Set([a.sessionId, b.sessionId]))
    const result = callMembers(a, opts, true)
    expect(result.sessions.every((s) => s.alive === true)).toBe(true)
  })

  it("row count in room_members equals active sessions for a fresh project", () => {
    const a = ctxFor(f.db, f.stmts, "alpha")
    const b = ctxFor(f.db, f.stmts, "beta")
    const c = ctxFor(f.db, f.stmts, "gamma")
    registerSession(a, "p")
    registerSession(b, "p")
    registerSession(c, "p")
    expect(countRoomMembers(f.db)).toBe(3)
    expect(countRooms(f.db)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 3. backfillDefaultRoomMembers invariant
// ---------------------------------------------------------------------------

describe("backfillDefaultRoomMembers — startup invariant", () => {
  let f: ReturnType<typeof dbFixture>
  beforeEach(() => {
    f = dbFixture()
    // backfillDefaultRoomMembers logs a warn line per inserted row — it's the
    // designed observability hook for "we found drift and fixed it." Tests
    // that exercise the backfill path expect this output, so we silence it
    // here to keep the test setup's no-console-output guard happy.
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => f.cleanup())

  it("inserts missing rows for sessions that have none", () => {
    const a = ctxFor(f.db, f.stmts, "alpha")
    const b = ctxFor(f.db, f.stmts, "beta")
    registerSession(a, "p")
    registerSession(b, "p")
    // Delete both room_members rows to simulate historic state.
    f.db.run("DELETE FROM room_members")
    expect(countRoomMembers(f.db)).toBe(0)

    const inserted = backfillDefaultRoomMembers(a)
    expect(inserted).toBe(2)
    expect(countRoomMembers(f.db)).toBe(2)
  })

  it("returns 0 when invariant already holds", () => {
    const a = ctxFor(f.db, f.stmts, "alpha")
    registerSession(a, "p")
    expect(backfillDefaultRoomMembers(a)).toBe(0)
  })

  it("inserts the rooms row too if it was missing", () => {
    const a = ctxFor(f.db, f.stmts, "alpha")
    registerSession(a, "p")
    f.db.run("DELETE FROM room_members")
    f.db.run("DELETE FROM rooms")
    expect(countRooms(f.db)).toBe(0)

    backfillDefaultRoomMembers(a)
    expect(countRooms(f.db)).toBe(1)
    expect(countRoomMembers(f.db)).toBe(1)
  })

  it("handles sessions with NULL project_id by routing them to room:default", () => {
    const a = ctxFor(f.db, f.stmts, "alpha")
    registerSession(a) // no project_id
    f.db.run("DELETE FROM room_members")

    backfillDefaultRoomMembers(a)
    const member = f.db.prepare("SELECT room_id FROM room_members WHERE session_id = ?").get(a.sessionId) as {
      room_id: string
    } | null
    expect(member?.room_id).toBe("room:default")
  })

  it("does not duplicate existing rows when invariant partially holds", () => {
    const a = ctxFor(f.db, f.stmts, "alpha")
    const b = ctxFor(f.db, f.stmts, "beta")
    registerSession(a, "p")
    registerSession(b, "p")
    // Delete only b's row.
    f.db.prepare("DELETE FROM room_members WHERE session_id = ?").run(b.sessionId)
    expect(countRoomMembers(f.db)).toBe(1)

    const inserted = backfillDefaultRoomMembers(a)
    expect(inserted).toBe(1)
    expect(countRoomMembers(f.db)).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 4. End-to-end: daemon spawn → kill row → restart → backfill recovers
// ---------------------------------------------------------------------------

const DAEMON_SCRIPT = resolve(dirname(new URL(import.meta.url).pathname), "../tools/tribe-daemon.ts")

function tmpSocketPath(): string {
  return `/tmp/tribe-rooms-test-${randomUUID().slice(0, 8)}.sock`
}

async function waitFor(fn: () => boolean | Promise<boolean>, timeout = 5000, interval = 50): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`waitFor timed out after ${timeout}ms`)
}

async function killDaemon(daemon: ChildProcess): Promise<void> {
  if (daemon.killed) return
  daemon.kill("SIGTERM")
  await new Promise<void>((resolve) => {
    daemon.on("exit", () => resolve())
    setTimeout(() => resolve(), 2000)
  })
}

describe("daemon end-to-end — register, kill row, restart, backfill", () => {
  it("backfills room_members on second startup after manual deletion", async () => {
    const socketPath = tmpSocketPath()
    const dbPath = `/tmp/tribe-rooms-e2e-${randomUUID().slice(0, 8)}.db`
    const clientsToClose: DaemonClient[] = []
    let daemon: ChildProcess | null = null
    try {
      // ---- First boot: register one session, verify room_members has 1 row.
      daemon = spawn(process.execPath, [DAEMON_SCRIPT, "--socket", socketPath, "--quit-timeout", "2"], {
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          TRIBE_DB: dbPath,
          TRIBE_NO_SUPPRESS: "1",
          TRIBE_NO_PLUGINS: "1",
          TRIBE_ACTIVITY_LOG: "off",
        },
      })
      await waitFor(() => existsSync(socketPath), 5000)

      const c1 = await connectToDaemon(socketPath)
      clientsToClose.push(c1)
      await c1.call("register", { name: "rooms-e2e", role: "member", projectId: "e2e" })

      // Open the DB out-of-band to inspect the row.
      const db1 = openDatabase(dbPath)
      const rowsBefore = db1.prepare("SELECT COUNT(*) AS n FROM room_members").get() as { n: number }
      expect(rowsBefore.n).toBeGreaterThanOrEqual(1)
      // Capture the session id so we can target the deletion.
      const session = db1.prepare("SELECT id FROM sessions WHERE name = ?").get("rooms-e2e") as { id: string } | null
      expect(session).not.toBeNull()
      db1.close()

      // ---- Tear down daemon (close client first so socket is clean).
      try {
        c1.close()
      } catch {
        /* ignore */
      }
      clientsToClose.length = 0
      await killDaemon(daemon)
      daemon = null
      if (existsSync(socketPath)) {
        try {
          unlinkSync(socketPath)
        } catch {
          /* ignore */
        }
      }

      // ---- Manually delete the room_members row (simulates schema drift /
      // historic state from before the invariant existed).
      const db2 = openDatabase(dbPath)
      db2.prepare("DELETE FROM room_members WHERE session_id = ?").run(session!.id)
      const rowsAfterDelete = db2
        .prepare("SELECT COUNT(*) AS n FROM room_members WHERE session_id = ?")
        .get(session!.id) as { n: number }
      expect(rowsAfterDelete.n).toBe(0)
      db2.close()

      // ---- Second boot: invariant should backfill.
      daemon = spawn(process.execPath, [DAEMON_SCRIPT, "--socket", socketPath, "--quit-timeout", "2"], {
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          TRIBE_DB: dbPath,
          TRIBE_NO_SUPPRESS: "1",
          TRIBE_NO_PLUGINS: "1",
          TRIBE_ACTIVITY_LOG: "off",
        },
      })
      await waitFor(() => existsSync(socketPath), 5000)
      // Give the daemon a moment to run withRuntime's startup backfill.
      await new Promise((r) => setTimeout(r, 250))

      const db3 = openDatabase(dbPath)
      const rowsAfterRestart = db3
        .prepare("SELECT COUNT(*) AS n FROM room_members WHERE session_id = ?")
        .get(session!.id) as { n: number }
      expect(rowsAfterRestart.n).toBe(1)
      db3.close()
    } finally {
      for (const c of clientsToClose) {
        try {
          c.close()
        } catch {
          /* ignore */
        }
      }
      if (daemon) await killDaemon(daemon)
      if (existsSync(socketPath)) {
        try {
          unlinkSync(socketPath)
        } catch {
          /* ignore */
        }
      }
      if (existsSync(dbPath)) {
        try {
          unlinkSync(dbPath)
        } catch {
          /* ignore */
        }
      }
    }
  }, 20_000)
})
