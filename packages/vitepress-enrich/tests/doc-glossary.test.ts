import { describe, it, expect } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  extractFromMarkdown,
  extractGlossary,
  loadBucket,
  writeGlossaryBucket,
  readGlossaryBucket,
} from "../src/doc-glossary.ts"
import type { ExtractedTerm } from "../src/doc-glossary.ts"

describe("extractFromMarkdown", () => {
  describe("Pattern 1: heading + first paragraph", () => {
    it("extracts term from heading after glossary marker", () => {
      const md = `
<!-- glossary: components -->
## SelectList
Interactive keyboard-navigable list with j/k navigation and type-ahead search.
`
      const terms = extractFromMarkdown(md)
      expect(terms).toHaveLength(1)
      expect(terms[0]).toMatchObject({
        term: "SelectList",
        tooltip: "Interactive keyboard-navigable list with j/k navigation and type-ahead search.",
        bucket: "components",
      })
    })

    it("extracts multiple terms with different markers", () => {
      const md = `
<!-- glossary: components -->
## SelectList
Interactive list component.

<!-- glossary: api -->
## TextInput
Single-line text input with readline bindings.
`
      const terms = extractFromMarkdown(md)
      expect(terms).toHaveLength(2)
      expect(terms[0]).toMatchObject({ term: "SelectList", bucket: "components" })
      expect(terms[1]).toMatchObject({ term: "TextInput", bucket: "api" })
    })

    it("handles h3 and other heading levels", () => {
      const md = `
<!-- glossary: internals -->
### reconcileTree
Diffs old and new tree structures incrementally.
`
      const terms = extractFromMarkdown(md)
      expect(terms).toHaveLength(1)
      expect(terms[0]!.term).toBe("reconcileTree")
    })

    it("skips marker without a following heading", () => {
      const md = `
<!-- glossary: orphan -->
Just some text without a heading.
`
      const terms = extractFromMarkdown(md)
      expect(terms).toHaveLength(0)
    })

    it("skips marker with heading but no paragraph", () => {
      const md = `
<!-- glossary: empty -->
## EmptyTerm
`
      const terms = extractFromMarkdown(md)
      expect(terms).toHaveLength(0)
    })

    it("derives href from baseUrl", () => {
      const md = `
<!-- glossary: api -->
## VirtualList
Renders large lists efficiently with windowing.
`
      const terms = extractFromMarkdown(md, {
        filePath: "docs/api/virtual-list.md",
        baseUrl: "/",
      })
      expect(terms[0]!.href).toBe("/docs/api/virtual-list")
    })
  })

  describe("Pattern 2: abbreviation syntax", () => {
    it("extracts abbreviation definitions", () => {
      const md = `
*[SGR]: Select Graphic Rendition — ANSI escape codes for text styling
`
      const terms = extractFromMarkdown(md)
      expect(terms).toHaveLength(1)
      expect(terms[0]).toMatchObject({
        term: "SGR",
        tooltip: "Select Graphic Rendition — ANSI escape codes for text styling",
        bucket: "default",
      })
    })

    it("extracts multiple abbreviations", () => {
      const md = `
*[CSI]: Control Sequence Introducer
*[OSC]: Operating System Command
*[DCS]: Device Control String
`
      const terms = extractFromMarkdown(md)
      expect(terms).toHaveLength(3)
      expect(terms.map((t) => t.term)).toEqual(["CSI", "OSC", "DCS"])
    })

    it("uses frontmatter bucket when present", () => {
      const md = `---
glossary_bucket: terminal
---

*[SGR]: Select Graphic Rendition
`
      const terms = extractFromMarkdown(md)
      expect(terms[0]!.bucket).toBe("terminal")
    })

    it("uses provided bucket option", () => {
      const md = `*[VT]: Virtual Terminal`
      const terms = extractFromMarkdown(md, { bucket: "protocols" })
      expect(terms[0]!.bucket).toBe("protocols")
    })

    it("ignores empty tooltip", () => {
      const md = `*[EMPTY]:   `
      const terms = extractFromMarkdown(md)
      expect(terms).toHaveLength(0)
    })
  })

  describe("Pattern 3: dfn marking", () => {
    it("extracts dfn-marked terms with surrounding sentence", () => {
      const md = `The <dfn>alternate screen</dfn> preserves scrollback when fullscreen apps run.`
      const terms = extractFromMarkdown(md)
      expect(terms).toHaveLength(1)
      expect(terms[0]).toMatchObject({
        term: "alternate screen",
        bucket: "default",
      })
      expect(terms[0]!.tooltip).toContain("alternate screen")
      expect(terms[0]!.tooltip).toContain("preserves scrollback")
    })

    it("extracts sentence boundaries correctly", () => {
      const md = `Some intro text. The <dfn>cursor</dfn> indicates the current editing position. More text follows.`
      const terms = extractFromMarkdown(md)
      expect(terms).toHaveLength(1)
      expect(terms[0]!.tooltip).toBe("The cursor indicates the current editing position.")
    })

    it("extracts multiple dfn terms", () => {
      const md = `
The <dfn>primary buffer</dfn> shows normal terminal output.

The <dfn>alternate buffer</dfn> is used by fullscreen apps.
`
      const terms = extractFromMarkdown(md)
      expect(terms).toHaveLength(2)
      expect(terms[0]!.term).toBe("primary buffer")
      expect(terms[1]!.term).toBe("alternate buffer")
    })

    it("strips dfn tags from tooltip", () => {
      const md = `The <dfn>widget</dfn> renders content.`
      const terms = extractFromMarkdown(md)
      expect(terms[0]!.tooltip).not.toContain("<dfn>")
      expect(terms[0]!.tooltip).not.toContain("</dfn>")
    })
  })

  describe("deduplication", () => {
    it("deduplicates by term name (first wins)", () => {
      const md = `
*[SGR]: First definition

*[SGR]: Second definition
`
      const terms = extractFromMarkdown(md)
      expect(terms).toHaveLength(1)
      expect(terms[0]!.tooltip).toBe("First definition")
    })
  })

  describe("mixed patterns", () => {
    it("extracts all three pattern types from one file", () => {
      const md = `
<!-- glossary: components -->
## SelectList
Interactive list with keyboard navigation.

*[TUI]: Terminal User Interface

The <dfn>focus scope</dfn> manages which component receives keyboard input.
`
      const terms = extractFromMarkdown(md)
      expect(terms).toHaveLength(3)
      expect(terms.map((t) => t.term)).toEqual(["SelectList", "TUI", "focus scope"])
    })
  })
})

