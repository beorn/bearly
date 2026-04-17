import { describe, test, expect } from "vitest"
import { parseActionableItems } from "../../src/lib/summarize-beads"

// ============================================================================
// parseActionableItems
// ============================================================================

describe("parseActionableItems", () => {
  test("extracts lessons learned bullets", () => {
    const summary = `## Key Decisions
- Some decision

## Lessons Learned
- [design] Clear separation of parsing vs. display logic yields stable rendering. [session-ref:c241151b] [ui]
- [ui] Centralizing UI assets reduces duplication. [session-ref:f374479e] [ui]

## Open Questions
- Something unresolved
`
    const items = parseActionableItems(summary)
    expect(items).toHaveLength(2)
    expect(items[0]!.section).toBe("lesson")
    expect(items[0]!.text).toBe("Clear separation of parsing vs. display logic yields stable rendering.")
    expect(items[1]!.section).toBe("lesson")
    expect(items[1]!.text).toBe("Centralizing UI assets reduces duplication.")
  })

  test("extracts NEW and OUTDATED memory updates", () => {
    const summary = `## Memory Updates
- NEW: Per-target store initialization. Remember to initialize memory mode per target path. [session-ref:aada2b35] [memory]
- NEW: Stabilize InkBoard by using fullscreen-ink. [session-ref:51266de1] [memory]
- No changes needed for existing entries.
`
    const items = parseActionableItems(summary)
    expect(items).toHaveLength(2)
    expect(items[0]!.section).toBe("memory")
    expect(items[0]!.text).toContain("Per-target store initialization")
    expect(items[1]!.section).toBe("memory")
    expect(items[1]!.text).toContain("Stabilize InkBoard")
  })

  test("extracts OUTDATED memory updates", () => {
    const summary = `## Memory Updates
- OUTDATED: "Always use X" — today's work shows Y is better because Z. [session-ref:abc12345]
`
    const items = parseActionableItems(summary)
    expect(items).toHaveLength(1)
    expect(items[0]!.section).toBe("memory")
    expect(items[0]!.text).toContain("OUTDATED:")
  })

  test("skips non-NEW/OUTDATED memory lines", () => {
    const summary = `## Memory Updates
- No NEW memory items identified that would save 10+ minutes beyond what is already captured.
`
    const items = parseActionableItems(summary)
    expect(items).toHaveLength(0)
  })

  test("extracts recurring patterns with prevention", () => {
    const summary = `## Recurring Patterns
- Testing environment pitfalls: testEnv reliance keeps causing issues (3rd time in 4 days). Prevention: add explicit per-test invariants. [session-ref:1cef7d9e] [testing]
`
    const items = parseActionableItems(summary)
    expect(items).toHaveLength(1)
    expect(items[0]!.section).toBe("pattern")
    expect(items[0]!.text).toContain("Testing environment pitfalls")
  })

  test("skips 'no exact recurrence' filler in patterns", () => {
    const summary = `## Recurring Patterns
- No exact recurrence detected today of prior-day root causes; plan-mode planning artifacts continue. [session-ref:d9855593]
`
    const items = parseActionableItems(summary)
    expect(items).toHaveLength(0)
  })

  test("skips 'no exact repeat' filler variant", () => {
    const summary = `## Recurring Patterns
- No exact repeat of a root-cause from today's notes. [session-ref:xyz]
`
    const items = parseActionableItems(summary)
    expect(items).toHaveLength(0)
  })

  test("strips session-ref and topic tags from bullets", () => {
    const summary = `## Lessons Learned
- [design] When consolidating CLI features, explicit criteria improve alignment. [session-ref:0341e052] [docs]
`
    const items = parseActionableItems(summary)
    expect(items).toHaveLength(1)
    expect(items[0]!.text).not.toContain("[session-ref:")
    expect(items[0]!.text).not.toContain("[design]")
    expect(items[0]!.text).not.toContain("[docs]")
    expect(items[0]!.text).toBe("When consolidating CLI features, explicit criteria improve alignment.")
  })

  test("returns empty array when no actionable sections exist", () => {
    const summary = `## Key Decisions
- Switched to new API

## Bugs Found
- Fixed crash on startup

## Open Questions
- How to handle edge case?
`
    const items = parseActionableItems(summary)
    expect(items).toHaveLength(0)
  })

  test("handles all three sections together", () => {
    const summary = `## Lessons Learned
- [ui] Content-based detection is more robust than type-based. [session-ref:b3a18002]

## Recurring Patterns
- Same bug class keeps appearing. Prevention: add lint rule. [session-ref:abc]

## Memory Updates
- NEW: Always validate plan alignment before implementation. [session-ref:c72296a6]
`
    const items = parseActionableItems(summary)
    expect(items).toHaveLength(3)
    expect(items.map((i) => i.section).sort()).toEqual(["lesson", "memory", "pattern"])
  })

  test("handles sections terminated by --- separator", () => {
    const summary = `## Lessons Learned
- Important lesson here. [session-ref:abc]

---
## Sessions
- session list
`
    const items = parseActionableItems(summary)
    expect(items).toHaveLength(1)
    expect(items[0]!.text).toBe("Important lesson here.")
  })

  test("handles multi-line bullet continuation", () => {
    const summary = `## Lessons Learned
- [design] First part of a long lesson
  that continues on the next line. [session-ref:abc]
- When debugging TreeNode, always check HR_PATTERN first. [session-ref:def]
`
    const items = parseActionableItems(summary)
    expect(items).toHaveLength(2)
    expect(items[0]!.text).toContain("First part of a long lesson")
    expect(items[0]!.text).toContain("that continues on the next line")
  })

  test("filters out past-tense descriptions of completed work", () => {
    const summary = `## Lessons Learned
- Implemented fullscreen-ink for stable rendering. [session-ref:abc]
- Added centralized status icons to reduce duplication. [session-ref:def]
- Fixed startup crash by initializing store per target. [session-ref:ghi]
- When editing TreeNode rendering, always test with HR nodes. [session-ref:jkl]
`
    const items = parseActionableItems(summary)
    expect(items).toHaveLength(1)
    expect(items[0]!.text).toContain("When editing TreeNode rendering")
  })

  test("filters out items shorter than 20 characters", () => {
    const summary = `## Lessons Learned
- Use bun. [session-ref:abc]
- When running tests in vendor packages, always use bun vitest directly. [session-ref:def]
`
    const items = parseActionableItems(summary)
    expect(items).toHaveLength(1)
    expect(items[0]!.text).toContain("When running tests")
  })

  test("handles empty summary", () => {
    expect(parseActionableItems("")).toHaveLength(0)
  })

  test("handles summary with no sections", () => {
    expect(parseActionableItems("Just some text with no headers")).toHaveLength(0)
  })
})
