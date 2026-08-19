import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { filterEditset, selectEdits, saveEditset, loadEditset } from "../../tools/lib/core/editset"
import { applyEditset, computeChecksum } from "../../tools/lib/core/apply"
import type { Editset } from "../../tools/lib/core/types"

function createMockEditset(): Editset {
  return {
    id: "test-editset",
    operation: "rename",
    from: "repo",
    to: "repo",
    refs: [
      {
        refId: "R1",
        file: "src/a.ts",
        range: [1, 1, 1, 5],
        preview: "const repo = 1",
        checksum: "checksum-a",
        selected: true,
      },
      {
        refId: "R2",
        file: "src/b.ts",
        range: [2, 1, 2, 5],
        preview: "const repo = 2",
        checksum: "checksum-b",
        selected: true,
      },
      {
        refId: "R3",
        file: "src/a.ts",
        range: [3, 1, 3, 5],
        preview: "const repo = 3",
        checksum: "checksum-a",
        selected: true,
      },
    ],
    // Each edit carries the refId of the Reference it implements — R1/R3 are two
    // DIFFERENT refs that both live in src/a.ts, which is exactly the shape @hh/tooling/22968
    // needs: a file with more than one ref so file-level filtering and ref-level filtering
    // can disagree.
    edits: [
      { file: "src/a.ts", offset: 6, length: 5, replacement: "repo", refId: "R1" },
      { file: "src/b.ts", offset: 6, length: 5, replacement: "repo", refId: "R2" },
      { file: "src/a.ts", offset: 26, length: 5, replacement: "repo", refId: "R3" },
    ],
    createdAt: new Date().toISOString(),
  }
}

describe("filterEditset", () => {
  test("filters by include list", () => {
    const editset = createMockEditset()
    const filtered = filterEditset(editset, ["R1", "R3"])

    expect(filtered.refs.filter((r) => r.selected)).toHaveLength(2)
    expect(filtered.refs.find((r) => r.refId === "R1")?.selected).toBe(true)
    expect(filtered.refs.find((r) => r.refId === "R2")?.selected).toBe(false)
    expect(filtered.refs.find((r) => r.refId === "R3")?.selected).toBe(true)
  })

  test("filters by exclude list", () => {
    const editset = createMockEditset()
    const filtered = filterEditset(editset, undefined, ["R2"])

    expect(filtered.refs.find((r) => r.refId === "R1")?.selected).toBe(true)
    expect(filtered.refs.find((r) => r.refId === "R2")?.selected).toBe(false)
    expect(filtered.refs.find((r) => r.refId === "R3")?.selected).toBe(true)
  })

  test("regenerates edits for selected files only", () => {
    const editset = createMockEditset()
    // Exclude R1 and R3 (both in src/a.ts), keep only R2 (src/b.ts)
    const filtered = filterEditset(editset, ["R2"])

    // Only src/b.ts should have edits
    expect(filtered.edits.every((e) => e.file === "src/b.ts")).toBe(true)
  })

  test("preserves original refs when no filters", () => {
    const editset = createMockEditset()
    const filtered = filterEditset(editset)

    expect(filtered.refs).toEqual(editset.refs)
  })

  // @hh/tooling/22968: selecting one ref must never drag along a SIBLING ref's edit just
  // because both live in the same file. R1 and R3 are two different refs in src/a.ts;
  // selecting only R1 must exclude R3's edit even though R3's file has a selected ref.
  // The old implementation filtered `edits` by `selectedFiles` (file membership), so this
  // exact case — one file, two refs, one selected — kept both edits: reported 1 selected,
  // applied 2.
  test("selecting one ref does NOT drag along a sibling ref's edit in the same file", () => {
    const editset = createMockEditset()
    const filtered = filterEditset(editset, ["R1"]) // R3 also lives in src/a.ts but is NOT selected

    expect(filtered.refs.filter((r) => r.selected)).toHaveLength(1)
    expect(filtered.edits).toHaveLength(1)
    expect(filtered.edits[0]).toMatchObject({ refId: "R1", file: "src/a.ts", offset: 6 })
  })

  test("excluding one ref does NOT drag along a sibling ref's edit in the same file", () => {
    const editset = createMockEditset()
    // R1 and R3 both live in src/a.ts; exclude only R3.
    const filtered = filterEditset(editset, undefined, ["R3"])

    expect(filtered.edits.map((e) => e.refId).sort()).toEqual(["R1", "R2"])
    expect(filtered.edits.some((e) => e.refId === "R3")).toBe(false)
  })

  test("selectEdits refuses an edit with no refId instead of guessing by file", () => {
    const refs = createMockEditset().refs
    const edits = [{ file: "src/a.ts", offset: 6, length: 5, replacement: "repo" }] // no refId
    expect(() => selectEdits(edits, refs)).toThrow(/no refId/i)
    expect(() => selectEdits(edits, refs)).toThrow(/regenerate the editset/i)
  })
})

