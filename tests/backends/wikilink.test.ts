import { describe, test, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { execSync } from "child_process"

// Import backend to trigger registration
import {
  WikilinkBackend,
  findLinksToFile,
  createFileRenameEditset,
  findBrokenLinks,
  parseWikiLinks,
  linkMatchesTarget,
  generateReplacement,
} from "../../tools/lib/backends/wikilink"
import { getBackends } from "../../tools/lib/backend"

describe("wikilink backend", () => {
  describe("registration", () => {
    test("registers with correct name", () => {
      const backend = getBackends().find((entry) => entry.name === "wikilink")
      expect(backend).toBeDefined()
      expect(backend?.name).toBe("wikilink")
    })

    test("registers with markdown extensions", () => {
      expect(WikilinkBackend.extensions).toContain(".md")
      expect(WikilinkBackend.extensions).toContain(".markdown")
      expect(WikilinkBackend.extensions).toContain(".mdx")
    })

    test("has priority 40 (between ripgrep and ast-grep)", () => {
      const backends = getBackends()
      const wikilink = backends.find((b) => b.name === "wikilink")
      const ripgrep = backends.find((b) => b.name === "ripgrep")
      const astGrep = backends.find((b) => b.name === "ast-grep")

      expect(wikilink).toBeDefined()
      expect(wikilink!.priority).toBe(40)
      if (ripgrep) expect(wikilink!.priority).toBeGreaterThan(ripgrep.priority)
      if (astGrep) expect(wikilink!.priority).toBeLessThan(astGrep.priority)
    })

    test("implements findPatterns", () => {
      expect(typeof WikilinkBackend.findPatterns).toBe("function")
    })

    test("implements createPatternReplaceProposal", () => {
      expect(typeof WikilinkBackend.createPatternReplaceProposal).toBe("function")
    })
  })

  describe("parseWikiLinks", () => {
    test("parses basic wikilink [[note]]", () => {
      const links = parseWikiLinks("Check out [[my-note]] for details.")
      expect(links.length).toBe(1)
      expect(links[0]!.type).toBe("wikilink")
      expect(links[0]!.target).toBe("my-note")
      expect(links[0]!.heading).toBeUndefined()
      expect(links[0]!.alias).toBeUndefined()
      expect(links[0]!.raw).toBe("[[my-note]]")
    })

    test("parses wikilink with alias [[note|display]]", () => {
      const links = parseWikiLinks("See [[my-note|the note]] here.")
      expect(links.length).toBe(1)
      expect(links[0]!.target).toBe("my-note")
      expect(links[0]!.alias).toBe("the note")
    })

    test("parses wikilink with heading [[note#section]]", () => {
      const links = parseWikiLinks("Jump to [[my-note#introduction]].")
      expect(links.length).toBe(1)
      expect(links[0]!.target).toBe("my-note")
      expect(links[0]!.heading).toBe("introduction")
    })

    test("parses wikilink with heading and alias [[note#section|display]]", () => {
      const links = parseWikiLinks("See [[my-note#intro|the intro]].")
      expect(links.length).toBe(1)
      expect(links[0]!.target).toBe("my-note")
      expect(links[0]!.heading).toBe("intro")
      expect(links[0]!.alias).toBe("the intro")
    })

    test("parses embed ![[note]]", () => {
      const links = parseWikiLinks("Embed here: ![[diagram]]")
      expect(links.length).toBe(1)
      expect(links[0]!.type).toBe("embed")
      expect(links[0]!.target).toBe("diagram")
    })

    test("parses path wikilink [[folder/note]]", () => {
      const links = parseWikiLinks("See [[projects/my-project]].")
      expect(links.length).toBe(1)
      expect(links[0]!.target).toBe("projects/my-project")
    })

    test("parses markdown link [text](path.md)", () => {
      const links = parseWikiLinks("Check [the docs](docs/readme.md).")
      expect(links.length).toBe(1)
      expect(links[0]!.type).toBe("markdown")
      expect(links[0]!.target).toBe("docs/readme")
      expect(links[0]!.alias).toBe("the docs")
    })

    test("parses markdown link with heading [text](path.md#section)", () => {
      const links = parseWikiLinks("See [intro](readme.md#introduction).")
      expect(links.length).toBe(1)
      expect(links[0]!.target).toBe("readme")
      expect(links[0]!.heading).toBe("introduction")
    })

    test("parses multiple links", () => {
      const content = "Link to [[note-a]] and [[note-b|alias]] plus ![[embed]]."
      const links = parseWikiLinks(content)
      expect(links.length).toBe(3)
      expect(links[0]!.target).toBe("note-a")
      expect(links[1]!.target).toBe("note-b")
      expect(links[2]!.type).toBe("embed")
    })

    test("returns empty array for no links", () => {
      const links = parseWikiLinks("Just plain text here.")
      expect(links.length).toBe(0)
    })
  })

  describe("linkMatchesTarget", () => {
    test("matches exact name", () => {
      const link = parseWikiLinks("[[my-note]]")[0]!
      expect(linkMatchesTarget(link, "my-note")).toBe(true)
      expect(linkMatchesTarget(link, "other-note")).toBe(false)
    })

    test("matches case-insensitively", () => {
      const link = parseWikiLinks("[[My-Note]]")[0]!
      expect(linkMatchesTarget(link, "my-note")).toBe(true)
      expect(linkMatchesTarget(link, "MY-NOTE")).toBe(true)
    })

    test("matches with path context", () => {
      const link = parseWikiLinks("[[my-note]]")[0]!
      expect(linkMatchesTarget(link, "my-note", "folder/my-note.md")).toBe(true)
    })

    test("matches path wikilink", () => {
      const link = parseWikiLinks("[[folder/note]]")[0]!
      expect(linkMatchesTarget(link, "note", "folder/note.md")).toBe(true)
    })
  })

  describe("generateReplacement", () => {
    test("generates basic wikilink", () => {
      const link = parseWikiLinks("[[old-note]]")[0]!
      expect(generateReplacement(link, "new-note")).toBe("[[new-note]]")
    })

    test("preserves alias", () => {
      const link = parseWikiLinks("[[old-note|display]]")[0]!
      expect(generateReplacement(link, "new-note")).toBe("[[new-note|display]]")
    })

    test("preserves heading", () => {
      const link = parseWikiLinks("[[old-note#section]]")[0]!
      expect(generateReplacement(link, "new-note")).toBe("[[new-note#section]]")
    })

    test("preserves heading and alias", () => {
      const link = parseWikiLinks("[[old-note#section|display]]")[0]!
      expect(generateReplacement(link, "new-note")).toBe("[[new-note#section|display]]")
    })

    test("generates embed", () => {
      const link = parseWikiLinks("![[old-embed]]")[0]!
      expect(generateReplacement(link, "new-embed")).toBe("![[new-embed]]")
    })

    test("generates markdown link", () => {
      const link = parseWikiLinks("[text](old.md)")[0]!
      expect(generateReplacement(link, "new")).toBe("[text](new.md)")
    })

    test("generates markdown link with heading", () => {
      const link = parseWikiLinks("[text](old.md#section)")[0]!
      expect(generateReplacement(link, "new")).toBe("[text](new.md#section)")
    })
  })

  describe("findLinksToFile", () => {
    let tempDir: string

    beforeAll(() => {
      try {
        execSync("which rg", { stdio: "pipe" })
      } catch {
        console.log("Skipping findLinksToFile tests: ripgrep (rg) not installed")
        return
      }

      tempDir = mkdtempSync(join(tmpdir(), "wikilink-test-"))

      // Create test repo structure
      writeFileSync(
        join(tempDir, "index.md"),
        `# Index
See [[target-note]] for details.
Also [[target-note#section|alias here]].
`,
      )

      writeFileSync(
        join(tempDir, "other.md"),
        `# Other
Link to [[target-note]].
And embed ![[target-note]].
`,
      )

      writeFileSync(join(tempDir, "target-note.md"), "# Target\nThis is the target.")

      writeFileSync(join(tempDir, "no-links.md"), "# No Links\nJust text here.")
    })

    afterAll(() => {
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    test("finds all links to target file", () => {
      try {
        execSync("which rg", { stdio: "pipe" })
      } catch {
        return // Skip if rg not installed
      }

      const cwd = process.cwd()
      try {
        process.chdir(tempDir)
        const refs = findLinksToFile("target-note.md")
        expect(refs.length).toBeGreaterThanOrEqual(4) // 2 in index.md, 2 in other.md
      } finally {
        process.chdir(cwd)
      }
    })
  })

  describe("createFileRenameEditset", () => {
    let tempDir: string

    beforeAll(() => {
      try {
        execSync("which rg", { stdio: "pipe" })
      } catch {
        console.log("Skipping createFileRenameEditset tests: ripgrep (rg) not installed")
        return
      }

      tempDir = mkdtempSync(join(tmpdir(), "wikilink-rename-test-"))

      writeFileSync(
        join(tempDir, "docs.md"),
        `# Docs
Reference: [[old-name]]
With heading: [[old-name#intro]]
`,
      )

      writeFileSync(join(tempDir, "old-name.md"), "# Old Name\nContent here.")
    })

    afterAll(() => {
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    test("creates editset with correct structure", () => {
      try {
        execSync("which rg", { stdio: "pipe" })
      } catch {
        return
      }

      const cwd = process.cwd()
      try {
        process.chdir(tempDir)
        const editset = createFileRenameEditset("old-name.md", "new-name.md")

        expect(editset.operation).toBe("file-rename")
        expect(editset.fileOps.length).toBe(1)
        expect(editset.fileOps[0]!.oldPath).toContain("old-name.md")
        expect(editset.fileOps[0]!.newPath).toContain("new-name.md")
        expect(editset.importEdits.length).toBeGreaterThanOrEqual(2)
      } finally {
        process.chdir(cwd)
      }
    })

    test("generates correct replacement text", () => {
      try {
        execSync("which rg", { stdio: "pipe" })
      } catch {
        return
      }

      const cwd = process.cwd()
      try {
        process.chdir(tempDir)
        const editset = createFileRenameEditset("old-name.md", "new-name.md")

        // Check that replacements contain "new-name"
        for (const edit of editset.importEdits) {
          expect(edit.replacement).toContain("new-name")
        }
      } finally {
        process.chdir(cwd)
      }
    })
  })

  describe("findBrokenLinks", () => {
    let tempDir: string

    beforeAll(() => {
      try {
        execSync("which rg", { stdio: "pipe" })
      } catch {
        console.log("Skipping findBrokenLinks tests: ripgrep (rg) not installed")
        return
      }

      tempDir = mkdtempSync(join(tmpdir(), "wikilink-broken-test-"))

      writeFileSync(
        join(tempDir, "with-broken.md"),
        `# Doc
Good link: [[exists]]
Broken: [[does-not-exist]]
`,
      )

      writeFileSync(join(tempDir, "exists.md"), "# Exists\nI exist.")
    })

    afterAll(() => {
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    test("detects broken links", () => {
      try {
        execSync("which rg", { stdio: "pipe" })
      } catch {
        return
      }

      const cwd = process.cwd()
      try {
        process.chdir(tempDir)
        const refs = findBrokenLinks()

        expect(refs.length).toBeGreaterThanOrEqual(1)
        expect(refs.some((r) => r.preview.includes("does-not-exist"))).toBe(true)
      } finally {
        process.chdir(cwd)
      }
    })
  })
})
