import { lstatSync } from "node:fs"
import { basename, dirname } from "node:path"

/** One physical anchor for containment and permitted absent census targets. Existing dangling symlinks are
 * entries, not missing segments: the caller's realpath must report their failure instead of walking past them. */
export function splitAtNearestExistingAncestor(path: string): {
  existingAncestor: string
  missingSegments: string[]
} {
  const missingSegments: string[] = []
  let existingAncestor = path
  for (;;) {
    try {
      lstatSync(existingAncestor)
      return { existingAncestor, missingSegments }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const parent = dirname(existingAncestor)
    if (parent === existingAncestor) return { existingAncestor, missingSegments }
    missingSegments.unshift(basename(existingAncestor))
    existingAncestor = parent
  }
}
