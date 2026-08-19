import type { Editset, Reference } from "./types"

/**
 * Patch format: refId → replacement or null
 * - string: use this replacement instead of default
 * - null: skip this ref (don't apply)
 * - missing: apply with default replacement
 */
export type Patch = Record<string, string | null>

/**
 * Apply a patch to an editset, modifying the `replace` field of each ref.
 *
 * @param editset - The editset to patch
 * @param patch - Map of refId → replacement (string) or null (skip)
 * @returns Modified editset with updated refs and edits
 */
export function applyPatch(editset: Editset, patch: Patch): Editset {
  const defaultReplacement = editset.to

  // Update refs with patch values
  const patchedRefs: Reference[] = editset.refs.map((ref) => {
    if (ref.refId in patch) {
      const value = patch[ref.refId]
      return {
        ...ref,
        replace: value, // null = skip, string = custom replacement
        selected: value !== null, // Update selected based on skip
      }
    }
    // Not in patch: keep existing or set to default
    return {
      ...ref,
      replace: ref.replace ?? defaultReplacement,
      selected: ref.replace !== null,
    }
  })

  // Same file-vs-ref confusion as editset.ts's filterEditset (@hh/tooling/22968): matching
  // "some ref in this file" instead of "THIS edit's own ref" doesn't just leak unselected
  // edits through, it can cross-contaminate replacement text — the first selected ref found
  // in the file would donate its `.replace` string to every other edit in that file, even
  // ones belonging to a different ref with its own (different) custom replacement. Every
  // edit must carry the refId of the ref it implements; an edit without one can't be scoped
  // to "the ref it belongs to" at all, so this refuses rather than guessing (same idiom as
  // applyEditset's missing-`before` check).
  const refById = new Map(patchedRefs.map((r) => [r.refId, r] as const))
  const orphans = editset.edits.filter((e) => e.refId === undefined)
  if (orphans.length > 0) {
    const first = orphans[0]!
    throw new Error(
      `${orphans.length} edit(s) have no refId, so a patch cannot be scoped to the reference each ` +
        `belongs to (first: ${first.file}:${first.offset}) — regenerate the editset with a current ` +
        `version of this tool.`,
    )
  }

  const patchedEdits = editset.edits
    .filter((edit) => {
      const ref = refById.get(edit.refId!)
      return ref !== undefined && ref.selected && ref.replace !== null
    })
    .map((edit) => {
      const ref = refById.get(edit.refId!)!
      return ref.replace !== defaultReplacement ? { ...edit, replacement: ref.replace! } : edit
    })

  return {
    ...editset,
    refs: patchedRefs,
    edits: patchedEdits,
  }
}

/**
 * Parse patch from JSON input (stdin or file).
 * Accepts either a full editset or a minimal patch object.
 */
export function parsePatch(input: string): Patch {
  const parsed = JSON.parse(input) as {
    refs?: Array<{ refId?: string; replace?: string }>
  }

  // If it has refs/edits, it's a full editset - extract replace values
  if (parsed.refs && Array.isArray(parsed.refs)) {
    const patch: Patch = {}
    for (const ref of parsed.refs) {
      if (ref.refId && ref.replace !== undefined) {
        patch[ref.refId] = ref.replace
      }
    }
    return patch
  }

  // Otherwise it's a minimal patch: { refId: value, ... }
  return parsed as Patch
}
