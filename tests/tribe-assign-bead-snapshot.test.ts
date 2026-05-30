/**
 * km-tribe.task-assignment-stale-snapshot — when a chief sends `tribe.send`
 * with `type: 'assign'` and `bead: <id>`, the daemon records durable message
 * state and wakes push clients. Clients then drain the row through
 * `tribe.fetch`; the fresh bead snapshot helper remains the source of current
 * `.beads/backup/issues.jsonl` state for fetch/channel consumers.
 *
 * Two layers of coverage:
 *
 *   1. `readBeadSnapshot()` — pure unit tests for the journal-reader helper.
 *   2. `withBroadcast()` end-to-end — feed assign-typed messages through the
 *      composed pipeline with a synthetic client socket and assert wakeup-only
 *      wire notifications plus durable row/counting state.
 */

import { describe, expect, it, afterEach, beforeEach } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { createScope, pipe, withTool, withTools } from "../packages/tribe-client/src/index.ts"
import {
  createBaseTribe,
  messagingTools,
  withBroadcast,
  withClientRegistry,
  withConfig,
  withDaemonContext,
  withDatabase,
  withRecall,
  withProjectRoot,
} from "../tools/lib/tribe/compose/index.ts"
import { sendMessage } from "../tools/lib/tribe/messaging.ts"
import { readBeadSnapshot } from "../tools/lib/tribe/bead-snapshot.ts"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tmpRoots: string[] = []
const tmpFiles: string[] = []

function makeProjectRoot(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "tribe-assign-test-"))
  mkdirSync(resolve(dir, ".beads/backup"), { recursive: true })
  tmpRoots.push(dir)
  return dir
}

function tmpDb(): string {
  const path = `/tmp/tribe-assign-test-${randomUUID().slice(0, 8)}.db`
  tmpFiles.push(path)
  return path
}

function tmpSock(): string {
  const path = `/tmp/tribe-assign-test-${randomUUID().slice(0, 8)}.sock`
  tmpFiles.push(path)
  return path
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  for (const path of tmpFiles.splice(0)) {
    try {
      if (existsSync(path)) unlinkSync(path)
    } catch {
      /* ignore */
    }
  }
})

function writeIssuesJsonl(projectRoot: string, lines: object[]): void {
  const path = resolve(projectRoot, ".beads/backup/issues.jsonl")
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
}

// ---------------------------------------------------------------------------
// readBeadSnapshot — pure unit tests
// ---------------------------------------------------------------------------

