/**
 * km-tribe.task-assignment-stale-snapshot — when a chief sends `tribe.send`
 * with `type: 'assign'` and `bead: <id>`, the daemon must enrich the channel
 * envelope at delivery time with fresh bead state read from
 * `.beads/backup/issues.jsonl`. This stops the chief's stale in-context
 * snapshot from forcing the receiver into the A/B/C escalation protocol when
 * the bead is already closed or its premises are documented as false.
 *
 * Two layers of coverage:
 *
 *   1. `readBeadSnapshot()` — pure unit tests for the journal-reader helper.
 *   2. `withBroadcast()` end-to-end — feed an assign-typed message through the
 *      composed pipeline with a synthetic client socket and assert the wire
 *      envelope carries `bead_state` + `reissue_count`.
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
  withLore,
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
        loreDbPath: tmpDb(),
        quitTimeoutSec: -1,
        inheritFd: null,
        focusPollMs: 1000,
        summaryPollMs: 2000,
        summarizerMode: "off" as const,
        loreEnabled: false,
      },
    }),
    withProjectRoot(projectRoot),
    withDatabase(),
    withDaemonContext(),
    withLore(),
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
  opts: { name: string; role?: "chief" | "member"; sessionId?: string },
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
    lore: { sessionId: null, claudePid: null },
  })
  return { frames, connId }
}

describe("withBroadcast — assign envelope enrichment", () => {
  it("attaches fresh bead_state from .beads/backup/issues.jsonl when delivering an assign", async () => {
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
      $role: "chief",
      $domains: "[]",
      $pid: 0,
      $cwd: "/x",
      $project_id: "p",
      $claude_session_id: null,
      $claude_session_name: null,
      $identity_token: null,
      $now: Date.now(),
    })
    const senderCtx = { ...t.daemonCtx, sessionId: senderId, getName: () => "chief", getRole: () => "chief" as const }
    sendMessage(
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
    expect(frames.length).toBeGreaterThan(0)
    const channelFrame = frames.find((f) => (f.params as { type?: string }).type === "assign")
    expect(
      channelFrame,
      `expected an assign-typed channel frame, got: ${JSON.stringify(frames.map((f) => f.params))}`,
    ).toBeDefined()
    const beadState = channelFrame!.params.bead_state as
      | { title: string; status: string; priority: string; notes_excerpt: string; updated_at: string | null }
      | undefined
    expect(beadState, "expected bead_state on the assign envelope").toBeDefined()
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
      $role: "chief",
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
      getRole: () => "chief" as const,
    }
    // First assign — reissue_count should be 0 (or absent; treat both as "not a reissue").
    sendMessage(
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
    sendMessage(
      senderCtx as unknown as Parameters<typeof sendMessage>[0],
      "agent",
      "Re-issued assignment (chief ignored evidence)",
      "assign",
      "km-tribe.foo",
      undefined,
      "direct",
    )
    await Promise.resolve()
    const assigns = frames.filter((f) => (f.params as { type?: string }).type === "assign")
    expect(assigns.length).toBe(2)
    const first = assigns[0]!.params.reissue_count as number | undefined
    const second = assigns[1]!.params.reissue_count as number | undefined
    expect(first ?? 0).toBe(0)
    expect(second).toBe(1)
  })

  it("does not attach bead_state for non-assign types even when bead_id is set", async () => {
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
    sendMessage(
      senderCtx as unknown as Parameters<typeof sendMessage>[0],
      "agent",
      "Hey, look at this bead",
      "notify",
      "km-tribe.foo",
      undefined,
      "direct",
    )
    await Promise.resolve()
    const channelFrame = frames.find((f) => (f.params as { type?: string }).type === "notify")
    expect(channelFrame).toBeDefined()
    expect(channelFrame!.params.bead_state).toBeUndefined()
    expect(channelFrame!.params.reissue_count).toBeUndefined()
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
      $role: "chief",
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
      getRole: () => "chief" as const,
    }
    sendMessage(
      senderCtx as unknown as Parameters<typeof sendMessage>[0],
      "agent",
      "Assignment with no bead state to enrich",
      "assign",
      "km-tribe.foo",
      undefined,
      "direct",
    )
    await Promise.resolve()
    const assignFrame = frames.find((f) => (f.params as { type?: string }).type === "assign")
    expect(assignFrame).toBeDefined()
    expect(assignFrame!.params.bead_state).toBeUndefined()
    // reissue_count should still be 0 (count works regardless of jsonl presence).
    expect((assignFrame!.params.reissue_count as number | undefined) ?? 0).toBe(0)
  })
})
