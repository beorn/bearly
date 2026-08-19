/**
 * ts-morph batch rename's DEFINITION edit has no natural Reference to begin with:
 * `getReferences()` calls ts-morph's `findReferencesAsNodes()` on the declaring identifier,
 * which returns only the OTHER usage sites — never the declaration itself (confirmed
 * empirically against this vendored ts-morph version). `createDefinitionEdit` builds a
 * separate edit for the declaration with no ref counterpart in `refs` at all, which made it
 * structurally impossible to select or deselect independently — every declaration rename
 * always applied regardless of the user's selection, silently.
 *
 * Fixed alongside @hh/tooling/22968 (selection leaks by file, not by ref): the declaration
 * edit and a matching synthetic Reference are now derived from ONE shared position
 * computation (`findDefinitionSpan`), so they always agree on refId and the declaration is
 * selectable like any other reference.
 *
 * Note: the synthetic ref's `kind` is "decl", but so is every other reference's kind by
 * default — `getRefKind()`'s fallback ("everything else is a declaration/reference") means
 * a plain usage like `widget + widget` also comes back as kind "decl". `kind` was never a
 * unique identifier for the declaring occurrence, so these tests find it by the
 * "(declaration)" marker in its preview instead.
 */
import { describe, test, expect } from "vitest"
import { Project } from "ts-morph"
import { createBatchRenameProposal } from "../../tools/lib/backends/ts-morph/edits"
import { filterEditset } from "../../tools/lib/core/editset"

function projectWith(source: string): Project {
  const project = new Project({ useInMemoryFileSystem: true })
  project.createSourceFile("widget.ts", source)
  return project
}

function isDeclRef(r: { preview: string }): boolean {
  return r.preview.includes("(declaration)")
}

describe("ts-morph batch rename — declaration is a real, selectable ref", () => {
  test("declaration site appears in refs with a refId its edit also carries", () => {
    const project = projectWith("const widget = 1\nfunction use() {\n  return widget + widget\n}\n")
    const editset = createBatchRenameProposal(project, /^widget$/, "gadget")

    // 1 declaration + 2 usages
    expect(editset.refs).toHaveLength(3)
    expect(editset.edits).toHaveLength(3)

    const declRefs = editset.refs.filter(isDeclRef)
    expect(declRefs).toHaveLength(1)
    const declRef = declRefs[0]!
    expect(editset.edits.some((e) => e.refId === declRef.refId)).toBe(true)

    // Every ref has a distinct id, and every edit's refId resolves to a real ref — the
    // invariant filterEditset()/selectEdits() depend on.
    const refIds = new Set(editset.refs.map((r) => r.refId))
    expect(refIds.size).toBe(editset.refs.length)
    for (const edit of editset.edits) {
      expect(edit.refId).toBeDefined()
      expect(refIds.has(edit.refId!)).toBe(true)
    }
  })

  test("deselecting the declaration ref renames every usage but leaves the declaration untouched", () => {
    const project = projectWith("const widget = 1\nfunction use() {\n  return widget\n}\n")
    const editset = createBatchRenameProposal(project, /^widget$/, "gadget")
    const declRef = editset.refs.find(isDeclRef)!

    const filtered = filterEditset(editset, undefined, [declRef.refId])

    expect(filtered.edits).toHaveLength(editset.edits.length - 1)
    expect(filtered.edits.some((e) => e.refId === declRef.refId)).toBe(false)
  })

  test("deselecting a usage ref leaves the declaration and the OTHER usage selected", () => {
    const project = projectWith("const widget = 1\nfunction use() {\n  return widget + widget\n}\n")
    const editset = createBatchRenameProposal(project, /^widget$/, "gadget")
    const declRef = editset.refs.find(isDeclRef)!
    const usageRefs = editset.refs.filter((r) => !isDeclRef(r))
    expect(usageRefs).toHaveLength(2)

    const filtered = filterEditset(editset, undefined, [usageRefs[0]!.refId])

    expect(filtered.edits).toHaveLength(editset.edits.length - 1)
    expect(filtered.edits.some((e) => e.refId === usageRefs[0]!.refId)).toBe(false)
    expect(filtered.edits.some((e) => e.refId === usageRefs[1]!.refId)).toBe(true)
    expect(filtered.edits.some((e) => e.refId === declRef.refId)).toBe(true)
  })
})
