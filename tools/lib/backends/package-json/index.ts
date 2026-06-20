import { registerBackend, type RefactorBackend } from "../../backend"
import {
  findPackageJsonRefs,
  findPackageJsonEdits,
  createPackageJsonEditset,
  findBrokenPackageJsonPaths,
} from "./search"
import { findDependencyNameEdits, createDependencyRenameEditset } from "./dependency"

// Re-export
export { findPackageJsonRefs, findPackageJsonEdits, createPackageJsonEditset, findBrokenPackageJsonPaths }
export { findDependencyNameEdits, createDependencyRenameEditset }
export * from "./parser"

/**
 * Package.json backend for updating module resolution paths.
 *
 * Handles:
 * - main, module, types, browser (entry points)
 * - exports (Node.js subpath exports)
 * - imports (Node.js subpath imports)
 * - bin (executable paths)
 * - files (included files list)
 * - typesVersions (TypeScript version mappings)
 *
 * When you rename a .ts/.js file, this backend updates all package.json
 * files that reference it in exports, main, types, etc.
 */
export const PackageJsonBackend: RefactorBackend = {
  name: "package-json",
  extensions: [".json"], // Only handles JSON files
  priority: 45, // Between wikilink (40) and ast-grep (50)

  findPatterns(pattern, glob) {
    return findPackageJsonRefs(pattern, ".", glob ?? "**/package.json")
  },

  createPatternReplaceProposal(pattern, replacement, _glob) {
    return createPackageJsonEditset(pattern, replacement, ".")
  },
}

// Register
registerBackend(PackageJsonBackend)
