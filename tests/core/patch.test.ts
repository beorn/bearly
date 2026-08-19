/**
 * applyPatch's own copy of @hh/tooling/22968's file-vs-ref confusion.
 *
 * The old implementation matched an edit to a ref by `r.file === edit.file`, not by the
 * edit's own refId — the identical bug shape as editset.ts's filterEditset. But applyPatch
 * compounded it two ways: the `.filter()` kept an edit whenever ANY ref in its file still
 * qualified (so an edit whose OWN ref was patched to skip could still survive, riding on an
 * unrelated sibling ref in the same file), and the `.map()`'s `.find()` picked whichever
 * ref happened to match first and donated ITS custom replacement text to edits that belong
 * to a different ref entirely.
 */
import { describe, test, expect } from "vitest"
import { applyPatch } from "../../tools/lib/core/patch"
import type { Editset } from "../../tools/lib/core/types"

/** Two refs, two edits, one file — the minimal shape where file-level and ref-level
 *  matching disagree. */
function mockEditset(): Editset {
  return {
    id: "t",
    operation: "rename",
    from: "pattern",
    to: "defaultReplacement",
    refs: [
      {
        refId: "R1",
        file: "a.ts",
        range: [1, 1, 1, 5],
        preview: "match 1",
        checksum: "c",
        selected: true,
        replace: "defaultReplacement",
      },
      {
        refId: "R2",
        file: "a.ts",
        range: [2, 1, 2, 5],
        preview: "match 2",
        checksum: "c",
        selected: true,
        replace: "defaultReplacement",
      },
    ],
    edits: [
      { file: "a.ts", refId: "R1", offset: 10, length: 5, replacement: "defaultReplacement", before: "match" },
      { file: "a.ts", refId: "R2", offset: 30, length: 5, replacement: "defaultReplacement", before: "match" },
    ],
    createdAt: new Date().toISOString(),
  }
}

describe("applyPatch", () => {
  test("a custom replacement for one ref does not bleed into a sibling ref's edit in the same file", () => {
    const editset = mockEditset()
    const patched = applyPatch(editset, { R1: "customText" })

    const r1Edit = patched.edits.find((e) => e.refId === "R1")
    const r2Edit = patched.edits.find((e) => e.refId === "R2")
    expect(r1Edit?.replacement).toBe("customText")
    expect(r2Edit?.replacement).toBe("defaultReplacement") // untouched — R2 was never patched
  })

  // The sharpest case: patching R1 to skip (null) must drop ONLY R1's edit. The old code's
  // `.filter()` asked "does SOME ref in this file still qualify" — since R2 remains
  // selected, that question is true regardless of what happened to R1, so R1's "skip" was
  // silently ignored and its edit applied anyway with its stale default replacement text.
  test("patching one ref to skip (null) drops exactly that ref's edit, not a sibling's", () => {
    const editset = mockEditset()
    const patched = applyPatch(editset, { R1: null })

    expect(patched.edits.some((e) => e.refId === "R1")).toBe(false) // skipped — must not survive
    expect(patched.edits.some((e) => e.refId === "R2")).toBe(true) // untouched sibling stays
  })

  test("refs and edits not mentioned in the patch keep their existing state", () => {
    const editset = mockEditset()
    const patched = applyPatch(editset, { R1: "customText" })

    expect(patched.refs.find((r) => r.refId === "R2")?.replace).toBe("defaultReplacement")
    expect(patched.refs.find((r) => r.refId === "R2")?.selected).toBe(true)
  })

  test("throws on an edit with no refId instead of matching by file", () => {
    const editset = mockEditset()
    editset.edits[0]!.refId = undefined
    expect(() => applyPatch(editset, { R1: "customText" })).toThrow(/no refId/i)
    expect(() => applyPatch(editset, { R1: "customText" })).toThrow(/regenerate the editset/i)
  })
})
