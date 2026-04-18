/**
 * Tests for the Phase 2 MCP namespace deprecation shim.
 *
 * The shim lives at plugins/tribe/lib/deprecation.ts. It exposes:
 *   - TRIBE_TOOL_RENAMES — the rename table (new, old) pairs
 *   - normalizeToolName(name) — returns the canonical (new) name and warns once
 *   - buildDeprecatedAliasTools(tools) — emits alias entries for tools/list
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest"

import {
  TRIBE_TOOL_RENAMES,
  normalizeToolName,
  buildDeprecatedAliasTools,
  __resetDeprecationWarnings,
} from "../lib/deprecation.ts"

// Capture everything written to stderr during a test.
let stderrSpy: ReturnType<typeof vi.spyOn>
let stderrBuffer: string[]

beforeEach(() => {
  __resetDeprecationWarnings()
  stderrBuffer = []
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrBuffer.push(String(chunk))
    return true
  })
})

afterEach(() => {
  stderrSpy.mockRestore()
})

describe("TRIBE_TOOL_RENAMES (rename table)", () => {
  test("every legacy lore.* and tribe_* name maps to a tribe.* new name", () => {
    for (const [nu, old] of TRIBE_TOOL_RENAMES) {
      expect(nu.startsWith("tribe.")).toBe(true)
      expect(old.startsWith("lore.") || old.startsWith("tribe_")).toBe(true)
    }
  })

  test("contains all 16 expected renames", () => {
    const expected = new Set([
      "lore.ask",
      "lore.current_brief",
      "lore.plan_only",
      "lore.session_state",
      "lore.workspace_state",
      "lore.inject_delta",
      "tribe_send",
      "tribe_broadcast",
      "tribe_sessions",
      "tribe_history",
      "tribe_rename",
      "tribe_health",
      "tribe_join",
      "tribe_reload",
      "tribe_retro",
      "tribe_leadership",
    ])
    const actualOld = new Set(TRIBE_TOOL_RENAMES.map(([, old]) => old))
    expect(actualOld).toEqual(expected)
  })

  test("new names are all unique", () => {
    const news = TRIBE_TOOL_RENAMES.map(([nu]) => nu)
    expect(new Set(news).size).toBe(news.length)
  })

  test("old names are all unique", () => {
    const olds = TRIBE_TOOL_RENAMES.map(([, old]) => old)
    expect(new Set(olds).size).toBe(olds.length)
  })
})

describe("normalizeToolName()", () => {
  test("translates lore.ask to tribe.ask and warns", () => {
    const result = normalizeToolName("lore.ask")
    expect(result).toBe("tribe.ask")
    expect(stderrBuffer.length).toBe(1)
    expect(stderrBuffer[0]).toContain("[deprecated]")
    expect(stderrBuffer[0]).toContain("'lore.ask'")
    expect(stderrBuffer[0]).toContain("'tribe.ask'")
    expect(stderrBuffer[0]).toContain("0.10")
  })

  test("leaves tribe.ask unchanged and emits no warning", () => {
    const result = normalizeToolName("tribe.ask")
    expect(result).toBe("tribe.ask")
    expect(stderrBuffer).toEqual([])
  })

  test("translates tribe_send to tribe.send and warns", () => {
    const result = normalizeToolName("tribe_send")
    expect(result).toBe("tribe.send")
    expect(stderrBuffer.length).toBe(1)
    expect(stderrBuffer[0]).toContain("'tribe_send'")
    expect(stderrBuffer[0]).toContain("'tribe.send'")
  })

  test("warns exactly once per old name across repeated calls", () => {
    normalizeToolName("lore.ask")
    normalizeToolName("lore.ask")
    normalizeToolName("lore.ask")
    expect(stderrBuffer.length).toBe(1)
  })

  test("warns independently for different old names", () => {
    normalizeToolName("lore.ask")
    normalizeToolName("tribe_send")
    normalizeToolName("lore.ask") // no additional warning
    normalizeToolName("tribe_send") // no additional warning
    expect(stderrBuffer.length).toBe(2)
  })

  test("every old name in the rename table normalizes to its new partner", () => {
    for (const [nu, old] of TRIBE_TOOL_RENAMES) {
      __resetDeprecationWarnings()
      expect(normalizeToolName(old)).toBe(nu)
    }
  })

  test("unknown tool names pass through unchanged with no warning", () => {
    const result = normalizeToolName("not_a_tribe_tool")
    expect(result).toBe("not_a_tribe_tool")
    expect(stderrBuffer).toEqual([])
  })
})

describe("buildDeprecatedAliasTools()", () => {
  test("emits one alias per tool for known canonical names", () => {
    const base = [
      { name: "tribe.ask", description: "LLM recall" },
      { name: "tribe.send", description: "Send a message" },
    ]
    const aliases = buildDeprecatedAliasTools(base)
    expect(aliases).toHaveLength(2)
    const names = aliases.map((t) => t.name).sort()
    expect(names).toEqual(["lore.ask", "tribe_send"])
  })

  test("alias description is prefixed with [deprecated alias of ...]", () => {
    const base = [{ name: "tribe.ask", description: "LLM recall" }]
    const [alias] = buildDeprecatedAliasTools(base)
    expect(alias).toBeDefined()
    expect(alias!.name).toBe("lore.ask")
    expect(alias!.description).toMatch(/^\[deprecated alias of tribe\.ask\]/)
    expect(alias!.description).toContain("LLM recall")
  })

  test("preserves other fields on each alias (inputSchema etc.)", () => {
    type Tool = { name: string; description: string; inputSchema: { required: string[] } }
    const base: Tool[] = [
      {
        name: "tribe.ask",
        description: "LLM recall",
        inputSchema: { required: ["query"] },
      },
    ]
    const [alias] = buildDeprecatedAliasTools<Tool>(base)
    expect(alias!.inputSchema).toEqual({ required: ["query"] })
  })

  test("skips tools that have no mapped deprecated alias", () => {
    const base = [
      { name: "tribe.ask", description: "A" },
      { name: "tribe.brand_new", description: "no alias" },
    ]
    const aliases = buildDeprecatedAliasTools(base)
    expect(aliases).toHaveLength(1)
    expect(aliases[0]!.name).toBe("lore.ask")
  })

  test("works on the full canonical tool list", () => {
    const canonical = TRIBE_TOOL_RENAMES.map(([nu]) => ({ name: nu, description: "x" }))
    const aliases = buildDeprecatedAliasTools(canonical)
    expect(aliases).toHaveLength(TRIBE_TOOL_RENAMES.length)
    const expectedOld = new Set(TRIBE_TOOL_RENAMES.map(([, old]) => old))
    const actualOld = new Set(aliases.map((a) => a.name))
    expect(actualOld).toEqual(expectedOld)
  })
})
