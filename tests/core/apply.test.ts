/**
 * Applier contract: an editset offset means ONE thing, and the applier never writes
 * a replacement over text that isn't what the emitter matched.
 *
 * The bug this pins: offsets were character-based for most files and byte-based for
 * some, the applier *guessed* which by asking "does the offset run past the end of the
 * string?", and when the guess was wrong it wrote each replacement at the wrong position
 * — corrupting the file while reporting `applied: N, skipped: 0, driftDetected: []`.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

import { applyEditset, verifyEditset, computeChecksum } from "../../tools/lib/core/apply"
import type { Editset, Edit } from "../../tools/lib/core/types"

/** Build a single-file editset whose ref checksum matches the on-disk content. */
function editsetFor(file: string, content: string, edits: Edit[]): Editset {
  return {
    id: "test-editset",
    operation: "rename",
    from: "old",
    to: "new",
    refs: [
      {
        refId: "ref00001",
        file,
        range: [1, 1, 1, 1],
        preview: "",
        checksum: computeChecksum(content),
        selected: true,
      },
    ],
    edits,
    createdAt: new Date().toISOString(),
  }
}

describe("applyEditset — segment verification", () => {
  let dir: string
  let cwd: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "apply-offsets-"))
    cwd = process.cwd()
    process.chdir(dir)
  })

  afterEach(() => {
    process.chdir(cwd)
    rmSync(dir, { recursive: true, force: true })
  })

  test("refuses to write when the segment at the offset is not what was matched", () => {
    // Multibyte prose (em dashes) means byte offsets and character offsets diverge.
    // A long ascii tail keeps the byte offset *inside* the character range — the exact
    // blind spot of the old "offset > content.length ⇒ must be bytes" heuristic.
    const content =
      "Intro — a line — with — em dashes — here — ok\nsee @tent/@dev owns it\n" +
      "tail line with plenty of ascii content so the byte offset stays in range.\n".repeat(3)
    writeFileSync("bytes.md", content)

    const charOffset = content.indexOf("@tent/@dev")
    const byteOffset = Buffer.byteLength(content.slice(0, charOffset), "utf-8")
    expect(byteOffset).toBeGreaterThan(charOffset) // offsets genuinely diverge
    expect(byteOffset + 10).toBeLessThanOrEqual(content.length) // and stay inside the char range

    const editset = editsetFor("bytes.md", content, [
      { file: "bytes.md", offset: byteOffset, length: 10, replacement: "@tent/agents/@dev", before: "@tent/@dev" },
    ])

    expect(() => applyEditset(editset)).toThrow(/segment mismatch/i)
    expect(readFileSync("bytes.md", "utf-8")).toBe(content) // file untouched
  })

  test("the mismatch error names the file, the offset, and both segments", () => {
    const content = "alpha beta gamma\n"
    writeFileSync("a.md", content)
    const editset = editsetFor("a.md", content, [
      { file: "a.md", offset: 6, length: 4, replacement: "BETA", before: "beta" },
    ])
    editset.edits[0]!.offset = 0 // point it at the wrong place

    let message = ""
    try {
      applyEditset(editset)
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toContain("a.md")
    expect(message).toContain("offset 0")
    expect(message).toContain("beta") // what the editset expected
    expect(message).toContain("alph") // what is actually there
  })

  test("refuses an editset with no recorded segment — unverifiable is not applicable", () => {
    const content = "alpha beta gamma\n"
    writeFileSync("a.md", content)
    const editset = editsetFor("a.md", content, [{ file: "a.md", offset: 6, length: 4, replacement: "BETA" } as Edit])

    expect(() => applyEditset(editset)).toThrow(/before/i)
    expect(readFileSync("a.md", "utf-8")).toBe(content)
  })

  test("a dry run verifies too — it never reports success for edits that would corrupt", () => {
    const content = "alpha beta gamma\n"
    writeFileSync("a.md", content)
    const editset = editsetFor("a.md", content, [
      { file: "a.md", offset: 0, length: 4, replacement: "BETA", before: "beta" },
    ])

    expect(() => applyEditset(editset, true)).toThrow(/segment mismatch/i)
  })

  test("applies verified edits, right-to-left, with multibyte content intact", () => {
    const content = "héader — ünicode ★\nsee @tent/@dev and @tent/@cto here\n"
    writeFileSync("m.md", content)

    const first = content.indexOf("@tent/@dev")
    const second = content.indexOf("@tent/@cto")
    const editset = editsetFor("m.md", content, [
      { file: "m.md", offset: first, length: 10, replacement: "@tent/agents/@dev", before: "@tent/@dev" },
      { file: "m.md", offset: second, length: 10, replacement: "@tent/agents/@cto", before: "@tent/@cto" },
    ])

    const result = applyEditset(editset)
    expect(result.applied).toBe(2)
    expect(result.skipped).toBe(0)
    expect(result.driftDetected).toEqual([])
    expect(readFileSync("m.md", "utf-8")).toBe("héader — ünicode ★\nsee @tent/agents/@dev and @tent/agents/@cto here\n")
  })

  test("a changed file is reported as drift and skipped, not written", () => {
    const content = "alpha beta gamma\n"
    writeFileSync("a.md", content)
    const editset = editsetFor("a.md", content, [
      { file: "a.md", offset: 6, length: 4, replacement: "BETA", before: "beta" },
    ])
    writeFileSync("a.md", "something else entirely\n")

    const result = applyEditset(editset)
    expect(result.applied).toBe(0)
    expect(result.skipped).toBe(1)
    expect(result.driftDetected).toHaveLength(1)
    expect(readFileSync("a.md", "utf-8")).toBe("something else entirely\n")
  })
})

describe("verifyEditset — catches the same mismatch before apply", () => {
  let dir: string
  let cwd: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "verify-offsets-"))
    cwd = process.cwd()
    process.chdir(dir)
  })

  afterEach(() => {
    process.chdir(cwd)
    rmSync(dir, { recursive: true, force: true })
  })

  test("reports a segment mismatch as an issue, not as valid", () => {
    const content = "alpha beta gamma\n"
    writeFileSync("a.md", content)
    const editset = editsetFor("a.md", content, [
      { file: "a.md", offset: 0, length: 4, replacement: "BETA", before: "beta" },
    ])

    const result = verifyEditset(editset)
    expect(result.valid).toBe(false)
    expect(result.issues.join("\n")).toMatch(/segment mismatch/i)
  })

  test("a correct editset verifies clean", () => {
    const content = "alpha beta gamma\n"
    writeFileSync("a.md", content)
    const editset = editsetFor("a.md", content, [
      { file: "a.md", offset: 6, length: 4, replacement: "BETA", before: "beta" },
    ])

    const result = verifyEditset(editset)
    expect(result.valid).toBe(true)
    expect(result.issues).toEqual([])
  })
})
