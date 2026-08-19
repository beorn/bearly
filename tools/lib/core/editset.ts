import { writeFileSync, readFileSync, existsSync } from "fs"
import type { Editset, Edit, Reference } from "./types"

/**
 * Keep exactly the edits whose OWNING ref is selected.
 *
 * @hh/tooling/22968: the previous implementation filtered by FILE — `selectedFiles =
 * files that have at least one selected ref`, then kept every edit in those files. One
 * kept reference dragged every other edit in that file along silently: a 235-ref
 * selection applied 340 edits. Selection is per-ref; filtering must be per-ref too.
 *
 * Every edit must carry the refId of the Reference it implements (set by the producing
 * backend). An edit with no refId can't be scoped to a specific reference — rather than
 * silently falling back to file-granularity (reintroducing this exact bug) or silently
 * dropping the edit, this throws, matching the "regenerate with a current version of
 * this tool" idiom `applyEditset`/`verifyEdits` already use for a missing `before`.
 */
export function selectEdits(edits: Edit[], refs: Reference[]): Edit[] {
  const orphans = edits.filter((e) => e.refId === undefined)
  if (orphans.length > 0) {
    const first = orphans[0]!
    throw new Error(
      `${orphans.length} edit(s) have no refId, so selection cannot be scoped to the reference ` +
        `each belongs to (first: ${first.file}:${first.offset}) — regenerate the editset with a ` +
        `current version of this tool.`,
    )
  }

  const selectedRefIds = new Set(refs.filter((r) => r.selected).map((r) => r.refId))
  return edits.filter((e) => selectedRefIds.has(e.refId!))
}

/**
 * Filter an editset to include/exclude specific refs
 */
export function filterEditset(editset: Editset, include?: string[], exclude?: string[]): Editset {
  let refs = editset.refs

  if (include && include.length > 0) {
    const includeSet = new Set(include)
    refs = refs.map((ref) => ({
      ...ref,
      selected: includeSet.has(ref.refId),
    }))
  }

  if (exclude && exclude.length > 0) {
    const excludeSet = new Set(exclude)
    refs = refs.map((ref) => ({
      ...ref,
      selected: ref.selected && !excludeSet.has(ref.refId),
    }))
  }

  // Regenerate edits for selected refs only — by REF, never by file (see selectEdits).
  const edits = selectEdits(editset.edits, refs)

  return {
    ...editset,
    refs,
    edits,
  }
}

/**
 * Save editset to file
 */
export function saveEditset(editset: Editset, outputPath: string): void {
  writeFileSync(outputPath, JSON.stringify(editset, null, 2))
}

/**
 * Load editset from file
 */
export function loadEditset(inputPath: string): Editset {
  if (!existsSync(inputPath)) {
    throw new Error(`Editset file not found: ${inputPath}`)
  }
  const content = readFileSync(inputPath, "utf-8")
  return JSON.parse(content) as Editset
}
