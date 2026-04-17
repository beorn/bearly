/**
 * Summarizer unit tests (pure). Daemon integration with summarizer mocked
 * is covered where needed; here we just pin the JSON parser and mode/model
 * selection — the functions that don't need a live LLM.
 */

import { describe, it, expect } from "vitest"
import { parseSummary, resolveSummarizerMode } from "../../tools/lib/bear/summarizer.ts"

describe("parseSummary", () => {
  it("accepts strict JSON", () => {
    const out = parseSummary('{"focus":"fix layout bug","loose_ends":["rerun tests","update docs"]}')
    expect(out).toEqual({ focus: "fix layout bug", loose_ends: ["rerun tests", "update docs"] })
  })

  it("strips ```json fences", () => {
    const raw = '```json\n{"focus":"publish v0.3","loose_ends":[]}\n```'
    expect(parseSummary(raw)).toEqual({ focus: "publish v0.3", loose_ends: [] })
  })

  it("extracts the first {...} block when wrapped in prose", () => {
    const raw = 'Here\'s the summary:\n{"focus":"investigate CardColumn","loose_ends":[]}\nThanks!'
    expect(parseSummary(raw)).toEqual({ focus: "investigate CardColumn", loose_ends: [] })
  })

  it("filters out non-string loose_ends and trims", () => {
    const out = parseSummary('{"focus":"  trim me  ","loose_ends":["one",null,"two",123," three "]}')
    expect(out).toEqual({ focus: "trim me", loose_ends: ["one", "two", "three"] })
  })

  it("returns null on malformed JSON", () => {
    expect(parseSummary("not json at all")).toBeNull()
    expect(parseSummary("")).toBeNull()
    expect(parseSummary('{"focus":')).toBeNull()
  })

  it("returns null on missing top-level object", () => {
    expect(parseSummary("[]")).toBeNull()
  })

  it("tolerates missing loose_ends (defaults to empty)", () => {
    const out = parseSummary('{"focus":"just focus"}')
    expect(out).toEqual({ focus: "just focus", loose_ends: [] })
  })
})

describe("resolveSummarizerMode", () => {
  it("defaults to off", () => {
    const prev = process.env.BEAR_SUMMARIZER_MODEL
    try {
      delete process.env.BEAR_SUMMARIZER_MODEL
      expect(resolveSummarizerMode()).toBe("off")
    } finally {
      if (prev !== undefined) process.env.BEAR_SUMMARIZER_MODEL = prev
    }
  })

  it("accepts haiku and local, rejects garbage", () => {
    expect(resolveSummarizerMode("haiku")).toBe("haiku")
    expect(resolveSummarizerMode("HAIKU")).toBe("haiku")
    expect(resolveSummarizerMode("local")).toBe("local")
    expect(resolveSummarizerMode("gpt-4")).toBe("off")
    expect(resolveSummarizerMode("")).toBe("off")
  })
})
