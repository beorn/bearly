/**
 * Tests for the injection-framing protocol emitted by runInjectDelta.
 *
 * Covers:
 *   - The trailing context-protocol footer is present on every substantive
 *     prompt, regardless of whether recall found new snippets.
 *   - The <recall-memory> wrapper carries the typed directive attributes
 *     (authority, changes_goal, tool_trigger).
 *   - Imperative-mood snippets are rewritten to reported-speech framing.
 *   - Trivial prompts (empty, short, slash, ack phrases) still skip cleanly
 *     with no output.
 *
 * See km-bearly.injection-framing for the protocol design.
 */

import { describe, test, expect, beforeEach, vi } from "vitest"
import {
  CONTEXT_PROTOCOL_FOOTER,
  createMemorySeenStore,
  rewriteImperativeAsReported,
  runInjectDelta,
} from "../src/lib/inject-core.ts"

// Recall must be mocked — the unit test doesn't go near the FTS db.
vi.mock("../src/history/search.ts", () => ({
  recall: vi.fn(),
}))
vi.mock("../src/history/project-sources.ts", () => ({
  ensureProjectSourcesIndexed: vi.fn(),
}))

import { recall } from "../src/history/search.ts"
const recallMock = recall as unknown as ReturnType<typeof vi.fn>

function mockRecall(
  results: Array<{
    sessionId: string
    sessionTitle?: string
    type: string
    snippet: string
    rank?: number
    timestamp?: number
  }>,
): void {
  // V2 gates require rank + timestamp on every result. Default to a strong
  // BM25-shape rank (-10 is well below MIN_RANK_THRESHOLD = -3) and a recent
  // timestamp so tests focused on dedup/emit don't trip the quality gates.
  recallMock.mockResolvedValue({
    results: results.map((r) => ({
      rank: -10,
      timestamp: Date.now(),
      ...r,
    })),
  })
}

