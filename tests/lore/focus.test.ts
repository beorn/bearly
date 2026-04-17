/**
 * Lore focus poller — integration tests.
 *
 * Tests the Phase 3 focus pipeline: `extractSessionFocus` + daemon poller +
 * `lore.workspace_state` / `lore.current_brief` cache fast-path.
 */

import { describe, it, expect, afterEach } from "vitest"
import { randomUUID } from "node:crypto"
import { existsSync, unlinkSync, writeFileSync } from "node:fs"
import { spawn, type ChildProcess } from "node:child_process"
import { resolve, dirname } from "node:path"
import { connectToDaemon, type LoreClient } from "../../plugins/lore/src/lib/socket.ts"
import {
  LORE_METHODS,
  LORE_PROTOCOL_VERSION,
  type WorkspaceStateResult,
  type CurrentBriefResult,
} from "../../plugins/lore/src/lib/rpc.ts"
import { extractSessionFocus } from "../../plugins/recall/src/lib/session-context.ts"

const DAEMON_SCRIPT = resolve(dirname(new URL(import.meta.url).pathname), "../../plugins/lore/src/daemon.ts")

function tmpPath(suffix: string): string {
  return `/tmp/lore-focus-test-${randomUUID().slice(0, 8)}.${suffix}`
}

async function waitFor<T>(
  fn: () => T | Promise<T | null | undefined> | null | undefined,
  timeoutMs = 3000,
  intervalMs = 30,
): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = await fn()
    if (v !== null && v !== undefined && v !== false) return v as T
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error("waitFor timed out")
}

/** Minimal Claude Code JSONL fixture (one user + one assistant exchange) */
function writeFixtureJsonl(path: string, userText: string, assistantText: string, ts: number = Date.now()): void {
  const userLine = JSON.stringify({
    type: "user",
    timestamp: new Date(ts - 1000).toISOString(),
    message: { role: "user", content: userText },
  })
  const asstLine = JSON.stringify({
    type: "assistant",
    timestamp: new Date(ts).toISOString(),
    message: { role: "assistant", content: [{ type: "text", text: assistantText }] },
  })
  writeFileSync(path, userLine + "\n" + asstLine + "\n")
}

type Harness = {
  child: ChildProcess
  client: LoreClient
  socketPath: string
  dbPath: string
  teardown: () => Promise<void>
}

async function spawnDaemon(focusPollMs = 500): Promise<Harness> {
  const socketPath = tmpPath("sock")
  const dbPath = tmpPath("db")
  const child = spawn(
    process.execPath,
    [
      DAEMON_SCRIPT,
      "--socket",
      socketPath,
      "--db",
      dbPath,
      "--quit-timeout",
      "10",
      "--focus-poll-ms",
      String(focusPollMs),
    ],
    { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, LORE_NO_DAEMON: "0" } },
  )
  child.stderr?.on("data", () => {})
  await waitFor(() => existsSync(socketPath))
  const client = await connectToDaemon(socketPath, { callTimeoutMs: 5000 })
  await client.call(LORE_METHODS.hello, { clientName: "t", clientVersion: "0", protocolVersion: LORE_PROTOCOL_VERSION })
  return {
    child,
    client,
    socketPath,
    dbPath,
    async teardown() {
      client.close()
      if (!child.killed) {
        child.kill("SIGTERM")
        await new Promise<void>((r) => {
          child.once("exit", () => r())
          setTimeout(() => {
            child.kill("SIGKILL")
            r()
          }, 2000)
        })
      }
      for (const p of [socketPath, socketPath.replace(/\.sock$/, ".pid"), dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          if (existsSync(p)) unlinkSync(p)
        } catch {
          /* ignore */
        }
      }
    },
  }
}

describe("extractSessionFocus — pure function", () => {
  it("returns null on missing file", () => {
    expect(extractSessionFocus("/tmp/does-not-exist.jsonl")).toBeNull()
  })

  it("extracts age, exchange count, and tokens from a simple fixture", () => {
    const p = tmpPath("jsonl")
    writeFixtureJsonl(
      p,
      "investigate CardColumn.tsx for layout bug",
      "I'll look at vendor/silvery and check km-silvery.layout-bug",
    )
    try {
      const focus = extractSessionFocus(p, { sessionId: "fixture-sess" })
      expect(focus).not.toBeNull()
      expect(focus!.sessionId).toBe("fixture-sess")
      expect(focus!.exchangeCount).toBeGreaterThan(0)
      expect(focus!.lastActivityTs).not.toBeNull()
      expect(focus!.tail).toContain("CardColumn")
      expect(focus!.mentionedBeads).toContain("km-silvery.layout-bug")
    } finally {
      try {
        unlinkSync(p)
      } catch {}
    }
  })
})

