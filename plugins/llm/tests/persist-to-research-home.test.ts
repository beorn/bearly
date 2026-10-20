/**
 * @failure persistToResearch resolved its research root from os.homedir(), which Bun fixes at
 *          process start and which ignores a redirected HOME — so the suite wrote
 *          .claude/projects/.../memory/research Markdown under the guard/real home.
 * @level   l0
 * @consumer @bearly/llm recall archiving; @i/17-test-system/25265
 * @reach   fs-walk <fixture-only: project dir is a mkdtempSync directory under tmpdir>
 * @testonly none
 *
 * This probe writes one note under a redirected HOME and asserts it landed in the fixture — and
 * that nothing new appeared under os.homedir(). A second case keeps the default-path archive
 * (filename shape + frontmatter) covered.
 */
import { afterEach, describe, expect, it } from "vitest"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { makeTestEnv, type TestEnv } from "./helpers"

let env: TestEnv | undefined

afterEach(() => {
  delete process.env.CLAUDE_PROJECT_DIR
  env = undefined
})

describe("persistToResearch home isolation (#25265)", () => {
  it("writes the research note under the redirected HOME, not os.homedir()", async () => {
    env = makeTestEnv()
    const projectDir = join(env.tmpDir, "proj")
    process.env.CLAUDE_PROJECT_DIR = projectDir

    const encoded = projectDir.replace(/\//g, "-")
    const fixtureDir = join(env.homeDir, ".claude/projects", encoded, "memory/research")
    const defaultDir = join(homedir(), ".claude/projects", encoded, "memory/research")
    const defaultBefore = existsSync(defaultDir) ? readdirSync(defaultDir).length : 0

    const { persistToResearch } = await import("../src/lib/format")
    persistToResearch("note body", "testsess12345678", { query: "home isolation probe", model: "test-model" })

    expect(existsSync(fixtureDir)).toBe(true)
    expect(readdirSync(fixtureDir).length).toBe(1)

    const defaultAfter = existsSync(defaultDir) ? readdirSync(defaultDir).length : 0
    expect(defaultAfter).toBe(defaultBefore)
  })

  it("still archives the note under HOME on the normal path", async () => {
    env = makeTestEnv()
    const projectDir = join(env.tmpDir, "proj")
    process.env.CLAUDE_PROJECT_DIR = projectDir
    const encoded = projectDir.replace(/\//g, "-")
    const dir = join(env.homeDir, ".claude/projects", encoded, "memory/research")

    const { persistToResearch, buildMetaComment } = await import("../src/lib/format")
    // 30170: archive/frontmatter and file headers must retain the same independent meanings as JSON.
    // The envelope suite never inspects these persisted reader boundaries.
    const meta = {
      query: "normal path probe",
      model: "test-model",
      tokens: 42,
      usage: {
        promptTokens: 40,
        completionTokens: 2,
        totalTokens: 42,
        classes: { input: 40, output: 2 },
        raw: { invoice: "original-archive" },
      },
      cost_usd: 0,
      list_equivalent_usd: 0.25,
      list_equivalent_basis: [{ rateSource: "sku" as const, matchedModelId: "test-model" }],
    }
    persistToResearch("note body", "testsess12345678", meta)

    const files = readdirSync(dir)
    expect(files.length).toBe(1)
    expect(files[0]).toMatch(/^\d{8}-\d{6}\d{3}-normal-path-probe-[a-z0-9]{4}\.md$/)
    const text = readFileSync(join(dir, files[0]!), "utf-8")
    expect(text).toContain('query: "normal path probe"')
    expect(text).toContain('model: "test-model"')
    expect(text).toContain("tokens: 42")
    expect(text).toContain(`usage: ${JSON.stringify(meta.usage)}\n`)
    expect(text).toContain("cost_usd: 0\n")
    expect(text).toContain("list_equivalent_usd: 0.25\n")
    expect(text).toContain('list_equivalent_basis: [{"rateSource":"sku","matchedModelId":"test-model"}]')
    expect(text).not.toContain("\ncost:")
    const header = buildMetaComment("testsess12345678", meta)
    const fields = JSON.parse(header.slice("<!-- llm-meta: ".length, -" -->".length)) as Record<string, unknown>
    expect(fields.cost_usd).toBe(0)
    expect(fields.list_equivalent_usd).toBe(0.25)
    expect(fields.list_equivalent_basis).toEqual(meta.list_equivalent_basis)
    expect(fields.usage).toEqual(meta.usage)
    expect(fields).not.toHaveProperty("cost")
    expect(text.endsWith("note body")).toBe(true)
  })
})