describe("extractGlossary (filesystem)", () => {
  function createTempDocs(files: Record<string, string>): string {
    const tmp = mkdtempSync(join(tmpdir(), "doc-glossary-"))
    for (const [path, content] of Object.entries(files)) {
      const full = join(tmp, path)
      mkdirSync(join(full, ".."), { recursive: true })
      writeFileSync(full, content, "utf-8")
    }
    return tmp
  }

  it("scans files matching include patterns", () => {
    const tmp = createTempDocs({
      "docs/api/list.md": `*[VL]: Virtual List component`,
      "docs/guide/intro.md": `*[TUI]: Terminal User Interface`,
      "other/skip.md": `*[SKIP]: Should not appear`,
    })

    const terms = extractGlossary({
      include: [`${tmp}/docs/**/*.md`],
    })

    expect(terms).toHaveLength(2)
    expect(terms.map((t) => t.term).sort()).toEqual(["TUI", "VL"])
  })

  it("applies pathBuckets mapping", () => {
    const tmp = createTempDocs({
      "docs/api/list.md": `*[VL]: Virtual List component`,
      "docs/guide/intro.md": `*[TUI]: Terminal User Interface`,
    })

    const terms = extractGlossary({
      include: [`${tmp}/docs/**/*.md`],
      pathBuckets: {
        [`${tmp}/docs/api/**`]: "api",
        [`${tmp}/docs/guide/**`]: "guide",
      },
    })

    const apiTerm = terms.find((t) => t.term === "VL")
    const guideTerm = terms.find((t) => t.term === "TUI")
    expect(apiTerm?.bucket).toBe("api")
    expect(guideTerm?.bucket).toBe("guide")
  })
})

describe("loadBucket", () => {
  it("filters terms by bucket and converts to GlossaryEntity", () => {
    const terms: ExtractedTerm[] = [
      { term: "A", tooltip: "Term A", bucket: "api", source: "a.md" },
      { term: "B", tooltip: "Term B", bucket: "guide", source: "b.md" },
      { term: "C", tooltip: "Term C", bucket: "api", href: "/api/c", source: "c.md" },
    ]

    const entities = loadBucket(terms, "api")
    expect(entities).toHaveLength(2)
    expect(entities[0]).toEqual({ term: "A", tooltip: "Term A", href: undefined })
    expect(entities[1]).toEqual({ term: "C", tooltip: "Term C", href: "/api/c" })
  })

  it("returns empty array for unknown bucket", () => {
    expect(loadBucket([], "nope")).toEqual([])
  })
})

describe("JSONL round-trip", () => {
  it("writes and reads terms through JSONL format", () => {
    const tmp = mkdtempSync(join(tmpdir(), "glossary-jsonl-"))
    const outPath = join(tmp, "api.jsonl")

    const terms: ExtractedTerm[] = [
      { term: "SelectList", tooltip: "Interactive list", bucket: "api", href: "/api/select-list", source: "list.md" },
      { term: "TextInput", tooltip: "Text input field", bucket: "api", source: "input.md" },
      { term: "Other", tooltip: "Filtered out", bucket: "guide", source: "other.md" },
    ]

    writeGlossaryBucket(terms, "api", outPath)

    const content = readFileSync(outPath, "utf-8")
    const lines = content.trim().split("\n")
    expect(lines).toHaveLength(2) // Only "api" bucket terms

    const loaded = readGlossaryBucket(outPath)
    expect(loaded).toHaveLength(2)
    expect(loaded[0]).toMatchObject({ term: "SelectList", bucket: "api" })
    expect(loaded[1]).toMatchObject({ term: "TextInput", bucket: "api" })
  })
})

describe("composition with GlossaryEntity", () => {
  it("doc-derived terms compose with manual glossary entries", () => {
    const md = `*[SGR]: Select Graphic Rendition`
    const docTerms = extractFromMarkdown(md)
    const docEntities = loadBucket(docTerms, "default")

    const manualEntities = [
      { term: "SGR", href: "/reference/sgr", tooltip: "Manual override" },
      { term: "CSI", tooltip: "Control Sequence Introducer" },
    ]

    // Manual entries first = higher priority (compileEntities deduplicates, first wins)
    const combined = [...manualEntities, ...docEntities]
    expect(combined).toHaveLength(3) // SGR appears twice, but compileEntities will deduplicate
    expect(combined[0]!.tooltip).toBe("Manual override") // Manual wins when first
  })
})
