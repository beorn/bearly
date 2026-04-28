import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as os from "node:os"
import * as path from "node:path"
import { buildOutputPath, getOutputDir, slugify } from "./format"

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
  const tmp = os.tmpdir()
  const escTmp = tmp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

  it("uses os.tmpdir() llm- prefix and .txt suffix by default", () => {
    delete process.env.BEARLY_LLM_OUTPUT_DIR
    const p = buildOutputPath("abc12345", "hello world")
    expect(p.startsWith(path.join(tmp, "llm-abc12345-"))).toBe(true)
    expect(p.endsWith(".txt")).toBe(true)
  })

  it("includes slugified topic in filename", () => {
    delete process.env.BEARLY_LLM_OUTPUT_DIR
    const p = buildOutputPath("sess1234", "Backdrop Hardening Review")
    expect(p).toMatch(new RegExp(`^${escTmp}/llm-sess1234-backdrop-hardening-review-[a-z0-9]{4}\\.txt$`))
  })

  it("falls back to a timestamp when topic is empty", () => {
    delete process.env.BEARLY_LLM_OUTPUT_DIR
    const p = buildOutputPath("manual", "")
    expect(p).toMatch(new RegExp(`^${escTmp}/llm-manual-\\d+-[a-z0-9]{4}\\.txt$`))
  })

  it("falls back to a timestamp when topic is undefined", () => {
    delete process.env.BEARLY_LLM_OUTPUT_DIR
    const p = buildOutputPath("manual")
    expect(p).toMatch(new RegExp(`^${escTmp}/llm-manual-\\d+-[a-z0-9]{4}\\.txt$`))
  })

  it("produces unique paths across calls with same input", () => {
    const a = buildOutputPath("s", "topic")
    const b = buildOutputPath("s", "topic")
    expect(a).not.toBe(b)
  })

  it("falls back to timestamp when topic is only punctuation (slugify returns empty)", () => {
    delete process.env.BEARLY_LLM_OUTPUT_DIR
    const p = buildOutputPath("manual", "!!!---")
    expect(p).toMatch(new RegExp(`^${escTmp}/llm-manual-\\d+-[a-z0-9]{4}\\.txt$`))
  })
})

describe("getOutputDir", () => {
  let prev: string | undefined
  beforeEach(() => {
    prev = process.env.BEARLY_LLM_OUTPUT_DIR
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.BEARLY_LLM_OUTPUT_DIR
    else process.env.BEARLY_LLM_OUTPUT_DIR = prev
  })

  it("defaults to os.tmpdir()", () => {
    delete process.env.BEARLY_LLM_OUTPUT_DIR
    expect(getOutputDir()).toBe(os.tmpdir())
  })

  it("honours BEARLY_LLM_OUTPUT_DIR override", () => {
    process.env.BEARLY_LLM_OUTPUT_DIR = "/custom/output"
    expect(getOutputDir()).toBe("/custom/output")
  })

  it("buildOutputPath uses the overridden dir", () => {
    process.env.BEARLY_LLM_OUTPUT_DIR = "/custom/out"
    const p = buildOutputPath("sess", "hello")
    expect(p.startsWith("/custom/out/llm-sess-")).toBe(true)
  })
})
