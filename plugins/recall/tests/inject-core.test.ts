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

function mockRecall(results: Array<{ sessionId: string; sessionTitle?: string; type: string; snippet: string }>): void {
  recallMock.mockResolvedValue({ results })
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

describe("runInjectDelta — substantive prompts always emit the footer", () => {
  beforeEach(() => {
    recallMock.mockReset()
  })

  test("no recall results — emits footer-only output", async () => {
    mockRecall([])
    const result = await runInjectDelta("what is the status of the kanban board?", createMemorySeenStore())
    expect(result.skipped).toBe(false)
    if (result.skipped) return
    expect(result.footerOnly).toBe(true)
    expect(result.emptyRecallReason).toBe("no_results")
    expect(result.additionalContext).toBe(CONTEXT_PROTOCOL_FOOTER)
    expect(result.newKeys).toEqual([])
  })

  test("all results deduped — emits footer-only output", async () => {
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
    await runInjectDelta("what was the last thing we worked on in the board?", store)
    // Second call with same prompt — dedup kicks in, snippet is all_seen.
    const result = await runInjectDelta("what was the last thing we worked on in the board?", store)
    expect(result.skipped).toBe(false)
    if (result.skipped) return
    expect(result.footerOnly).toBe(true)
    expect(result.emptyRecallReason).toBe("all_seen")
    expect(result.additionalContext).toBe(CONTEXT_PROTOCOL_FOOTER)
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
    const result = await runInjectDelta("what did we decide about the storage layer?", createMemorySeenStore())
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
    const result = await runInjectDelta("what did we decide about the storage layer?", createMemorySeenStore())
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
    const result = await runInjectDelta("pick up where we left off on the board refactor", createMemorySeenStore())
    if (result.skipped) throw new Error("expected non-skipped result")
    expect(result.additionalContext).toContain("[historical")
    // The original imperative text remains, just prefixed.
    expect(result.additionalContext).toContain("create a bead that captures")
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
    const first = await runInjectDelta("tell me about the kanban refactor status please", store)
    if (first.skipped) throw new Error("expected non-skipped first call")
    expect(first.newKeys).toContain("sess-dedup001:message")

    const second = await runInjectDelta("tell me about the kanban refactor status please", store)
    if (second.skipped) throw new Error("expected non-skipped second call")
    expect(second.newKeys).toEqual([])
    expect(second.footerOnly).toBe(true)
  })
})
