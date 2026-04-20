import { describe, expect, it } from "vitest"
import { buildOutputPath, slugify } from "./format"

describe("slugify", () => {
  it("lowercases, strips non-alnum, joins first 4 words", () => {
    expect(slugify("Hello World, This Is A Test!")).toBe("hello-world-this-is")
  })

  it("returns empty string for whitespace-only input", () => {
    expect(slugify("   ")).toBe("")
  })

  it("truncates to 40 chars", () => {
    const slug = slugify("supercalifragilisticexpialidocious another word here")
    expect(slug.length).toBeLessThanOrEqual(40)
  })
})

describe("buildOutputPath", () => {
  it("uses /tmp/llm- prefix and .txt suffix", () => {
    const p = buildOutputPath("abc12345", "hello world")
    expect(p.startsWith("/tmp/llm-abc12345-")).toBe(true)
    expect(p.endsWith(".txt")).toBe(true)
  })

  it("includes slugified topic in filename", () => {
    const p = buildOutputPath("sess1234", "Backdrop Hardening Review")
    expect(p).toMatch(/^\/tmp\/llm-sess1234-backdrop-hardening-review-[a-z0-9]{4}\.txt$/)
  })

  it("falls back to a timestamp when topic is empty", () => {
    const p = buildOutputPath("manual", "")
    expect(p).toMatch(/^\/tmp\/llm-manual-\d+-[a-z0-9]{4}\.txt$/)
  })

  it("falls back to a timestamp when topic is undefined", () => {
    const p = buildOutputPath("manual")
    expect(p).toMatch(/^\/tmp\/llm-manual-\d+-[a-z0-9]{4}\.txt$/)
  })

  it("produces unique paths across calls with same input", () => {
    const a = buildOutputPath("s", "topic")
    const b = buildOutputPath("s", "topic")
    expect(a).not.toBe(b)
  })

  it("falls back to timestamp when topic is only punctuation (slugify returns empty)", () => {
    const p = buildOutputPath("manual", "!!!---")
    // No alphanumerics — slug will be empty → timestamp fallback
    expect(p).toMatch(/^\/tmp\/llm-manual-\d+-[a-z0-9]{4}\.txt$/)
  })
})
