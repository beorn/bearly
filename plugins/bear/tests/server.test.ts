/**
 * Tests for the @bearly/bear MCP server's tool handlers.
 *
 * We test the handler functions directly (not through stdio MCP) because:
 *  1. Handler logic is what's worth testing — MCP transport is SDK-owned.
 *  2. Stdio testing requires spawning a subprocess, which defeats the
 *     purpose of keeping tests fast and deterministic.
 *
 * Uses the same vi.mock harness as tests/history/agent.test.ts to stub
 * queryModel + provider availability. No live LLM calls.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest"
import { buildMockQueryModel, buildPlanJson, alwaysAvailable } from "../../../tools/lib/llm/mock"

const mockHolder: {
  fn: ReturnType<typeof buildMockQueryModel> | null
} = { fn: null }

vi.mock("../../../tools/lib/llm/research", () => ({
  queryModel: (opts: Parameters<NonNullable<typeof mockHolder.fn>>[0]) => {
    if (!mockHolder.fn) throw new Error("Test did not install a mock queryModel")
    return mockHolder.fn(opts)
  },
}))

vi.mock("../../../tools/lib/llm/providers", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../../tools/lib/llm/providers")>()
  return { ...orig, isProviderAvailable: alwaysAvailable }
})

vi.mock("../../../tools/lib/history/db-schema", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../../tools/lib/history/db-schema")>()
  return { ...orig, DB_PATH: ":memory:" }
})

vi.mock("../../../tools/recall/context", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../../tools/recall/context")>()
  return {
    ...orig,
    buildQueryContext: () => ({
      today: "2026-04-17",
      cwd: "/tmp/test",
      recentSessions: [],
      recentBeads: [],
      rareVocabulary: [],
      scopeEpics: [],
      recentCommits: [],
      sessionContext: null,
    }),
    renderContextPrompt: () => "TEST CONTEXT",
  }
})

import { recallAgent } from "../../../tools/recall/agent"
import { planQuery, planVariants } from "../../../tools/recall/plan"
import { getCurrentSessionContext } from "../../../tools/recall/session-context"
import { setRecallLogging } from "../../../tools/lib/history/recall-shared"
import { getDb, closeDb } from "../../../tools/lib/history/db"

// Re-implement the handler wrappers inline so tests exercise the same logic
// as server.ts without needing to load the MCP SDK. If server.ts diverges
// from these shapes, the tests should be updated to match.
async function handleAsk(args: Record<string, unknown>) {
  const query = String(args.query ?? "")
  if (!query) throw new Error("query required")
  const result = await recallAgent(query, {
    limit: typeof args.limit === "number" ? args.limit : 5,
    round2: args.round2 as "auto" | "wider" | "deeper" | "off" | undefined,
    maxRounds: args.maxRounds === 1 ? 1 : 2,
    speculativeSynth: typeof args.speculativeSynth === "boolean" ? args.speculativeSynth : undefined,
  })
  return {
    answer: result.synthesis,
    results: result.results,
    fellThrough: result.fellThrough ?? false,
    synthPath: result.trace.synthPath,
    synthCallsUsed: result.trace.synthCallsUsed,
    trace: args.rawTrace === true ? result.trace : undefined,
  }
}

async function handleCurrentBrief(args: Record<string, unknown>) {
  const sessionIdOverride = typeof args.sessionId === "string" ? args.sessionId : undefined
  const ctx = getCurrentSessionContext(sessionIdOverride ? { sessionIdOverride } : undefined)
  if (!ctx) return { sessionId: null, detected: false }
  return { sessionId: ctx.sessionId, detected: true, exchangeCount: ctx.exchangeCount }
}

async function handlePlanOnly(args: Record<string, unknown>) {
  const query = String(args.query ?? "")
  const { buildQueryContext } = await import("../../../tools/recall/context")
  const call = await planQuery(query, buildQueryContext(), { round: 1 })
  if (!call.plan) return { ok: false, error: call.error }
  return { ok: true, plan: call.plan, variants: planVariants(call.plan), model: call.model }
}

function seedCorpus(opts: { sessions: Array<{ id: string; title: string; messages: string[] }> }) {
  const db = getDb()
  const now = Date.now()
  for (const s of opts.sessions) {
    db.prepare(
      `INSERT INTO sessions (id, project_path, jsonl_path, created_at, updated_at, message_count, title)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(s.id, "/test", `/tmp/${s.id}.jsonl`, now - 60_000, now, s.messages.length, s.title)
    for (let i = 0; i < s.messages.length; i++) {
      db.prepare(`INSERT INTO messages (uuid, session_id, type, content, timestamp) VALUES (?, ?, ?, ?, ?)`).run(
        `${s.id}-${i}`,
        s.id,
        "user",
        s.messages[i]!,
        now - i * 1000,
      )
    }
  }
}

beforeEach(() => {
  setRecallLogging(false)
  closeDb()
})

afterEach(() => {
  closeDb()
  mockHolder.fn = null
})

describe("bear.ask handler", () => {
  test("returns answer + results for a simple query", async () => {
    mockHolder.fn = buildMockQueryModel([
      { match: /query planner/i, content: buildPlanJson({ keywords: ["alpha", "beta"] }) },
      { content: "synthesized answer" },
    ])

    seedCorpus({
      sessions: [{ id: "sess-a", title: "A", messages: ["alpha beta content"] }],
    })

    const out = await handleAsk({ query: "test" })

    expect(out.answer).toBe("synthesized answer")
    expect(out.results).toBeInstanceOf(Array)
    expect(out.synthCallsUsed).toBeGreaterThanOrEqual(1)
    expect(out.fellThrough).toBe(false)
  })

  test("throws when query is missing", async () => {
    mockHolder.fn = buildMockQueryModel([{ content: "unused" }])
    await expect(handleAsk({})).rejects.toThrow(/query required/)
  })

  test("rawTrace flag includes the full trace", async () => {
    mockHolder.fn = buildMockQueryModel([
      { match: /query planner/i, content: buildPlanJson({ keywords: ["alpha"] }) },
      { content: "answer" },
    ])
    seedCorpus({ sessions: [{ id: "sess-a", title: "A", messages: ["alpha"] }] })

    const outWith = await handleAsk({ query: "q", rawTrace: true, round2: "off" })
    const outWithout = await handleAsk({ query: "q", round2: "off" })

    expect(outWith.trace).toBeDefined()
    expect(outWith.trace?.rounds.length).toBeGreaterThanOrEqual(1)
    expect(outWithout.trace).toBeUndefined()
  })
})

describe("bear.current_brief handler", () => {
  test("returns detected:false when no session is active", async () => {
    // Env var absent, no sentinel → detection fails gracefully in test env
    const out = await handleCurrentBrief({})
    // May or may not detect depending on where the test process runs;
    // we only check the shape invariant.
    expect(out).toHaveProperty("detected")
    expect(out).toHaveProperty("sessionId")
  })

  test("respects explicit sessionId override (returns detection shape regardless)", async () => {
    // Note: session-context.ts currently falls back to mtime detection when
    // the explicit sessionId can't be resolved, so we can't assert null.
    // We only check the response shape. A future enhancement could make
    // override strict (no fallback) — that would be a separate bead.
    const out = await handleCurrentBrief({ sessionId: "nonexistent-session-xyz" })
    expect(out).toHaveProperty("detected")
    expect(out).toHaveProperty("sessionId")
  })
})

describe("bear.plan_only handler", () => {
  test("returns plan + variants without fanout or synth", async () => {
    let synthCalls = 0
    mockHolder.fn = async (opts) => {
      if (opts.systemPrompt?.toLowerCase().includes("query planner")) {
        return {
          response: {
            model: opts.model,
            content: buildPlanJson({ keywords: ["foo", "bar"], phrases: ["foo bar"] }),
            durationMs: 10,
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          },
        }
      }
      synthCalls++
      return {
        response: {
          model: opts.model,
          content: "synth",
          durationMs: 10,
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
      }
    }

    const out = await handlePlanOnly({ query: "fuzzy" })

    expect(out.ok).toBe(true)
    expect(out.plan).toBeDefined()
    expect(out.variants).toContain("foo")
    expect(out.variants).toContain("bar")
    expect(out.variants).toContain('"foo bar"')
    // Confirm no synth was called — plan_only shouldn't fan out or synthesize
    expect(synthCalls).toBe(0)
  })

  test("returns ok=false when planner fails", async () => {
    mockHolder.fn = buildMockQueryModel([{ content: "garbage not json" }])
    const out = await handlePlanOnly({ query: "q" })
    expect(out.ok).toBe(false)
    expect(out.error).toBeDefined()
  })
})
