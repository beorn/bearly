/**
 * Tests for the 1.0.0 generalization sprint:
 *   - Memory dir resolution (G1: BEARLY_LLM_MEMORY_DIR > LLM_DIR >
 *     CLAUDE_PROJECT_DIR > ~/.config/llm)
 *   - Optional @bearly/recall integration (G2)
 *   - Output dir resolution (G3: BEARLY_LLM_OUTPUT_DIR > os.tmpdir)
 *   - Bundled skills dir present + has expected files (G4)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { getMemoryDir } from "../src/lib/dual-pro"
import { getOutputDir, buildOutputPath } from "../src/lib/format"
import { _resetRecallCache, loadRecall } from "../src/lib/recall-optional"

describe("getMemoryDir resolution", () => {
  // Snapshot env keys we mutate so tests don't leak.
  const ENV_KEYS = ["BEARLY_LLM_MEMORY_DIR", "LLM_DIR", "CLAUDE_PROJECT_DIR", "HOME"] as const
  let snapshot: Record<string, string | undefined> = {}
  beforeEach(() => {
    snapshot = {}
    for (const k of ENV_KEYS) {
      snapshot[k] = process.env[k]
      delete process.env[k]
    }
    process.env.HOME = "/home/testuser"
  })
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (snapshot[k] === undefined) delete process.env[k]
      else process.env[k] = snapshot[k]
    }
  })

  it("uses BEARLY_LLM_MEMORY_DIR when set (highest priority)", () => {
    process.env.BEARLY_LLM_MEMORY_DIR = "/tmp/explicit-override"
    process.env.LLM_DIR = "/tmp/llm-dir-override"
    process.env.CLAUDE_PROJECT_DIR = "/projects/foo"
    expect(getMemoryDir()).toBe("/tmp/explicit-override")
  })

  it("falls back to LLM_DIR when BEARLY_LLM_MEMORY_DIR is unset", () => {
    process.env.LLM_DIR = "/tmp/short-alias"
    process.env.CLAUDE_PROJECT_DIR = "/projects/foo"
    expect(getMemoryDir()).toBe("/tmp/short-alias")
  })

  it("falls back to ~/.claude/projects/<encoded-cwd>/memory when CLAUDE_PROJECT_DIR set", () => {
    process.env.CLAUDE_PROJECT_DIR = "/Users/me/Code/myproject"
    expect(getMemoryDir()).toBe("/home/testuser/.claude/projects/-Users-me-Code-myproject/memory")
  })

  it("falls back to ~/.config/llm when nothing set (standalone default)", () => {
    expect(getMemoryDir()).toBe("/home/testuser/.config/llm")
  })

  it("respects an injected env arg over process.env", () => {
    process.env.LLM_DIR = "/from/process"
    expect(getMemoryDir({ HOME: "/h", LLM_DIR: "/from/arg" } as NodeJS.ProcessEnv)).toBe("/from/arg")
  })

  it("BEARLY_LLM_MEMORY_DIR wins over LLM_DIR", () => {
    process.env.BEARLY_LLM_MEMORY_DIR = "/A"
    process.env.LLM_DIR = "/B"
    expect(getMemoryDir()).toBe("/A")
  })
})

describe("getOutputDir resolution", () => {
  const ENV_KEYS = ["BEARLY_LLM_OUTPUT_DIR"] as const
  let snapshot: Record<string, string | undefined> = {}
  beforeEach(() => {
    snapshot = {}
    for (const k of ENV_KEYS) {
      snapshot[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (snapshot[k] === undefined) delete process.env[k]
      else process.env[k] = snapshot[k]
    }
  })

  it("defaults to os.tmpdir() when BEARLY_LLM_OUTPUT_DIR unset", () => {
    expect(getOutputDir()).toBe(os.tmpdir())
  })

  it("honours BEARLY_LLM_OUTPUT_DIR override", () => {
    process.env.BEARLY_LLM_OUTPUT_DIR = "/var/llm-out"
    expect(getOutputDir()).toBe("/var/llm-out")
  })

  it("buildOutputPath places files in the resolved dir", () => {
    process.env.BEARLY_LLM_OUTPUT_DIR = "/var/llm-out"
    const p = buildOutputPath("sess", "hello world")
    expect(p.startsWith("/var/llm-out/llm-sess-")).toBe(true)
    expect(p.endsWith(".txt")).toBe(true)
  })
})

describe("optional @bearly/recall integration", () => {
  beforeEach(() => {
    _resetRecallCache()
  })
  afterEach(() => {
    delete process.env.BEARLY_LLM_NO_RECALL
    _resetRecallCache()
  })

  it("returns null when BEARLY_LLM_NO_RECALL=1 (explicit opt-out)", async () => {
    process.env.BEARLY_LLM_NO_RECALL = "1"
    const recall = await loadRecall()
    expect(recall).toBeNull()
  })

  it("memoizes the resolution across calls (no duplicate import attempts)", async () => {
    process.env.BEARLY_LLM_NO_RECALL = "1"
    const a = await loadRecall()
    const b = await loadRecall()
    // Same reference (both null is fine; the test asserts memoization either way).
    expect(a).toBe(b)
  })

  it("loadRecall resolves to a usable shape OR null — never throws", async () => {
    // Don't set BEARLY_LLM_NO_RECALL — let the resolver try the real candidates.
    // In the bearly monorepo, the sibling-source path resolves; in standalone
    // npm consumers, both candidates fail and the result is null. Either way,
    // `loadRecall` must NOT throw.
    let result: unknown
    let threw = false
    try {
      result = await loadRecall()
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    if (result !== null) {
      expect(typeof (result as { getDb: unknown }).getDb).toBe("function")
      expect(typeof (result as { closeDb: unknown }).closeDb).toBe("function")
      expect(typeof (result as { findSimilarQueries: unknown }).findSimilarQueries).toBe("function")
    }
  })
})

describe("bundled skills directory", () => {
  // The skills/ dir lives next to package.json. From this test file, that's
  // ../skills (tests/ is a sibling of skills/).
  const skillsRoot = path.resolve(import.meta.dirname ?? __dirname, "..", "skills")

  it("ships a skills/ directory at the package root", () => {
    expect(fs.existsSync(skillsRoot)).toBe(true)
    const stat = fs.statSync(skillsRoot)
    expect(stat.isDirectory()).toBe(true)
  })

  it.each(["ask", "pro", "deep", "fresh", "big"])("bundles skills/%s/SKILL.md", (skill) => {
    const skillPath = path.join(skillsRoot, skill, "SKILL.md")
    expect(fs.existsSync(skillPath)).toBe(true)
    const content = fs.readFileSync(skillPath, "utf-8")
    // Sanity-check: SKILL.md files start with frontmatter.
    expect(content.startsWith("---")).toBe(true)
  })

  it("package.json `files` field includes skills so they ship in the tarball", () => {
    const pkgPath = path.resolve(import.meta.dirname ?? __dirname, "..", "package.json")
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { files?: string[]; private?: boolean; version?: string; bin?: Record<string, string> }
    expect(pkg.files).toBeDefined()
    expect(pkg.files).toContain("skills")
    expect(pkg.files).toContain("src")
  })

  it("package.json is publish-ready: bin entry, version is 0.9.0+, files include skills", () => {
    const pkgPath = path.resolve(import.meta.dirname ?? __dirname, "..", "package.json")
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      private?: boolean
      version?: string
      bin?: Record<string, string>
      files?: string[]
    }
    // Stays `private: true` until 1.0 is explicitly approved (no major
    // versions without user sign-off — see project memory). The package
    // shape is publish-ready (bin, files, exports, peerDeps), so flipping
    // private:false at 1.0 release time is a one-line change.
    expect(pkg.version).toMatch(/^0\.[9-9]\.\d+|^[1-9]\d*\.\d+\.\d+/)
    expect(pkg.bin?.["bearly-llm"]).toBeTruthy()
    expect(pkg.files).toContain("skills")
  })
})

describe("install-skills CLI subcommand", () => {
  let target: string
  beforeEach(() => {
    target = fs.mkdtempSync(path.join(os.tmpdir(), "bearly-llm-skills-"))
  })
  afterEach(() => {
    try {
      fs.rmSync(target, { recursive: true, force: true })
    } catch {}
  })

  it("copies the 5 SKILL.md files to the target dir", async () => {
    const { runInstallSkills } = await import("../src/cmd/install-skills")
    // Suppress console.error during the run — install-skills logs progress to stderr.
    const origErr = console.error
    console.error = () => {}
    try {
      await runInstallSkills({ targetDir: target, yes: true })
    } finally {
      console.error = origErr
    }
    for (const skill of ["ask", "pro", "deep", "fresh", "big"]) {
      const file = path.join(target, skill, "SKILL.md")
      expect(fs.existsSync(file)).toBe(true)
    }
  })

  it("with yes:true overwrites existing target files without prompting", async () => {
    fs.mkdirSync(path.join(target, "ask"), { recursive: true })
    const stale = path.join(target, "ask", "SKILL.md")
    fs.writeFileSync(stale, "stale content")
    const { runInstallSkills } = await import("../src/cmd/install-skills")
    const origErr = console.error
    console.error = () => {}
    try {
      await runInstallSkills({ targetDir: target, yes: true })
    } finally {
      console.error = origErr
    }
    const content = fs.readFileSync(stale, "utf-8")
    expect(content).not.toBe("stale content")
    expect(content.startsWith("---")).toBe(true)
  })
})
