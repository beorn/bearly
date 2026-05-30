import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

// Use an isolated in-memory recall DB. The mock is hoisted before src imports.
vi.mock("../../src/history/db-schema", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/history/db-schema")>()
  return { ...orig, DB_PATH: ":memory:" }
})

const mockAgent: {
  result: Awaited<typeof import("../../src/lib/agent")>["recallAgent"] | null
} = { result: null }

vi.mock("../../src/lib/agent.ts", () => ({
  recallAgent: (query: string, options: unknown) => {
    if (!mockAgent.result) throw new Error("Test did not install a mock recallAgent")
    return mockAgent.result(query, options as never)
  },
}))

// Stale-index auto-refresh shells out to `bun recall index --incremental` as a
// real subprocess. In-process tests must NOT spawn it — it indexes the user's
// actual recall DB and hangs the test (10s timeout). Replace only the spawn
// dep with an instant no-op; the real staleness-decision logic in
// `refreshIndexIfStaleWithDeps` still runs (so the stale → refreshed note path
// is exercised). The subprocess itself is covered by refresh.ts's own
// dep-injected unit tests.
vi.mock("../../src/lib/refresh.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/lib/refresh.ts")>()
  return {
    ...orig,
    makeRefreshDeps: (getLastRebuild: () => string | null) => ({
      getLastRebuild,
      now: () => Date.now(),
      getThresholdMs: () => 5 * 60 * 1000,
      spawnCmd: async () => ({ exitCode: 0 }),
    }),
  }
})

import { cmdSearch } from "../../src/lib/search"
import { closeDb, getDb, setIndexMeta } from "../../src/history/db"

function seedMessage(content: string): void {
  const db = getDb()
  const now = Date.now()
  db.prepare(
    `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("sess-a", "/test/km", "/tmp/sess-a.jsonl", now - 60_000, now, 1, "Session A")
  db.prepare(`INSERT INTO messages (uuid, session_id, type, content, timestamp) VALUES (?, ?, ?, ?, ?)`).run(
    "msg-a",
    "sess-a",
    "user",
    content,
    now,
  )
}

function zeroAgentResult(query: string) {
  return {
    query,
    synthesis: null,
    results: [],
    durationMs: 12,
    trace: {
      rounds: [
        {
          round: 1,
          mode: "off",
          planner: { model: "mock", elapsedMs: 1 },
          plan: { keywords: ["missed-token"], phrases: [], concepts: [], paths: [], errors: [], bead_ids: [] },
          variants: ["missed-token"],
          stats: { totalQueries: 1, rawHits: 0, uniqueDocs: 0, topCoverage: 0, medianCoverage: 0, msTotal: 1 },
        },
      ],
      decision: { round2Mode: "off", reason: "test" },
      synthPath: "none",
      synthCallsUsed: 0,
      round1ShortCircuited: false,
    },
    fellThrough: false,
  }
}

function callsText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((args: unknown[]) => args.join(" ")).join("\n")
}

describe("recall search output", () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    closeDb()
    mockAgent.result = null
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    errSpy.mockRestore()
    closeDb()
  })

  test("agent zero-results raw-probes literal tokens before printing authoritative no-results", async () => {
    seedMessage("The prior session mentioned barenode in the architecture notes.")
    mockAgent.result = async (query) => zeroAgentResult(query) as never

    await cmdSearch("how should we debug barenode", { agent: true, limit: "5", round2: "off" })

    const output = callsText(logSpy)
    expect(output).toContain("agent variants missed literal raw matches")
    expect(output).toContain("1 results")
    expect(output).toContain("barenode")
    expect(output).not.toContain('No results found for "how should we debug barenode"')
  })

  test("stale index auto-refreshes before empty results", async () => {
    setIndexMeta(getDb(), "last_rebuild", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
    mockAgent.result = async (query) => zeroAgentResult(query) as never

    await cmdSearch("nohits", { agent: true, limit: "5", round2: "off" })

    const errors = callsText(errSpy)
    const output = callsText(logSpy)
    // A ~2h-stale index triggers the auto-refresh note (the prior warn-only
    // "FTS5 index last rebuilt" behavior was superseded by auto-refresh —
    // search.ts emitRefreshNote). It prints BEFORE the empty-results answer.
    expect(errors).toContain("stale — refreshed")
    expect(output).toContain('No results found for "nohits"')
  })

  test("sibling worktree warning prints before empty results when no project filter narrows scope", async () => {
    const prevHome = process.env.HOME
    const prevCwd = process.cwd()
    const home = mkdtempSync(join(tmpdir(), "recall-home-"))
    const project = mkdtempSync(join(tmpdir(), "km-"))
    process.env.HOME = home
    process.chdir(project)
    const projectSlug = "-" + process.cwd().slice(1).replace(/\//g, "-")
    mkdirSync(join(home, ".claude", "projects", projectSlug), { recursive: true })
    mkdirSync(join(home, ".claude", "projects", `${projectSlug}-wt1`), { recursive: true })
    mockAgent.result = async (query) => zeroAgentResult(query) as never

    try {
      await cmdSearch("nohits", { agent: true, limit: "5", round2: "off" })
    } finally {
      process.chdir(prevCwd)
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      rmSync(home, { recursive: true, force: true })
      rmSync(project, { recursive: true, force: true })
    }

    const errors = callsText(errSpy)
    const output = callsText(logSpy)
    expect(errors).toContain("sibling worktree project dir(s) detected")
    expect(output).toContain('No results found for "nohits"')
  })
})