describe("readBeadSnapshot", () => {
  it("returns null when the .beads/backup/issues.jsonl file is missing", () => {
    const projectRoot = mkdtempSync(resolve(tmpdir(), "tribe-no-beads-"))
    tmpRoots.push(projectRoot)
    expect(readBeadSnapshot("km-tribe.foo", projectRoot)).toBeNull()
  })

  it("returns null when the bead id is not present in the journal", () => {
    const projectRoot = makeProjectRoot()
    writeIssuesJsonl(projectRoot, [
      { id: "km-tribe.bar", title: "Other bead", status: "open", priority: "2", notes: "" },
    ])
    expect(readBeadSnapshot("km-tribe.foo", projectRoot)).toBeNull()
  })

  it("returns the snapshot for a matching bead id (latest line wins)", () => {
    const projectRoot = makeProjectRoot()
    writeIssuesJsonl(projectRoot, [
      { id: "km-tribe.foo", title: "Old title", status: "open", priority: "2", notes: "first revision" },
      {
        id: "km-tribe.foo",
        title: "Fresh title",
        status: "closed",
        priority: "1",
        notes: "FALSE POSITIVE — work shipped in 0.3.0 (commit abc123)",
        updated_at: "2026-04-28T10:00:00Z",
      },
    ])
    const snap = readBeadSnapshot("km-tribe.foo", projectRoot)
    expect(snap).not.toBeNull()
    expect(snap!.title).toBe("Fresh title")
    expect(snap!.status).toBe("closed")
    expect(snap!.priority).toBe("1")
    expect(snap!.notes_excerpt).toContain("FALSE POSITIVE")
    expect(snap!.notes_truncated).toBe(false)
    expect(snap!.updated_at).toBe("2026-04-28T10:00:00Z")
  })

  it("clips notes longer than the excerpt limit and reports truncation", () => {
    const projectRoot = makeProjectRoot()
    const longNotes = "X".repeat(2000)
    writeIssuesJsonl(projectRoot, [{ id: "km-tribe.foo", title: "T", status: "open", notes: longNotes }])
    const snap = readBeadSnapshot("km-tribe.foo", projectRoot)
    expect(snap).not.toBeNull()
    expect(snap!.notes_excerpt.length).toBeLessThan(longNotes.length)
    expect(snap!.notes_truncated).toBe(true)
  })

  it("survives malformed JSON lines and missing fields", () => {
    const projectRoot = makeProjectRoot()
    const path = resolve(projectRoot, ".beads/backup/issues.jsonl")
    writeFileSync(
      path,
      ["this is not JSON", JSON.stringify({ id: "km-tribe.foo", title: "Real" }), "{not: valid}", ""].join("\n"),
    )
    const snap = readBeadSnapshot("km-tribe.foo", projectRoot)
    expect(snap).not.toBeNull()
    expect(snap!.title).toBe("Real")
    expect(snap!.priority).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// withBroadcast — assign-envelope enrichment
// ---------------------------------------------------------------------------

function bootShape(projectRoot: string, dbPath?: string) {
  return pipe(
    createBaseTribe({ scope: createScope("test") }),
    withConfig({
      override: {
        socketPath: tmpSock(),
        dbPath: dbPath ?? tmpDb(),
        recallDbPath: tmpDb(),
        quitTimeoutSec: -1,
        inheritFd: null,
        focusPollMs: 1000,
        summaryPollMs: 2000,
        summarizerMode: "off" as const,
        recallEnabled: false,
      },
    }),
    withProjectRoot(projectRoot),
    withDatabase(),
    withDaemonContext(),
    withRecall(),
    withTools(),
    withTool(messagingTools()),
    withClientRegistry(),
    withBroadcast(),
  )
}

type CapturedFrame = {
  /** Decoded params object from the JSON-RPC notification line written to the socket. */
  params: Record<string, unknown>
  /** The full notification line (for shape assertions). */
  raw: string
}

function attachFakeReceiver(
  t: ReturnType<typeof bootShape>,
  opts: { name: string; role?: "member" | "watch"; sessionId?: string },
): { frames: CapturedFrame[]; connId: string } {
  const frames: CapturedFrame[] = []
  const connId = `conn-${randomUUID().slice(0, 6)}`
  const sessionId = opts.sessionId ?? `sess-${randomUUID().slice(0, 6)}`
  // Synthesise the session row so the broadcast pipeline can read its filter.
  t.stmts.upsertSession.run({
    $id: sessionId,
    $name: opts.name,
    $role: opts.role ?? "member",
    $domains: "[]",
    $pid: 0,
    $cwd: "/x",
    $project_id: "p",
    $claude_session_id: null,
    $claude_session_name: null,
    $identity_token: null,
    $now: Date.now(),
  })
  // Fake socket: capture every write so we can assert envelope shape.
  const socket = {
    write(payload: string) {
      // Notifications are newline-terminated JSON-RPC lines; strip and parse.
      const trimmed = payload.trimEnd()
      try {
        const parsed = JSON.parse(trimmed) as { params?: Record<string, unknown> }
        frames.push({ params: parsed.params ?? {}, raw: trimmed })
      } catch {
        /* ignore non-JSON */
      }
      return true
    },
  } as unknown as import("node:net").Socket
  t.registry.clients.set(connId, {
    socket,
    id: connId,
    name: opts.name,
    role: opts.role ?? "member",
    domains: [],
    project: "/x",
    projectName: "x",
    projectId: "p",
    pid: 0,
    claudeSessionId: null,
    peerSocket: null,
    conn: "",
    ctx: { ...t.daemonCtx, sessionId },
    registeredAt: Date.now(),
    lastActivityAt: Date.now(),
    recall: { sessionId: null, claudePid: null },
  })
  return { frames, connId }
}

describe("withBroadcast — assign wakeup and durable state", () => {
  it("wakes the receiver for an assign and the fresh bead snapshot is readable", async () => {
    const projectRoot = makeProjectRoot()
    writeIssuesJsonl(projectRoot, [
      // Stale historical row — this is what the chief's snapshot might still
      // reflect.
      { id: "km-tribe.foo", title: "Old title", status: "open", priority: "2", notes: "" },
      // Fresh row — shipped same morning, work is closed, NOTES say so.
      {
        id: "km-tribe.foo",
        title: "Closed: shipped in 0.3.0",
        status: "closed",
        priority: "1",
        notes: "FALSE POSITIVE per claude:abcd on 2026-04-27 (commit c2f454c)",
        updated_at: "2026-04-27T10:00:00Z",
      },
    ])
    const t = bootShape(projectRoot)
    const { frames } = attachFakeReceiver(t, { name: "agent", role: "member" })
    // Sending side — masquerade as chief.
    const senderId = `chief-${randomUUID().slice(0, 6)}`
    t.stmts.upsertSession.run({
      $id: senderId,
      $name: "chief",
      $role: "member",
      $domains: "[]",
      $pid: 0,
      $cwd: "/x",
      $project_id: "p",
      $claude_session_id: null,
      $claude_session_name: null,
      $identity_token: null,
      $now: Date.now(),
    })
    const senderCtx = { ...t.daemonCtx, sessionId: senderId, getName: () => "chief", getRole: () => "member" as const }
    const sent = sendMessage(
      senderCtx as unknown as Parameters<typeof sendMessage>[0],
      "agent",
      "Stale assignment text — chief still thinks the bead is open",
      "assign",
      "km-tribe.foo",
      undefined,
      "direct",
    )
    // Direct messages bypass the coalescer; the write happens synchronously
    // inside the messageTap. Wait one microtask just in case.
    await Promise.resolve()
    expect(frames).toHaveLength(1)
    expect(frames[0]!.params).toMatchObject({
      latest_seq: sent.rowid,
      message_id: sent.id,
      count: 1,
      topic: null,
    })
    const row = t.db.prepare("SELECT type, recipient, bead_id FROM messages WHERE id = ?").get(sent.id) as {
      type: string
      recipient: string
      bead_id: string | null
    }
    expect(row).toEqual({ type: "assign", recipient: "agent", bead_id: "km-tribe.foo" })
    const beadState = readBeadSnapshot("km-tribe.foo", projectRoot)
    expect(beadState, "expected bead_state to be readable for fetch/channel consumers").toBeDefined()
    expect(beadState!.title).toBe("Closed: shipped in 0.3.0")
    expect(beadState!.status).toBe("closed")
    expect(beadState!.priority).toBe("1")
    expect(beadState!.notes_excerpt).toContain("FALSE POSITIVE")
    expect(beadState!.updated_at).toBe("2026-04-27T10:00:00Z")
  })

  it("attaches reissue_count when the same chief→agent→bead assign repeats", async () => {
    const projectRoot = makeProjectRoot()
    writeIssuesJsonl(projectRoot, [
      { id: "km-tribe.foo", title: "Some bead", status: "open", priority: "2", notes: "" },
    ])
    const t = bootShape(projectRoot)
    const { frames } = attachFakeReceiver(t, { name: "agent", role: "member" })
    const senderId = `chief-${randomUUID().slice(0, 6)}`
    t.stmts.upsertSession.run({
      $id: senderId,
      $name: "chief",
      $role: "member",
      $domains: "[]",
      $pid: 0,
      $cwd: "/x",
      $project_id: "p",
      $claude_session_id: null,
      $claude_session_name: null,
      $identity_token: null,
      $now: Date.now(),
    })
    const senderCtx = {
      ...t.daemonCtx,
      sessionId: senderId,
      getName: () => "chief",
      getRole: () => "member" as const,
    }
    // First assign — reissue_count should be 0 (or absent; treat both as "not a reissue").
    const firstSent = sendMessage(
      senderCtx as unknown as Parameters<typeof sendMessage>[0],
      "agent",
      "Initial assignment",
      "assign",
      "km-tribe.foo",
      undefined,
      "direct",
    )
    await Promise.resolve()
    // Second assign for the same bead from the same sender — clear re-issue.
    const secondSent = sendMessage(
      senderCtx as unknown as Parameters<typeof sendMessage>[0],
      "agent",
      "Re-issued assignment (chief ignored evidence)",
      "assign",
      "km-tribe.foo",
      undefined,
      "direct",
    )
    await Promise.resolve()
    expect(frames.map((f) => f.params.message_id)).toEqual([firstSent.id, secondSent.id])
    const first = t.stmts.countPriorAssigns.get({
      $sender: "chief",
      $recipient: "agent",
      $bead_id: "km-tribe.foo",
      $rowid: firstSent.rowid,
    }) as { count: number }
    const second = t.stmts.countPriorAssigns.get({
      $sender: "chief",
      $recipient: "agent",
      $bead_id: "km-tribe.foo",
      $rowid: secondSent.rowid,
    }) as { count: number }
    expect(first.count).toBe(0)
    expect(second.count).toBe(1)
  })

  it("wakeup for non-assign types stays a wakeup summary even when bead_id is set", async () => {
    const projectRoot = makeProjectRoot()
    writeIssuesJsonl(projectRoot, [
      { id: "km-tribe.foo", title: "Some bead", status: "open", priority: "2", notes: "" },
    ])
    const t = bootShape(projectRoot)
    const { frames } = attachFakeReceiver(t, { name: "agent", role: "member" })
    const senderId = `peer-${randomUUID().slice(0, 6)}`
    t.stmts.upsertSession.run({
      $id: senderId,
      $name: "peer",
      $role: "member",
      $domains: "[]",
      $pid: 0,
      $cwd: "/x",
      $project_id: "p",
      $claude_session_id: null,
      $claude_session_name: null,
      $identity_token: null,
      $now: Date.now(),
    })
    const senderCtx = {
      ...t.daemonCtx,
      sessionId: senderId,
      getName: () => "peer",
      getRole: () => "member" as const,
    }
    const sent = sendMessage(
      senderCtx as unknown as Parameters<typeof sendMessage>[0],
      "agent",
      "Hey, look at this bead",
      "notify",
      "km-tribe.foo",
      undefined,
      "direct",
    )
    await Promise.resolve()
    expect(frames).toHaveLength(1)
    expect(frames[0]!.params).toMatchObject({
      latest_seq: sent.rowid,
      message_id: sent.id,
      count: 1,
      topic: null,
    })
  })

  it("omits bead_state when issues.jsonl is missing (no project beads dir)", async () => {
    // Project root WITHOUT a .beads/backup/issues.jsonl file.
    const projectRoot = mkdtempSync(resolve(tmpdir(), "tribe-no-beads-"))
    tmpRoots.push(projectRoot)
    const t = bootShape(projectRoot)
    const { frames } = attachFakeReceiver(t, { name: "agent", role: "member" })
    const senderId = `chief-${randomUUID().slice(0, 6)}`
    t.stmts.upsertSession.run({
      $id: senderId,
      $name: "chief",
      $role: "member",
      $domains: "[]",
      $pid: 0,
      $cwd: "/x",
      $project_id: "p",
      $claude_session_id: null,
      $claude_session_name: null,
      $identity_token: null,
      $now: Date.now(),
    })
    const senderCtx = {
      ...t.daemonCtx,
      sessionId: senderId,
      getName: () => "chief",
      getRole: () => "member" as const,
    }
    const sent = sendMessage(
      senderCtx as unknown as Parameters<typeof sendMessage>[0],
      "agent",
      "Assignment with no bead state to enrich",
      "assign",
      "km-tribe.foo",
      undefined,
      "direct",
    )
    await Promise.resolve()
    expect(frames).toHaveLength(1)
    expect(frames[0]!.params.message_id).toBe(sent.id)
    expect(readBeadSnapshot("km-tribe.foo", projectRoot)).toBeNull()
    const prior = t.stmts.countPriorAssigns.get({
      $sender: "chief",
      $recipient: "agent",
      $bead_id: "km-tribe.foo",
      $rowid: sent.rowid,
    }) as { count: number }
    expect(prior.count).toBe(0)
  })
})
