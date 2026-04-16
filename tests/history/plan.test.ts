/**
 * Tests for the recall query planner — pure JSON parsing + variant flattening.
 * (The LLM call path is tested via integration, not unit.)
 */

import { describe, test, expect } from "vitest"
import { parsePlan, planVariants, type QueryPlan } from "../../tools/recall/plan"

describe("parsePlan", () => {
  test("parses a well-formed JSON plan", () => {
    const raw = JSON.stringify({
      keywords: ["column", "layout"],
      phrases: ["column width"],
      concepts: ["flexbox"],
      paths: ["CardColumn.tsx"],
      errors: [],
      bead_ids: ["km-tui.columns"],
      time_hint: "1w",
      notes: "Found column-layout work in recent sessions.",
    })

    const plan = parsePlan(raw)
    expect(plan).not.toBeNull()
    expect(plan!.keywords).toEqual(["column", "layout"])
    expect(plan!.phrases).toEqual(["column width"])
    expect(plan!.paths).toEqual(["CardColumn.tsx"])
    expect(plan!.bead_ids).toEqual(["km-tui.columns"])
    expect(plan!.time_hint).toBe("1w")
    expect(plan!.notes).toBeDefined()
  })

  test("handles ```json fenced blocks", () => {
    const raw =
      '```json\n{"keywords": ["foo"], "phrases": [], "concepts": [], "paths": [], "errors": [], "bead_ids": [], "time_hint": null}\n```'
    const plan = parsePlan(raw)
    expect(plan).not.toBeNull()
    expect(plan!.keywords).toEqual(["foo"])
  })

  test("extracts JSON from prose wrapping", () => {
    const raw =
      'Here is the plan: {"keywords": ["bar"], "phrases": [], "concepts": [], "paths": [], "errors": [], "bead_ids": [], "time_hint": null} — hope this helps!'
    const plan = parsePlan(raw)
    expect(plan).not.toBeNull()
    expect(plan!.keywords).toEqual(["bar"])
  })

  test("normalizes missing/non-array fields to empty arrays", () => {
    const plan = parsePlan('{"keywords": "not-an-array", "phrases": ["ok"]}')
    expect(plan).not.toBeNull()
    expect(plan!.keywords).toEqual([])
    expect(plan!.phrases).toEqual(["ok"])
    expect(plan!.concepts).toEqual([])
    expect(plan!.time_hint).toBeNull()
  })

  test("filters empty and non-string entries from arrays", () => {
    const plan = parsePlan('{"keywords": ["foo", "", "   ", 42, null, "bar"]}')
    expect(plan).not.toBeNull()
    expect(plan!.keywords).toEqual(["foo", "bar"])
  })

  test("rejects a plan with zero usable variants", () => {
    const plan = parsePlan('{"keywords": [], "phrases": [], "concepts": [], "paths": [], "errors": [], "bead_ids": []}')
    expect(plan).toBeNull()
  })

  test("rejects non-JSON garbage", () => {
    expect(parsePlan("not json at all")).toBeNull()
    expect(parsePlan("")).toBeNull()
    expect(parsePlan("{")).toBeNull()
  })

  test("rejects a JSON array at top level", () => {
    expect(parsePlan("[1, 2, 3]")).toBeNull()
  })

  test("trims whitespace from string entries", () => {
    const plan = parsePlan('{"keywords": ["  foo  ", "\\tbar\\n"]}')
    expect(plan).not.toBeNull()
    expect(plan!.keywords).toEqual(["foo", "bar"])
  })
})

describe("planVariants", () => {
  test("flattens all buckets into unique variants", () => {
    const plan: QueryPlan = {
      keywords: ["foo", "bar"],
      phrases: ["multi word"],
      concepts: ["concept-a"],
      paths: ["File.ts"],
      errors: ["some error"],
      bead_ids: ["km-x.y"],
      time_hint: null,
    }
    const variants = planVariants(plan)
    expect(variants).toContain("foo")
    expect(variants).toContain("bar")
    expect(variants).toContain('"multi word"')
    expect(variants).toContain("concept-a")
    expect(variants).toContain("File.ts")
    expect(variants).toContain('"some error"')
    expect(variants).toContain("km-x.y")
  })

  test("quotes multi-word phrases but not single words", () => {
    const plan: QueryPlan = {
      keywords: [],
      phrases: ["solo", "two words", "three word phrase"],
      concepts: [],
      paths: [],
      errors: [],
      bead_ids: [],
      time_hint: null,
    }
    const variants = planVariants(plan)
    expect(variants).toContain("solo") // single word, no quotes
    expect(variants).toContain('"two words"')
    expect(variants).toContain('"three word phrase"')
  })

  test("dedupes across buckets", () => {
    const plan: QueryPlan = {
      keywords: ["column"],
      phrases: [],
      concepts: ["column"],
      paths: [],
      errors: [],
      bead_ids: [],
      time_hint: null,
    }
    expect(planVariants(plan)).toEqual(["column"])
  })

  test("skips entries shorter than 2 chars", () => {
    const plan: QueryPlan = {
      keywords: ["ok", "x", "  ", "foo"],
      phrases: [],
      concepts: [],
      paths: [],
      errors: [],
      bead_ids: [],
      time_hint: null,
    }
    const variants = planVariants(plan)
    expect(variants).toContain("ok")
    expect(variants).toContain("foo")
    expect(variants).not.toContain("x")
  })
})
