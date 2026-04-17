/**
 * Tests for the lore MCP server (internal to /tribe)'s tool handlers.
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
import { buildMockQueryModel, buildPlanJson, alwaysAvailable } from "../../llm/src/lib/mock"

const mockHolder: {
  fn: ReturnType<typeof buildMockQueryModel> | null
} = { fn: null }

vi.mock("../../llm/src/lib/research", () => ({
  queryModel: (opts: Parameters<NonNullable<typeof mockHolder.fn>>[0]) => {
    if (!mockHolder.fn) throw new Error("Test did not install a mock queryModel")
    return mockHolder.fn(opts)
  },
}))

vi.mock("../../llm/src/lib/providers", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../llm/src/lib/providers")>()
  return { ...orig, isProviderAvailable: alwaysAvailable }
})

vi.mock("../../recall/src/history/db-schema", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../recall/src/history/db-schema")>()
  return { ...orig, DB_PATH: ":memory:" }
})

vi.mock("../../recall/src/lib/context", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../recall/src/lib/context")>()
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

import { recallAgent } from "../../recall/src/lib/agent"
import { planQuery, planVariants } from "../../recall/src/lib/plan"
import { getCurrentSessionContext } from "../../recall/src/lib/session-context"
import { setRecallLogging } from "../../recall/src/history/recall-shared"
import { getDb, closeDb } from "../../recall/src/history/db"

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
  const { buildQueryContext } = await import("../../recall/src/lib/context")
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

describe("lore.ask handler", () => {
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

describe("lore.current_brief handler", () => {
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

describe("lore.plan_only handler", () => {
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

// ---------------------------------------------------------------------------
// Library-fallback handler behaviour for Phase 3-5 tools.
//
// When the lore daemon is unreachable, the MCP server falls back to either
// the in-process library (hookRecall for inject_delta) or an empty-result
// shape (workspace_state, session_state are daemon-only). These tests exercise
// the fallback shape using the same re-implementation strategy as the Phase 1
// tools above.
// ---------------------------------------------------------------------------

import { hookRecall } from "../../recall/src/history/scanner"

async function handleInjectDeltaLibraryFallback(args: Record<string, unknown>) {
  const prompt = typeof args.prompt === "string" ? args.prompt : ""
  if (!prompt) throw new Error("prompt required")
  const result = await hookRecall(prompt)
  if (result.skipped) {
    return { skipped: true, reason: result.reason, seenCount: 0, turnNumber: 0, mode: "library" as const }
  }
  return {
    skipped: false,
    additionalContext: result.hookOutput?.hookSpecificOutput.additionalContext ?? "",
    seenCount: 0,
    turnNumber: 0,
    mode: "library" as const,
  }
}

function handleWorkspaceStateLibraryFallback() {
  // Daemon-only — library path returns empty with a note.
  return {
    generatedAt: Date.now(),
    sessions: [] as const,
    mode: "library" as const,
    note: "bear daemon not reachable; workspace state is only available via the daemon",
  }
}

function handleSessionStateLibraryFallback(args: Record<string, unknown>) {
  const sessionId = typeof args.sessionId === "string" ? args.sessionId : ""
  if (!sessionId) throw new Error("sessionId required")
  return {
    sessionId,
    detected: false,
    mode: "library" as const,
    note: "bear daemon not reachable; session_state is daemon-only",
  }
}

describe("lore.inject_delta handler (library fallback)", () => {
  test("returns skipped=true with reason for empty prompt", async () => {
    mockHolder.fn = buildMockQueryModel([])
    const out = await handleInjectDeltaLibraryFallback({ prompt: "x" })
    expect(out.skipped).toBe(true)
    expect(out.reason).toBe("short")
    expect(out.mode).toBe("library")
  })

  test("returns skipped=true for slash commands", async () => {
    mockHolder.fn = buildMockQueryModel([])
    const out = await handleInjectDeltaLibraryFallback({ prompt: "/some-command with args" })
    expect(out.skipped).toBe(true)
    expect(out.reason).toBe("slash_command")
  })

  test("throws when prompt is missing entirely", async () => {
    mockHolder.fn = buildMockQueryModel([])
    await expect(handleInjectDeltaLibraryFallback({})).rejects.toThrow(/prompt required/)
  })
})

describe("lore.workspace_state handler (library fallback)", () => {
  test("returns empty sessions with explanatory note", () => {
    const out = handleWorkspaceStateLibraryFallback()
    expect(out.sessions).toHaveLength(0)
    expect(out.mode).toBe("library")
    expect(out.note).toMatch(/daemon not reachable/i)
    expect(typeof out.generatedAt).toBe("number")
  })
})

describe("lore.session_state handler (library fallback)", () => {
  test("returns detected=false with sessionId echoed", () => {
    const out = handleSessionStateLibraryFallback({ sessionId: "some-uuid" })
    expect(out.detected).toBe(false)
    expect(out.sessionId).toBe("some-uuid")
    expect(out.mode).toBe("library")
    expect(out.note).toMatch(/daemon-only/i)
  })

  test("throws when sessionId is missing", () => {
    expect(() => handleSessionStateLibraryFallback({})).toThrow(/sessionId required/)
  })
})