describe("rewriteImperativeAsReported", () => {
  test("prefixes common imperatives", () => {
    expect(rewriteImperativeAsReported("create a bead that captures X")).toMatch(/^\[historical/)
    expect(rewriteImperativeAsReported("fix the broken test")).toMatch(/^\[historical/)
    expect(rewriteImperativeAsReported("refactor the module")).toMatch(/^\[historical/)
  })

  test("is case-insensitive on the first word", () => {
    expect(rewriteImperativeAsReported("Create a bead")).toMatch(/^\[historical/)
    expect(rewriteImperativeAsReported("FIX this")).toMatch(/^\[historical/)
  })

  test("leaves descriptive snippets untouched", () => {
    const descriptive = "Checkpoint saved to km-silvery.reactive-pipeline."
    expect(rewriteImperativeAsReported(descriptive)).toBe(descriptive)
  })

  test("leaves questions untouched", () => {
    const q = "What should we do about the scroll region?"
    expect(rewriteImperativeAsReported(q)).toBe(q)
  })

  test("is idempotent — re-running does not double-prefix", () => {
    const once = rewriteImperativeAsReported("create a bead")
    expect(rewriteImperativeAsReported(once)).toBe(once)
  })

  test("handles empty and whitespace-only input", () => {
    expect(rewriteImperativeAsReported("")).toBe("")
    expect(rewriteImperativeAsReported("   ")).toBe("   ")
  })
})

describe("CONTEXT_PROTOCOL_FOOTER", () => {
  test("is wrapped in a <context-protocol> tag", () => {
    expect(CONTEXT_PROTOCOL_FOOTER.startsWith("<context-protocol>")).toBe(true)
    expect(CONTEXT_PROTOCOL_FOOTER.endsWith("</context-protocol>")).toBe(true)
  })

  test("directs the model to respond only to unframed text", () => {
    expect(CONTEXT_PROTOCOL_FOOTER).toMatch(/unframed/)
  })
})

describe("runInjectDelta — trivial prompts", () => {
  beforeEach(() => {
    recallMock.mockReset()
  })

  test("empty prompt is skipped with no output", async () => {
    const store = createMemorySeenStore()
    const result = await runInjectDelta("", store)
    expect(result.skipped).toBe(true)
    if (result.skipped) expect(result.reason).toBe("empty")
    expect(recallMock).not.toHaveBeenCalled()
  })

  test("short prompt is skipped", async () => {
    const result = await runInjectDelta("hi", createMemorySeenStore())
    expect(result.skipped).toBe(true)
    if (result.skipped) expect(result.reason).toBe("short")
  })

  test("short ack phrases are skipped via short-check", async () => {
    // All currently-listed TRIVIAL_PROMPTS are <15 chars so short-check fires
    // first; the "trivial" branch is a fail-safe for future relaxation. Both
    // skip reasons are functionally equivalent at the emit layer.
    const result = await runInjectDelta("looks good", createMemorySeenStore())
    expect(result.skipped).toBe(true)
    if (result.skipped) expect(result.reason).toBe("short")
  })

  test("slash commands are skipped", async () => {
    const result = await runInjectDelta("/help something", createMemorySeenStore())
    expect(result.skipped).toBe(true)
    if (result.skipped) expect(result.reason).toBe("slash_command")
  })
})

describe("runInjectDelta — emit only when there's content to frame", () => {
  beforeEach(() => {
    recallMock.mockReset()
  })

  test("no recall results — skips entirely (no footer-only emission)", async () => {
    // Behavior change: previously emitted the footer alone, but Claude Code
    // renders all hook additionalContext as user-role turns. An always-on
    // footer turned into mysterious "H:" scrollback. Now: no framed content
    // → no emission. See emit.ts CONTEXT_PROTOCOL_FOOTER docstring.
    mockRecall([])
    // Salient prompt (kebab-ID `km-storage`) so V2 salience gate doesn't fire
    // before recall — we want to test the no-results branch specifically.
    const result = await runInjectDelta("what is the status of km-storage right now?", createMemorySeenStore())
    expect(result.skipped).toBe(true)
    if (!result.skipped) return
    expect(result.reason).toBe("no_results")
  })

  test("all results deduped — skips entirely (no footer-only emission)", async () => {
    const store = createMemorySeenStore()
    mockRecall([
      {
        sessionId: "sess-00000001",
        sessionTitle: "prior",
        type: "message",
        snippet: "A reasonably long descriptive snippet about prior work on the project.",
      },
    ])
    // First call marks it as seen.
    await runInjectDelta("what did we last do on km-board for the kanban work?", store)
    // Second call with same prompt — dedup kicks in, snippet is all_seen.
    const result = await runInjectDelta("what did we last do on km-board for the kanban work?", store)
    expect(result.skipped).toBe(true)
    if (!result.skipped) return
    expect(result.reason).toBe("all_seen")
  })

  test("new snippets — emits recall block followed by footer", async () => {
    mockRecall([
      {
        sessionId: "sess-abcd1234",
        sessionTitle: "sess-title",
        type: "message",
        snippet: "A descriptive snippet that is plenty long enough to pass the minimum filter.",
      },
    ])
    const result = await runInjectDelta("what did we decide about km-storage layering?", createMemorySeenStore())
    expect(result.skipped).toBe(false)
    if (result.skipped) return
    expect(result.footerOnly).toBeUndefined()
    // Structural: recall block precedes footer
    const recallIdx = result.additionalContext.indexOf("<recall-memory")
    const footerIdx = result.additionalContext.indexOf("<context-protocol>")
    expect(recallIdx).toBeGreaterThanOrEqual(0)
    expect(footerIdx).toBeGreaterThan(recallIdx)
    // Footer is present verbatim at the end
    expect(result.additionalContext.endsWith(CONTEXT_PROTOCOL_FOOTER)).toBe(true)
  })

  test("recall-memory block carries typed directive attributes", async () => {
    mockRecall([
      {
        sessionId: "sess-abcd1234",
        sessionTitle: "sess-title",
        type: "message",
        snippet: "A descriptive snippet that is plenty long enough to pass the minimum filter.",
      },
    ])
    const result = await runInjectDelta("what did we decide about km-storage layering?", createMemorySeenStore())
    if (result.skipped) throw new Error("expected non-skipped result")
    expect(result.additionalContext).toContain('authority="reference"')
    expect(result.additionalContext).toContain('changes_goal="false"')
    expect(result.additionalContext).toContain('tool_trigger="forbidden"')
  })

  test("imperative snippets are rewritten as reported speech inside the recall block", async () => {
    mockRecall([
      {
        sessionId: "sess-abcd1234",
        sessionTitle: "sess-title",
        type: "message",
        snippet: "create a bead that captures all of this context about the board refactor work.",
      },
    ])
    const result = await runInjectDelta("pick up where we left off on km-board the refactor", createMemorySeenStore())
    if (result.skipped) throw new Error("expected non-skipped result")
    expect(result.additionalContext).toContain("[historical")
    // The original imperative text remains, just prefixed.
    expect(result.additionalContext).toContain("create a bead that captures")
  })
})

describe("runInjectDelta — V2 gates", () => {
  beforeEach(() => {
    recallMock.mockReset()
  })

  test("low-salience meta-prompt (no IDs/paths/backticks) skips before recall fires", async () => {
    const result = await runInjectDelta("how should we improve things?", createMemorySeenStore())
    expect(result.skipped).toBe(true)
    if (!result.skipped) return
    expect(result.reason).toBe("low_salience")
    expect(recallMock).not.toHaveBeenCalled()
  })

  test("long substantive prompt bypasses salience gate even without IDs", async () => {
    mockRecall([
      {
        sessionId: "sess-longprompt",
        sessionTitle: "long",
        type: "message",
        snippet: "A descriptive snippet that is plenty long enough to pass the minimum filter.",
      },
    ])
    // 121 chars, no kebab IDs / paths / backticks — but length alone is enough
    // signal for FTS to find anchors. Salience gate must bypass.
    const longPrompt =
      "I would like a thorough explanation of how the rendering pipeline behaves when several large lists are mounted simultaneously."
    expect(longPrompt.length).toBeGreaterThanOrEqual(120)
    const result = await runInjectDelta(longPrompt, createMemorySeenStore())
    expect(result.skipped).toBe(false)
  })

  test("kebab-case identifier counts as salience even on a short prompt", async () => {
    mockRecall([
      {
        sessionId: "sess-kebab",
        sessionTitle: "kebab",
        type: "message",
        snippet: "A descriptive snippet that is plenty long enough to pass the minimum filter.",
      },
    ])
    const result = await runInjectDelta("how is km-tribe.recall going?", createMemorySeenStore())
    expect(result.skipped).toBe(false)
  })

  test("low FTS rank is filtered out (low_quality skip)", async () => {
    mockRecall([
      {
        sessionId: "sess-weak",
        sessionTitle: "weak match",
        type: "message",
        snippet: "Tangential content that happens to share a token but is otherwise unrelated.",
        rank: -1, // weaker than MIN_RANK_THRESHOLD = -3 → filtered
        timestamp: Date.now(),
      },
    ])
    const result = await runInjectDelta("what about km-board kanban?", createMemorySeenStore())
    expect(result.skipped).toBe(true)
    if (!result.skipped) return
    expect(result.reason).toBe("low_quality")
  })

  test("snippet body matching rejected-signal pattern is dropped", async () => {
    mockRecall([
      {
        sessionId: "sess-orthogonal",
        sessionTitle: "research",
        type: "llm_research",
        snippet: 'Earlier analysis: "verdict": "orthogonal", "why": "discusses unrelated framework".',
      },
    ])
    const result = await runInjectDelta("what did we learn about km-storage cognitive types?", createMemorySeenStore())
    // Filtered-out by content gate; was the only hit → all_seen path
    // (the rank gate passed, content gate didn't).
    expect(result.skipped).toBe(true)
    if (!result.skipped) return
    expect(result.reason).toBe("all_seen")
  })

  test("default limit is 1 — multi-hit recall emits only the best match", async () => {
    mockRecall([
      {
        sessionId: "sess-best",
        sessionTitle: "best",
        type: "message",
        snippet: "First match — strong, descriptive, clearly the best result for this query.",
      },
      {
        sessionId: "sess-okay",
        sessionTitle: "okay",
        type: "message",
        snippet: "Second match — also relevant but lower-priority among the FTS hits.",
      },
      {
        sessionId: "sess-third",
        sessionTitle: "third",
        type: "message",
        snippet: "Third match — should not appear when default limit is 1.",
      },
    ])
    const result = await runInjectDelta("tell me about km-board the refactor", createMemorySeenStore())
    if (result.skipped) throw new Error("expected non-skipped result")
    // Only the first session id appears in the framed output.
    expect(result.additionalContext).toContain("sess-bes")
    expect(result.additionalContext).not.toContain("sess-oka")
    expect(result.additionalContext).not.toContain("sess-thi")
    expect(result.newKeys).toEqual(["sess-best:message"])
  })

  test("dedup TTL is 100 turns — same chunk doesn't re-inject within a session", async () => {
    const store = createMemorySeenStore()
    mockRecall([
      {
        sessionId: "sess-ttl",
        sessionTitle: "ttl",
        type: "message",
        snippet: "A descriptive snippet that is plenty long enough to pass the minimum filter.",
      },
    ])
    // First emit
    const first = await runInjectDelta("status of km-tribe.recall please", store)
    if (first.skipped) throw new Error("expected first call to emit")
    // Simulate ~50 turns of unrelated activity (well under V2's TTL of 100)
    for (let i = 0; i < 50; i++) store.advanceTurn()
    // Same chunk would re-inject if TTL were 10 (V1); under V2 it must not
    const second = await runInjectDelta("status of km-tribe.recall please", store)
    expect(second.skipped).toBe(true)
    if (!second.skipped) return
    expect(second.reason).toBe("all_seen")
  })
})

describe("runInjectDelta — dedup tracking still works", () => {
  beforeEach(() => {
    recallMock.mockReset()
  })

  test("newKeys is recorded on the first surface, empty on the re-surface", async () => {
    const store = createMemorySeenStore()
    mockRecall([
      {
        sessionId: "sess-dedup001",
        sessionTitle: "dedup",
        type: "message",
        snippet: "A descriptive snippet that is plenty long enough to pass the minimum filter.",
      },
    ])
    const first = await runInjectDelta("tell me about km-board the refactor status please", store)
    if (first.skipped) throw new Error("expected non-skipped first call")
    expect(first.newKeys).toContain("sess-dedup001:message")

    const second = await runInjectDelta("tell me about km-board the refactor status please", store)
    // Second call dedup → all_seen → skipped (was footerOnly emit, now skip).
    expect(second.skipped).toBe(true)
    if (!second.skipped) return
    expect(second.reason).toBe("all_seen")
  })
})