describe("lore daemon — focus poller + workspace_state", () => {
  let h: Harness | null = null
  afterEach(async () => {
    await h?.teardown()
    h = null
  })

  it("populates workspace_state focus after the poll interval fires", async () => {
    h = await spawnDaemon(200)
    const transcriptPath = tmpPath("jsonl")
    writeFixtureJsonl(transcriptPath, "fix the bug in UnifiedOmnibox.tsx", "running tests")
    try {
      await h.client.call(LORE_METHODS.sessionRegister, {
        claudePid: 55555,
        sessionId: "focus-test-sess",
        transcriptPath,
        cwd: "/tmp",
        project: "km",
      })
      // Wait until workspace_state returns a non-empty focusHint for this session.
      const result = await waitFor<WorkspaceStateResult>(async () => {
        const state = (await h!.client.call(LORE_METHODS.workspaceState, {})) as WorkspaceStateResult
        const hit = state.sessions.find((s) => s.claudePid === 55555)
        return hit?.focusHint ? state : null
      }, 4000)
      const row = result.sessions.find((s) => s.claudePid === 55555)!
      expect(row.focusHint).toContain("UnifiedOmnibox")
      expect(row.exchangeCount).toBeGreaterThan(0)
      expect(row.status).toBe("alive")
      expect(row.lastActivityTs).not.toBeNull()
      expect(row.updatedAt).not.toBeNull()
    } finally {
      try {
        unlinkSync(transcriptPath)
      } catch {}
    }
  })

  it("keeps cached focus when the transcript is removed (no throw)", async () => {
    h = await spawnDaemon(200)
    const transcriptPath = tmpPath("jsonl")
    writeFixtureJsonl(transcriptPath, "cached query", "cached answer")
    await h.client.call(LORE_METHODS.sessionRegister, {
      claudePid: 55556,
      sessionId: "cache-test-sess",
      transcriptPath,
      cwd: "/tmp",
      project: "km",
    })
    // Wait for initial focus refresh.
    await waitFor(async () => {
      const state = (await h!.client.call(LORE_METHODS.workspaceState, {})) as WorkspaceStateResult
      return state.sessions.find((s) => s.claudePid === 55556)?.focusHint ? true : null
    }, 4000)
    unlinkSync(transcriptPath)
    // Next poll tick will try and fail; the cached entry must still be present.
    await new Promise((r) => setTimeout(r, 400))
    const state = (await h.client.call(LORE_METHODS.workspaceState, {})) as WorkspaceStateResult
    const row = state.sessions.find((s) => s.claudePid === 55556)
    expect(row).toBeDefined()
    expect(row!.focusHint).toContain("cached query")
  })

  it("current_brief uses cache when fresh", async () => {
    h = await spawnDaemon(200)
    const transcriptPath = tmpPath("jsonl")
    writeFixtureJsonl(transcriptPath, "brief test query", "brief answer")
    try {
      await h.client.call(LORE_METHODS.sessionRegister, {
        claudePid: 55557,
        sessionId: "brief-test-sess",
        transcriptPath,
        cwd: "/tmp",
        project: "km",
      })
      // Wait for focus to populate.
      await waitFor(async () => {
        const state = (await h!.client.call(LORE_METHODS.workspaceState, {})) as WorkspaceStateResult
        return state.sessions.find((s) => s.claudePid === 55557)?.focusHint ? true : null
      }, 4000)
      const brief = (await h.client.call(LORE_METHODS.currentBrief, {
        sessionIdOverride: "brief-test-sess",
      })) as CurrentBriefResult
      expect(brief.detected).toBe(true)
      expect(brief.sessionId).toBe("brief-test-sess")
      expect(brief.recentMessages).toContain("brief test query")
    } finally {
      try {
        unlinkSync(transcriptPath)
      } catch {}
    }
  })
})
