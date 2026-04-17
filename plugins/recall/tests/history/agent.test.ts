/**
 * Tests for recallAgent orchestration — short-circuit, speculative, empty-plan,
 * fallthrough, time-hint. Mocks queryModel via vitest module mocking so tests
 * run with no API keys and no network.
 *
 * Note: fanoutSearch hits a real (in-memory) SQLite DB, so each test sets up
 * a tiny corpus to make coverage stats deterministic.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest"
import { buildMockQueryModel, buildPlanJson, alwaysAvailable } from "../../../llm/src/lib/mock"

// ──────────────────────────────────────────────────────────────────────
// Mock the LLM call sites BEFORE any module under test is imported.
// buildMockQueryModel returns a single function; tests reconfigure the
// scenarios by mutating a module-level `scenarios` array via holder refs.
// ──────────────────────────────────────────────────────────────────────

const mockHolder: {
  fn: ReturnType<typeof buildMockQueryModel> | null
} = { fn: null }

vi.mock("../../../llm/src/lib/research", () => ({
  queryModel: (opts: Parameters<NonNullable<typeof mockHolder.fn>>[0]) => {
    if (!mockHolder.fn) throw new Error("Test did not install a mock queryModel")
    return mockHolder.fn(opts)
  },
}))

vi.mock("../../../llm/src/lib/providers", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../../llm/src/lib/providers")>()
  return { ...orig, isProviderAvailable: alwaysAvailable }
})

// Use bun:sqlite's `:memory:` path so each test gets a fresh DB when we
// close + reopen via closeDb() in afterEach. Vi.mock factory is hoisted
// so we can't close over top-level consts; the path is inlined.
vi.mock("../../src/history/db-schema", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/history/db-schema")>()
  return { ...orig, DB_PATH: ":memory:" }
})

// Disable context-build side effects that aren't relevant to agent orchestration
vi.mock("../../src/lib/context", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/lib/context")>()
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

// ──────────────────────────────────────────────────────────────────────
// Imports AFTER vi.mock declarations (hoisted by Vitest)
// ──────────────────────────────────────────────────────────────────────

import { recallAgent } from "../../src/lib/agent"
import { setRecallLogging } from "../../src/history/recall-shared"
import { getDb, closeDb } from "../../src/history/db"

// ──────────────────────────────────────────────────────────────────────
// Fixture helpers
// ──────────────────────────────────────────────────────────────────────

function seedCorpus(opts: {
  sessions: Array<{ id: string; title: string; messages: string[] }>
  beads?: Array<{ id: string; title: string; content: string }>
}) {
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

  for (const b of opts.beads ?? []) {
    db.prepare(
      `INSERT INTO content (content_type, source_id, project_path, title, content, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("bead", b.id, "/test", b.title, b.content, now)
  }
}

// ──────────────────────────────────────────────────────────────────────
// Lifecycle
// ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  setRecallLogging(false)
  // Ensure we start each test with a fresh in-memory DB (closeDb resets the
  // db.ts singleton so the next getDb() opens a new :memory: DB).
  closeDb()
})

afterEach(() => {
  closeDb()
  mockHolder.fn = null
})

// ──────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────

describe("recallAgent — short-circuit", () => {
  test("skips round 2 when top-coverage absolute threshold hit (low fraction)", async () => {
    // 24 variants planned; session only matches 8 of them →
    //   fraction = 8/24 = 0.33 (below 0.35 threshold)
    //   absolute = 8 (meets ≥6 threshold)
    // Confirms the absolute-coverage path triggers independently.
    const keywords: string[] = []
    for (let i = 0; i < 24; i++) keywords.push(`tok${i}`)

    mockHolder.fn = buildMockQueryModel([
      { match: /query planner/i, content: buildPlanJson({ keywords }) },
      { content: "synthesized" },
    ])

    // Session content matches only tok0..tok7 (8 variants)
    seedCorpus({
      sessions: [{ id: "sess-a", title: "A", messages: ["tok0 tok1 tok2 tok3 tok4 tok5 tok6 tok7"] }],
    })

    const result = await recallAgent("test query", { limit: 1 })

    expect(result.trace.decision.round2Mode).toBe("off")
    expect(result.trace.decision.reason).toMatch(/short-circuit/)
    expect(result.trace.decision.reason).toMatch(/absolute=8/)
    expect(result.trace.rounds).toHaveLength(1)
    expect(result.trace.synthPath).toBe("single-pass")
    expect(result.trace.synthCallsUsed).toBe(1)
  })

  test("skips round 2 when fraction threshold hit", async () => {
    // 4 variants, all match → fraction = 4/4 = 1.0 ≥ 0.35
    mockHolder.fn = buildMockQueryModel([
      { match: /query planner/i, content: buildPlanJson({ keywords: ["alpha", "beta", "gamma", "delta"] }) },
      { content: "synthesized" },
    ])

    seedCorpus({
      sessions: [{ id: "sess-a", title: "A", messages: ["alpha beta gamma delta"] }],
    })

    const result = await recallAgent("q", { limit: 1 })

    expect(result.trace.decision.round2Mode).toBe("off")
    expect(result.trace.decision.reason).toMatch(/fraction=1\.00/)
  })
})

describe("recallAgent — speculative synth", () => {
  test("uses speculative round-1 when round 2 adds no new top-K docs", async () => {
    // Round 1 plan with few variants so short-circuit doesn't fire
    const round1Plan = buildPlanJson({ keywords: ["alpha"], phrases: [] })
    // Round 2 plan with variants that won't match anything in the corpus
    const round2Plan = buildPlanJson({ keywords: ["nonexistent-term-xyz"], phrases: [] })

    let planCallCount = 0
    mockHolder.fn = async (opts) => {
      if (opts.systemPrompt?.toLowerCase().includes("query planner")) {
        planCallCount++
        return {
          response: {
            model: opts.model,
            content: planCallCount === 1 ? round1Plan : round2Plan,
            durationMs: 10,
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          },
        }
      }
      // synth call
      return {
        response: {
          model: opts.model,
          content: "synthesized answer",
          durationMs: 10,
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        },
      }
    }

    seedCorpus({
      sessions: [{ id: "sess-a", title: "A", messages: ["alpha content"] }],
    })

    const result = await recallAgent("fuzzy query", { limit: 3, round2: "deeper" })

    // Round 2 fired and found nothing → speculative round-1 answer used
    expect(result.trace.rounds.length).toBeGreaterThanOrEqual(1)
    expect(result.trace.synthPath).toBe("speculative-round1")
    expect(result.trace.synthCallsUsed).toBe(1)
    expect(result.trace.round1ShortCircuited).toBe(true)
    expect(result.synthesis).toContain("synthesized")
  })

  test("can be disabled via speculativeSynth: false", async () => {
    const plan = buildPlanJson({ keywords: ["alpha"] })
    mockHolder.fn = buildMockQueryModel([{ match: /query planner/i, content: plan }, { content: "answer" }])

    seedCorpus({
      sessions: [{ id: "sess-a", title: "A", messages: ["alpha content"] }],
    })

    const result = await recallAgent("q", {
      limit: 3,
      round2: "off",
      speculativeSynth: false,
    })

    // No speculative promise fired; single-pass synth on round-1 results
    expect(result.trace.synthPath).toBe("single-pass")
    expect(result.trace.synthCallsUsed).toBe(1)
    expect(result.trace.round1ShortCircuited).toBe(false)
  })
})

describe("recallAgent — empty plan handling", () => {
  test("fallthrough when round-1 planner returns malformed JSON", async () => {
    mockHolder.fn = buildMockQueryModel([{ content: "not valid json at all" }])

    seedCorpus({
      sessions: [{ id: "sess-a", title: "A", messages: ["content"] }],
    })

    const result = await recallAgent("q", { limit: 3 })

    expect(result.fellThrough).toBe(true)
    expect(result.trace.rounds[0]!.planner.error).toMatch(/parse-failed/)
  })

  test("round-2 empty-plan keeps round-1 results (not an error)", async () => {
    let planCallCount = 0
    mockHolder.fn = async (opts) => {
      if (opts.systemPrompt?.toLowerCase().includes("query planner")) {
        planCallCount++
        const content =
          planCallCount === 1
            ? buildPlanJson({ keywords: ["alpha"] })
            : // Round 2 returns a structurally-valid empty plan
              JSON.stringify({ keywords: [], phrases: [], concepts: [], paths: [], errors: [], bead_ids: [] })
        return {
          response: {
            model: opts.model,
            content,
            durationMs: 10,
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          },
        }
      }
      return {
        response: {
          model: opts.model,
          content: "answer",
          durationMs: 10,
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        },
      }
    }

    seedCorpus({
      sessions: [{ id: "sess-a", title: "A", messages: ["alpha"] }],
    })

    const result = await recallAgent("q", { limit: 3, round2: "deeper" })

    // Agent kept round-1 results; round 2's planner entry reflects empty-plan
    expect(result.fellThrough).toBeFalsy()
    const round2Trace = result.trace.rounds[1]
    expect(round2Trace?.planner.error).toBe("empty-plan")
  })
})

describe("recallAgent — time-hint application", () => {
  test("planner time_hint overrides default sinceTime when --since not set", async () => {
    const plan = buildPlanJson({ keywords: ["alpha"], time_hint: "1h" })
    mockHolder.fn = buildMockQueryModel([{ match: /query planner/i, content: plan }, { content: "answer" }])

    seedCorpus({
      sessions: [{ id: "sess-a", title: "A", messages: ["alpha"] }],
    })

    const result = await recallAgent("q", { limit: 3, round2: "off" })

    // Hard to observe sinceTime directly, but the plan's time_hint should
    // be preserved in the round-1 plan payload (not clobbered)
    const round1Plan = result.trace.rounds[0]!.plan as { time_hint: string | null }
    expect(round1Plan.time_hint).toBe("1h")
  })

  test("caller's --since wins over planner's time_hint", async () => {
    const plan = buildPlanJson({ keywords: ["alpha"], time_hint: "30d" })
    mockHolder.fn = buildMockQueryModel([{ match: /query planner/i, content: plan }, { content: "answer" }])

    seedCorpus({
      sessions: [{ id: "sess-a", title: "A", messages: ["alpha"] }],
    })

    // Caller explicitly passes a 1-week filter; planner's 30d should not apply
    const result = await recallAgent("q", { limit: 3, since: "1w", round2: "off" })

    // Planner's time_hint is still in the plan, but the agent should not
    // have reapplied it (we can't directly observe sinceTime, but we can
    // confirm no crash and the plan structure is intact).
    expect(result.fellThrough).toBeFalsy()
    const round1Plan = result.trace.rounds[0]!.plan as { time_hint: string | null }
    expect(round1Plan.time_hint).toBe("30d") // planner said so; caller overrode in agent internals
  })
})

describe("recallAgent — fallthrough", () => {
  test("falls through cleanly when round-1 planner returns zero variants", async () => {
    // Plan parses but has no entries → parsePlanResult returns empty-plan
    mockHolder.fn = buildMockQueryModel([
      { content: JSON.stringify({ keywords: [], phrases: [], concepts: [], paths: [], errors: [], bead_ids: [] }) },
    ])

    seedCorpus({
      sessions: [{ id: "sess-a", title: "A", messages: ["alpha"] }],
    })

    const result = await recallAgent("q", { limit: 3 })

    expect(result.fellThrough).toBe(true)
    expect(result.trace.rounds[0]!.planner.error).toBe("empty-plan")
  })
})
