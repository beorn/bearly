import { describe, test, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { execSync } from "child_process"

// Import to trigger registration
import { RipgrepBackend, findPatterns, createPatternReplaceProposal } from "../../tools/lib/backends/ripgrep"
import { getBackendByName, getBackends } from "../../tools/lib/backend"
import { applyEditset } from "../../tools/lib/core/apply"

describe("ripgrep backend", () => {
  describe("registration", () => {
    test("registers with correct name", () => {
      const backend = getBackendByName("ripgrep")
      expect(backend).not.toBeNull()
      expect(backend?.name).toBe("ripgrep")
    })

    test("registers with wildcard extension", () => {
      expect(RipgrepBackend.extensions).toContain("*")
    })

    test("has lowest priority (fallback)", () => {
      const backends = getBackends()
      const ripgrep = backends.find((b) => b.name === "ripgrep")
      const others = backends.filter((b) => b.name !== "ripgrep")

      expect(ripgrep).toBeDefined()
      for (const other of others) {
        expect(ripgrep!.priority).toBeLessThan(other.priority)
      }
    })

    test("implements findPatterns", () => {
      expect(typeof RipgrepBackend.findPatterns).toBe("function")
    })

    test("implements createPatternReplaceProposal", () => {
      expect(typeof RipgrepBackend.createPatternReplaceProposal).toBe("function")
    })
  })

  describe("findPatterns", () => {
    let tempDir: string

    beforeAll(() => {
      tempDir = mkdtempSync(join(tmpdir(), "ripgrep-test-"))
      // Create test files
      writeFileSync(join(tempDir, "test.md"), "# Hello World\n\nThis is a widget example.\n")
      writeFileSync(join(tempDir, "test2.txt"), "Another widget here.\n")
    })

    afterAll(() => {
      rmSync(tempDir, { recursive: true, force: true })
    })

    test("finds text patterns in files", () => {
      try {
        // Check if rg is available
        execSync("which rg", { stdio: "pipe" })
      } catch {
        // Skip test if rg not installed
        console.log("Skipping test: ripgrep (rg) not installed")
        return
      }

      const cwd = process.cwd()
      try {
        process.chdir(tempDir)
        const refs = findPatterns("widget")
        expect(refs.length).toBeGreaterThanOrEqual(2)
        expect(refs.some((r) => r.file.includes("test.md"))).toBe(true)
        expect(refs.some((r) => r.file.includes("test2.txt"))).toBe(true)
      } finally {
        process.chdir(cwd)
      }
    })

    test("respects glob filter", () => {
      try {
        execSync("which rg", { stdio: "pipe" })
      } catch {
        console.log("Skipping test: ripgrep (rg) not installed")
        return
      }

      const cwd = process.cwd()
      try {
        process.chdir(tempDir)
        const refs = findPatterns("widget", "*.md")
        expect(refs.every((r) => r.file.endsWith(".md"))).toBe(true)
      } finally {
        process.chdir(cwd)
      }
    })
  })

  describe("createPatternReplaceProposal", () => {
    let tempDir: string

    beforeAll(() => {
      tempDir = mkdtempSync(join(tmpdir(), "ripgrep-replace-test-"))
      writeFileSync(join(tempDir, "doc.md"), "The widget is great.\nWidgets are useful.\n")
    })

    afterAll(() => {
      rmSync(tempDir, { recursive: true, force: true })
    })

    test("creates editset with correct structure", () => {
      try {
        execSync("which rg", { stdio: "pipe" })
      } catch {
        console.log("Skipping test: ripgrep (rg) not installed")
        return
      }

      const cwd = process.cwd()
      try {
        process.chdir(tempDir)
        const editset = createPatternReplaceProposal("widget", "gadget")

        expect(editset.operation).toBe("rename")
        expect(editset.from).toBe("widget")
        expect(editset.to).toBe("gadget")
        expect(Array.isArray(editset.refs)).toBe(true)
        expect(Array.isArray(editset.edits)).toBe(true)
        expect(editset.createdAt).toBeDefined()

        // Should find at least one match
        expect(editset.refs.length).toBeGreaterThanOrEqual(1)
      } finally {
        process.chdir(cwd)
      }
    })

    test("generates correct edits for replacement", () => {
      try {
        execSync("which rg", { stdio: "pipe" })
      } catch {
        console.log("Skipping test: ripgrep (rg) not installed")
        return
      }

      const cwd = process.cwd()
      try {
        process.chdir(tempDir)
        const editset = createPatternReplaceProposal("widget", "gadget")

        for (const edit of editset.edits) {
          expect(edit.file).toBeDefined()
          expect(typeof edit.offset).toBe("number")
          expect(typeof edit.length).toBe("number")
          // Case-preserving: lowercase "widget" → "gadget", uppercase "Widget" → "Gadget"
          expect(["gadget", "Gadget", "GADGET"]).toContain(edit.replacement)
        }
      } finally {
        process.chdir(cwd)
      }
    })
  })

  describe("UTF-8 multi-byte character handling", () => {
    let tempDir: string

    beforeAll(() => {
      tempDir = mkdtempSync(join(tmpdir(), "ripgrep-utf8-test-"))
      // Create test file with UTF-8 multi-byte characters
      writeFileSync(join(tempDir, "utf8.md"), "# Default/Preferred Vault\n\nThe vault → repo migration is important.\n")
    })

    afterAll(() => {
      rmSync(tempDir, { recursive: true, force: true })
    })

    test("correctly calculates byte offsets with UTF-8 characters", () => {
      try {
        execSync("which rg", { stdio: "pipe" })
      } catch {
        console.log("Skipping test: ripgrep (rg) not installed")
        return
      }

      const cwd = process.cwd()
      try {
        process.chdir(tempDir)
        const editset = createPatternReplaceProposal("vault", "repo", "*.md", true)

        // Should find 2 occurrences
        expect(editset.refs.length).toBe(2)
        expect(editset.edits.length).toBe(2)

        // Verify edits have correct replacements
        const replacements = editset.edits.map((e) => e.replacement)
        expect(replacements).toContain("repo") // from "vault → repo"
        expect(replacements).toContain("Repo") // from "Preferred Vault"
      } finally {
        process.chdir(cwd)
      }
    })

    test("applies edits correctly with UTF-8 characters", () => {
      try {
        execSync("which rg", { stdio: "pipe" })
      } catch {
        console.log("Skipping test: ripgrep (rg) not installed")
        return
      }

      const cwd = process.cwd()
      try {
        process.chdir(tempDir)
        const editset = createPatternReplaceProposal("vault", "repo", "*.md", true)

        // Read the file content
        const content = readFileSync(join(tempDir, "utf8.md"), "utf-8")

        // Apply edits manually to verify they work
        for (const edit of editset.edits) {
          const before = content.slice(edit.offset, edit.offset + edit.length)
          // Verify the matched text is correct (should be "vault" or "Vault", not garbage)
          expect(before.toLowerCase()).toBe("vault")
        }
      } finally {
        process.chdir(cwd)
      }
    })
  })

  describe("repeatable include/exclude globs (20187)", () => {
    let tempDir: string

    beforeAll(() => {
      tempDir = mkdtempSync(join(tmpdir(), "ripgrep-globs-test-"))
      writeFileSync(join(tempDir, "code.ts"), 'const widget = "x"\n')
      writeFileSync(join(tempDir, "doc.md"), "The widget doc.\n")
      // A bead-style markdown file under @km/ — the bead-safety exclusion target.
      mkdirSync(join(tempDir, "@km"), { recursive: true })
      writeFileSync(join(tempDir, "@km/note.md"), "The widget bead.\n")
    })

    afterAll(() => {
      rmSync(tempDir, { recursive: true, force: true })
    })

    function skipIfNoRg(): boolean {
      try {
        execSync("which rg", { stdio: "pipe" })
        return false
      } catch {
        console.log("Skipping test: ripgrep (rg) not installed")
        return true
      }
    }

    test("a single include glob (array of one) still works", () => {
      if (skipIfNoRg()) return
      const cwd = process.cwd()
      try {
        process.chdir(tempDir)
        const refs = findPatterns("widget", ["*.ts"])
        expect(refs.length).toBe(1)
        expect(refs.every((r) => r.file.endsWith(".ts"))).toBe(true)
      } finally {
        process.chdir(cwd)
      }
    })

    test("multiple include globs union their matches", () => {
      if (skipIfNoRg()) return
      const cwd = process.cwd()
      try {
        process.chdir(tempDir)
        const refs = findPatterns("widget", ["*.ts", "doc.md"])
        const files = refs.map((r) => r.file)
        expect(files.some((f) => f.endsWith("code.ts"))).toBe(true)
        expect(files.some((f) => f.endsWith("doc.md"))).toBe(true)
        // @km/note.md is NOT in the include set.
        expect(files.some((f) => f.includes("@km/"))).toBe(false)
      } finally {
        process.chdir(cwd)
      }
    })

    test("exclude glob (! prefix) drops matching files — bead-safety", () => {
      if (skipIfNoRg()) return
      const cwd = process.cwd()
      try {
        process.chdir(tempDir)
        // Include everything, then exclude bead markdown under @km/.
        const refs = findPatterns("widget", ["**/*", "!@km/**/*.md"])
        const files = refs.map((r) => r.file)
        expect(files.some((f) => f.endsWith("code.ts"))).toBe(true)
        // doc.md at root is still searched (it is not under @km/).
        expect(files.some((f) => f.endsWith("doc.md"))).toBe(true)
        // The bead file is excluded.
        expect(files.some((f) => f.includes("@km/"))).toBe(false)
      } finally {
        process.chdir(cwd)
      }
    })

    test("createPatternReplaceProposal honors the exclude glob", () => {
      if (skipIfNoRg()) return
      const cwd = process.cwd()
      try {
        process.chdir(tempDir)
        const editset = createPatternReplaceProposal("widget", "gadget", ["**/*", "!@km/**/*.md"])
        expect(editset.refs.some((r) => r.file.includes("@km/"))).toBe(false)
        expect(editset.refs.some((r) => r.file.endsWith("code.ts"))).toBe(true)
      } finally {
        process.chdir(cwd)
      }
    })
  })

  describe("case-insensitive search and case-preserving replace", () => {
    let tempDir: string

    beforeAll(() => {
      tempDir = mkdtempSync(join(tmpdir(), "ripgrep-case-test-"))
      // Create test files with different case variants
      writeFileSync(
        join(tempDir, "mixed-case.ts"),
        `
const vault = "lowercase"
const Vault = "PascalCase"
const VAULT = "SCREAMING_CASE"
const vaultPath = "camelCaseCompound"
const VaultConfig = "PascalCaseCompound"
const VAULT_ROOT = "SCREAMING_COMPOUND"
`,
      )
    })

    afterAll(() => {
      rmSync(tempDir, { recursive: true, force: true })
    })

    test("finds all case variants with -i flag", () => {
      try {
        execSync("which rg", { stdio: "pipe" })
      } catch {
        console.log("Skipping test: ripgrep (rg) not installed")
        return
      }

      const cwd = process.cwd()
      try {
        process.chdir(tempDir)
        const refs = findPatterns("vault", "*.ts", true)

        // Should find all 6 occurrences
        expect(refs.length).toBe(6)
      } finally {
        process.chdir(cwd)
      }
    })

    test("preserves case in replacement", () => {
      try {
        execSync("which rg", { stdio: "pipe" })
      } catch {
        console.log("Skipping test: ripgrep (rg) not installed")
        return
      }

      const cwd = process.cwd()
      try {
        process.chdir(tempDir)
        const editset = createPatternReplaceProposal("vault", "repo", "*.ts", true)

        // Build a map of what each edit replaces
        const replacements = editset.edits.map((e) => e.replacement)

        // Should have case-preserving replacements
        expect(replacements).toContain("repo") // lowercase
        expect(replacements).toContain("Repo") // PascalCase
        expect(replacements).toContain("REPO") // SCREAMING_CASE
      } finally {
        process.chdir(cwd)
      }
    })
  })

  describe("hidden dot-directories are searched (--hidden regression)", () => {
    let tempDir: string

    beforeAll(() => {
      tempDir = mkdtempSync(join(tmpdir(), "ripgrep-hidden-test-"))
      // `.claude/` and `.agents/` are TRACKED trees (skills, tent scripts) that
      // ripgrep skips by default — a refactor that missed them silently dropped
      // whole surfaces. This pins that findPatterns descends into dot-directories.
      mkdirSync(join(tempDir, ".claude/skills"), { recursive: true })
      writeFileSync(join(tempDir, ".claude/skills/handle.ts"), 'const a = "@agent/7"\n')
      writeFileSync(join(tempDir, "visible.ts"), 'const b = "@agent/7"\n')
    })

    afterAll(() => {
      rmSync(tempDir, { recursive: true, force: true })
    })

    test("findPatterns finds matches under dot-directories, not just visible files", () => {
      try {
        execSync("which rg", { stdio: "pipe" })
      } catch {
        console.log("Skipping test: ripgrep (rg) not installed")
        return
      }
      const cwd = process.cwd()
      try {
        process.chdir(tempDir)
        const refs = findPatterns("@agent/")
        const files = refs.map((r) => r.file)
        // The regression: the dot-dir file must be found (was dropped before --hidden).
        expect(files.some((f) => f.includes(".claude/skills/handle.ts"))).toBe(true)
        expect(files.some((f) => f.endsWith("visible.ts"))).toBe(true)
      } finally {
        process.chdir(cwd)
      }
    })

    test("does not descend into .git — a refactor never proposes edits to repository internals", () => {
      try {
        execSync("which rg", { stdio: "pipe" })
      } catch {
        console.log("Skipping test: ripgrep (rg) not installed")
        return
      }
      const cwd = process.cwd()
      try {
        process.chdir(tempDir)
        mkdirSync(join(tempDir, ".git/worktrees/scratch"), { recursive: true })
        writeFileSync(join(tempDir, ".git/worktrees/scratch/copy.ts"), 'const c = "@agent/7"\n')
        const refs = findPatterns("@agent/")
        expect(refs.some((r) => r.file.includes(".git/"))).toBe(false)
      } finally {
        process.chdir(cwd)
      }
    })
  })

  describe("offset contract — every emitted edit points at the text it matched", () => {
    let tempDir: string

    // Each fixture pairs a file with the multibyte shape that made byte offsets and
    // character offsets diverge in real prose. `expected` is the whole file after apply.
    const FIXTURES: { name: string; write: () => Buffer | string; expected: string }[] = [
      {
        name: "ascii.md",
        write: () => "line one\nsee @tent/@dev here\ntail\n",
        expected: "line one\nsee @tent/agents/@dev here\ntail\n",
      },
      {
        name: "emdash-same-line.md",
        write: () => "prefix — em dash → @tent/@dev here\n",
        expected: "prefix — em dash → @tent/agents/@dev here\n",
      },
      {
        name: "emdash-earlier-line.md",
        write: () => "héader ünicode ✓ ✗ ★\nsee @tent/@dev here\n",
        expected: "héader ünicode ✓ ✗ ★\nsee @tent/agents/@dev here\n",
      },
      {
        name: "astral.md", // emoji are surrogate pairs: 4 bytes, 2 UTF-16 code units
        write: () => "emoji 🎉🎉🎉 header\nsee @tent/@dev here\n",
        expected: "emoji 🎉🎉🎉 header\nsee @tent/agents/@dev here\n",
      },
      {
        name: "cjk.md",
        write: () => "日本語のテキストです\n@tent/@chief line\n",
        expected: "日本語のテキストです\n@tent/agents/@chief line\n",
      },
      {
        name: "box-drawing.md", // the ascii-art tables that fill this repo's docs
        write: () => "╔══════╗\n║ tbl  ║\n╚══════╝\nsee @tent/@fleet\n",
        expected: "╔══════╗\n║ tbl  ║\n╚══════╝\nsee @tent/agents/@fleet\n",
      },
      {
        name: "two-matches-one-line.md",
        write: () => "@tent/@dev and ★ then @tent/@cto\n",
        expected: "@tent/agents/@dev and ★ then @tent/agents/@cto\n",
      },
      {
        name: "no-trailing-newline.md",
        write: () => "★ head\n@tent/@yrd",
        expected: "★ head\n@tent/agents/@yrd",
      },
      {
        // ripgrep strips a UTF-8 BOM before searching, so its byte columns on line 1
        // are BOM-relative. Recomputing line starts from the decoded string (which keeps
        // the BOM) put every line-1 match three bytes short.
        name: "bom.md",
        write: () =>
          Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]),
            Buffer.from("@tent/@dev owns the queue\nsecond line @tent/@cto here\n"),
          ]),
        expected: "﻿@tent/agents/@dev owns the queue\nsecond line @tent/agents/@cto here\n",
      },
    ]

    const PATTERN = "@tent/@(dev|cto|chief|fleet|yrd)\\b"
    const REPLACEMENT = "@tent/agents/@$1"

    beforeAll(() => {
      tempDir = mkdtempSync(join(tmpdir(), "ripgrep-offsets-"))
      for (const f of FIXTURES) writeFileSync(join(tempDir, f.name), f.write())
    })

    afterAll(() => {
      rmSync(tempDir, { recursive: true, force: true })
    })

    function skipIfNoRg(): boolean {
      try {
        execSync("which rg", { stdio: "pipe" })
        return false
      } catch {
        console.log("Skipping test: ripgrep (rg) not installed")
        return true
      }
    }

    test("each edit's offset+length selects exactly the matched text", () => {
      if (skipIfNoRg()) return
      const cwd = process.cwd()
      try {
        process.chdir(tempDir)
        const editset = createPatternReplaceProposal(PATTERN, REPLACEMENT, "*.md", false)
        expect(editset.edits.length).toBeGreaterThan(0)

        const misaligned = editset.edits
          .map((edit) => {
            const content = readFileSync(edit.file, "utf-8")
            const segment = content.slice(edit.offset, edit.offset + edit.length)
            return { file: edit.file, offset: edit.offset, segment }
          })
          .filter((s) => !/^@tent\/@\w+$/.test(s.segment))

        expect(misaligned).toEqual([])
      } finally {
        process.chdir(cwd)
      }
    })

    test("emit → apply rewrites exactly the matched spans and nothing else", () => {
      if (skipIfNoRg()) return
      const cwd = process.cwd()
      const applyDir = mkdtempSync(join(tmpdir(), "ripgrep-offsets-apply-"))
      try {
        for (const f of FIXTURES) writeFileSync(join(applyDir, f.name), f.write())
        process.chdir(applyDir)
        const editset = createPatternReplaceProposal(PATTERN, REPLACEMENT, "*.md", false)
        const result = applyEditset(editset)
        expect(result.driftDetected).toEqual([])

        const after = FIXTURES.map((f) => `${f.name}: ${JSON.stringify(readFileSync(join(applyDir, f.name), "utf-8"))}`)
        const want = FIXTURES.map((f) => `${f.name}: ${JSON.stringify(f.expected)}`)
        expect(after).toEqual(want)
      } finally {
        process.chdir(cwd)
        rmSync(applyDir, { recursive: true, force: true })
      }
    })

    test("each edit records the text it expects to replace (`before`)", () => {
      if (skipIfNoRg()) return
      const cwd = process.cwd()
      try {
        process.chdir(tempDir)
        const editset = createPatternReplaceProposal(PATTERN, REPLACEMENT, "*.md", false)
        for (const edit of editset.edits) {
          const content = readFileSync(edit.file, "utf-8")
          expect(edit.before).toBeDefined()
          expect(content.slice(edit.offset, edit.offset + edit.length)).toBe(edit.before)
        }
      } finally {
        process.chdir(cwd)
      }
    })

    test("finds every match — one per fixture line, none dropped by offset drift", () => {
      if (skipIfNoRg()) return
      const cwd = process.cwd()
      try {
        process.chdir(tempDir)
        const editset = createPatternReplaceProposal(PATTERN, REPLACEMENT, "*.md", false)
        for (const f of FIXTURES) {
          const content = readFileSync(join(tempDir, f.name), "utf-8")
          const truth = [...content.matchAll(new RegExp(PATTERN, "g"))]
          const got = editset.edits.filter((e) => e.file.endsWith(f.name))
          expect(`${f.name}:${got.length}`).toBe(`${f.name}:${truth.length}`)
          const gotOffsets = got.map((e) => e.offset).sort((a, b) => a - b)
          const truthOffsets = truth.map((m) => m.index!).sort((a, b) => a - b)
          expect(`${f.name}:${gotOffsets.join(",")}`).toBe(`${f.name}:${truthOffsets.join(",")}`)
        }
      } finally {
        process.chdir(cwd)
      }
    })
  })
})
