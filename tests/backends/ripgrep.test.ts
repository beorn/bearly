import { describe, test, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { execSync } from "child_process"

// Import to trigger registration
import { RipgrepBackend, findPatterns, createPatternReplaceProposal } from "../../tools/lib/backends/ripgrep"
import { getBackendByName, getBackends } from "../../tools/lib/backend"

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
})