describe("filterEditset → applyEditset — selection survives to disk byte-for-byte", () => {
  let dir: string
  let cwd: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "editset-select-apply-"))
    cwd = process.cwd()
    process.chdir(dir)
  })

  afterEach(() => {
    process.chdir(cwd)
    rmSync(dir, { recursive: true, force: true })
  })

  // The end-to-end version of @hh/tooling/22968's reproduction: two refs to "widget" in
  // ONE file, the user selects only the first. Under the old file-granularity filter,
  // BOTH edits survived (one file has a selected ref ⇒ every edit in it applies), so the
  // SECOND, explicitly-unselected occurrence got silently rewritten too. This asserts the
  // unselected occurrence's text is byte-identical after apply — not just "excluded from
  // the filtered edit list", but genuinely untouched on disk.
  test("deselecting one of two refs in the same file leaves the other occurrence byte-identical", () => {
    const content = "const widget = 1\nfunction f() {\n  return widget\n}\n"
    writeFileSync("f.ts", content)
    const checksum = computeChecksum(content)

    const firstOffset = content.indexOf("widget")
    const secondOffset = content.indexOf("widget", firstOffset + 1)
    expect(secondOffset).toBeGreaterThan(firstOffset) // sanity: two distinct occurrences

    const editset: Editset = {
      id: "t",
      operation: "rename",
      from: "widget",
      to: "gadget",
      refs: [
        { refId: "keep", file: "f.ts", range: [1, 7, 1, 13], preview: "const widget = 1", checksum, selected: true },
        { refId: "drop", file: "f.ts", range: [3, 10, 3, 16], preview: "return widget", checksum, selected: true },
      ],
      edits: [
        { file: "f.ts", refId: "keep", offset: firstOffset, length: 6, replacement: "gadget", before: "widget" },
        { file: "f.ts", refId: "drop", offset: secondOffset, length: 6, replacement: "gadget", before: "widget" },
      ],
      createdAt: new Date().toISOString(),
    }

    // User keeps "keep", explicitly excludes "drop" — both refs are in the SAME file.
    const filtered = filterEditset(editset, undefined, ["drop"])
    expect(filtered.edits).toHaveLength(1) // not 2 — the old bug's exact symptom shape

    const result = applyEditset(filtered)
    expect(result.applied).toBe(1)
    expect(readFileSync("f.ts", "utf-8")).toBe("const gadget = 1\nfunction f() {\n  return widget\n}\n")
    //                                                                        ^^^^^^ untouched — never selected
  })

  // Offset-invalidation check: every Edit's offset is an ABSOLUTE position in the
  // originally-proposed content (verified against `before` at apply time), never a
  // position relative to other edits. Dropping the EARLIER of two same-file edits and
  // keeping only the LATER one is the direction that would expose a cumulative/relative
  // offset bug — if the applier assumed "all edits in this file" to keep offsets
  // consistent, the surviving later edit would land at the wrong spot once the earlier
  // one no longer applies. It doesn't: apply.ts sorts right-to-left and never shifts a
  // remaining edit's stored offset, so a ref-level subset needs no offset recomputation.
  test("dropping an earlier edit and keeping a later one in the same file still lands at the right offset", () => {
    const content = "const widget = 1\nconst other = 2\nfunction f() {\n  return widget\n}\n"
    writeFileSync("g.ts", content)
    const checksum = computeChecksum(content)

    const earlyOffset = content.indexOf("widget")
    const lateOffset = content.indexOf("widget", earlyOffset + 1)
    expect(lateOffset).toBeGreaterThan(earlyOffset)

    const editset: Editset = {
      id: "t2",
      operation: "rename",
      from: "widget",
      to: "gadget",
      refs: [
        { refId: "early", file: "g.ts", range: [1, 7, 1, 13], preview: "const widget = 1", checksum, selected: true },
        { refId: "late", file: "g.ts", range: [4, 10, 4, 16], preview: "return widget", checksum, selected: true },
      ],
      edits: [
        { file: "g.ts", refId: "early", offset: earlyOffset, length: 6, replacement: "gadget", before: "widget" },
        { file: "g.ts", refId: "late", offset: lateOffset, length: 6, replacement: "gadget", before: "widget" },
      ],
      createdAt: new Date().toISOString(),
    }

    const filtered = filterEditset(editset, undefined, ["early"]) // drop the EARLIER one
    expect(filtered.edits).toHaveLength(1)
    expect(filtered.edits[0]!.refId).toBe("late")

    const result = applyEditset(filtered)
    expect(result.applied).toBe(1)
    expect(readFileSync("g.ts", "utf-8")).toBe(
      "const widget = 1\nconst other = 2\nfunction f() {\n  return gadget\n}\n",
    )
    //                                                ^^^^^^ untouched — the late edit landed at ITS offset, unshifted
  })
})

describe("saveEditset / loadEditset", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "editset-test-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("roundtrips editset through JSON", () => {
    const editset = createMockEditset()
    const filePath = join(tempDir, "test-editset.json")

    saveEditset(editset, filePath)
    expect(existsSync(filePath)).toBe(true)

    const loaded = loadEditset(filePath)
    expect(loaded).toEqual(editset)
  })

  test("throws on missing file", () => {
    expect(() => loadEditset("/nonexistent/path.json")).toThrow("Editset file not found")
  })

  test("preserves all fields through save/load", () => {
    const editset: Editset = {
      id: "detailed-editset",
      operation: "rename",
      symbolKey: "src/foo.ts:1:1:repo",
      pattern: "repo",
      from: "repo",
      to: "repo",
      refs: [
        {
          refId: "ref1",
          file: "src/foo.ts",
          range: [1, 5, 1, 10],
          preview: "const repo = value",
          checksum: "abc123def456",
          selected: true,
        },
      ],
      edits: [
        {
          file: "src/foo.ts",
          offset: 6,
          length: 5,
          replacement: "repo",
        },
      ],
      createdAt: "2024-01-01T00:00:00.000Z",
    }

    const filePath = join(tempDir, "detailed.json")
    saveEditset(editset, filePath)
    const loaded = loadEditset(filePath)

    expect(loaded.id).toBe(editset.id)
    expect(loaded.symbolKey).toBe(editset.symbolKey)
    expect(loaded.pattern).toBe(editset.pattern)
    expect(loaded.refs[0]!.range).toEqual([1, 5, 1, 10])
  })
})
