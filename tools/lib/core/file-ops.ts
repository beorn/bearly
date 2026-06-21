/**
 * file-ops.ts - Batch file rename operations with import/link updates
 *
 * Provides:
 *   - findFilesToRename: Find files matching a glob pattern
 *   - checkFileConflicts: Check for naming conflicts
 *   - createFileRenameProposal: Create editset with file ops + link updates
 *   - applyFileRenames: Execute file renames and link updates
 *
 * Supports:
 *   - TypeScript/JS: Updates import paths
 *   - Markdown: Updates [[wikilinks]] (Obsidian, Foam, etc.)
 */

import { createHash } from "crypto"
import fs from "fs"
import path from "path"
import { Glob } from "bun"
import { Project } from "ts-morph"
import type { FileOp, FileEditset, FileConflict, FileRenameReport, Edit } from "./types"
import { findLinksToFile, parseWikiLinks, generateReplacement } from "../backends/wikilink"
import { findPackageJsonEdits } from "../backends/package-json"
import { findTsConfigEdits } from "../backends/tsconfig-json"

/**
 * Compute checksum for a file
 */
function fileChecksum(filePath: string): string {
  const content = fs.readFileSync(filePath)
  return createHash("sha256").update(content).digest("hex").slice(0, 16)
}

/**
 * Generate unique operation ID
 */
function generateOpId(oldPath: string, newPath: string): string {
  const hash = createHash("sha256").update(`${oldPath}:${newPath}`).digest("hex").slice(0, 8)
  return `file-${hash}`
}

/**
 * Apply a replacement pattern to a filename
 *
 * Supports:
 *   - Simple string replacement: "repo" -> "repo" in "repo-loader.ts" -> "repo-loader.ts"
 *   - Regex groups: "repo(.+)" -> "repo$1" (not yet implemented)
 */
export function applyReplacement(filename: string, pattern: string | RegExp, replacement: string): string {
  if (typeof pattern === "string") {
    // Case-preserving replacement
    return filename.replace(new RegExp(pattern, "gi"), (match) => {
      // Preserve case: repo -> repo, Repo -> Repo, REPO -> REPO
      if (match === match.toUpperCase()) return replacement.toUpperCase()
      if (match[0] === match[0]!.toUpperCase()) {
        return replacement[0]!.toUpperCase() + replacement.slice(1)
      }
      return replacement
    })
  }
  return filename.replace(pattern, replacement)
}

/**
 * Find files matching a glob pattern that contain the search term in their name
 */
export async function findFilesToRename(
  pattern: string,
  replacement: string,
  glob: string = "**/*",
  cwd: string = process.cwd(),
): Promise<FileOp[]> {
  const fileOps: FileOp[] = []
  const globber = new Glob(glob)

  for await (const file of globber.scan({ cwd, onlyFiles: true })) {
    const basename = path.basename(file)
    const dirname = path.dirname(file)

    // Check if filename contains the pattern
    if (!basename.toLowerCase().includes(pattern.toLowerCase())) continue

    // Compute new name
    const newBasename = applyReplacement(basename, pattern, replacement)
    if (newBasename === basename) continue // No change needed

    const oldPath = path.join(cwd, file)
    const newPath = path.join(cwd, dirname, newBasename)

    fileOps.push({
      opId: generateOpId(oldPath, newPath),
      type: "rename",
      oldPath: file, // relative path
      newPath: path.join(dirname, newBasename), // relative path
      checksum: fileChecksum(oldPath),
    })
  }

  return fileOps
}

/**
 * Check for file rename conflicts
 */
export function checkFileConflicts(fileOps: FileOp[], cwd: string = process.cwd()): FileRenameReport {
  const conflicts: FileConflict[] = []
  const safe: FileOp[] = []
  const targetPaths = new Set<string>()

  for (const op of fileOps) {
    const absoluteNewPath = path.isAbsolute(op.newPath) ? op.newPath : path.join(cwd, op.newPath)

    // Check if target already exists
    if (fs.existsSync(absoluteNewPath)) {
      // Check if it's the same file (case-insensitive rename on case-insensitive fs)
      const absoluteOldPath = path.isAbsolute(op.oldPath) ? op.oldPath : path.join(cwd, op.oldPath)
      if (absoluteOldPath.toLowerCase() !== absoluteNewPath.toLowerCase()) {
        conflicts.push({
          oldPath: op.oldPath,
          newPath: op.newPath,
          reason: "target_exists",
          existingPath: op.newPath,
        })
        continue
      }
    }

    // Check for duplicate targets within this batch
    if (targetPaths.has(op.newPath)) {
      conflicts.push({
        oldPath: op.oldPath,
        newPath: op.newPath,
        reason: "target_exists",
        existingPath: op.newPath,
      })
      continue
    }

    // Check if old and new are the same
    if (op.oldPath === op.newPath) {
      conflicts.push({
        oldPath: op.oldPath,
        newPath: op.newPath,
        reason: "same_path",
      })
      continue
    }

    targetPaths.add(op.newPath)
    safe.push(op)
  }

  return { conflicts, safe }
}

/**
 * Find all import statements that reference the files being renamed
 * Returns edit operations to update those imports
 *
 * Uses ts-morph to accurately parse TypeScript/JavaScript files and find:
 * - import declarations: import { foo } from "./repo"
 * - export declarations: export { foo } from "./repo"
 * - dynamic imports: await import("./repo")
 * - require calls: require("./repo")
 */
export function findImportEdits(fileOps: FileOp[], cwd: string = process.cwd()): Edit[] {
  if (fileOps.length === 0) return []

  // Try to find tsconfig.json, fall back to scanning files directly
  const tsconfigPath = path.join(cwd, "tsconfig.json")
  const project = fs.existsSync(tsconfigPath)
    ? new Project({ tsConfigFilePath: tsconfigPath })
    : new Project({ compilerOptions: { allowJs: true } })

  // If no tsconfig, add source files manually
  if (!fs.existsSync(tsconfigPath)) {
    project.addSourceFilesAtPaths(path.join(cwd, "**/*.{ts,tsx,js,jsx}"))
  }

  // Build maps of old absolute paths -> FileOp / moved source path for quick lookup.
  const oldPathToOp = new Map<string, FileOp>()
  const movedSourcePathByOldPath = new Map<string, string>()
  for (const op of fileOps) {
    const absOldPath = absolutePathFor(op.oldPath, cwd)
    const absNewPath = absolutePathFor(op.newPath, cwd)
    oldPathToOp.set(absOldPath, op)

    if (/\.(ts|tsx|js|jsx)$/.test(op.oldPath)) {
      // Also add without extension for module resolution.
      oldPathToOp.set(stripTsJsExtension(absOldPath), op)
      movedSourcePathByOldPath.set(absOldPath, absNewPath)
    }
  }

  const edits: Edit[] = []

  // Scan all source files for imports
  for (const sourceFile of project.getSourceFiles()) {
    const sourceFilePath = sourceFile.getFilePath()
    // Skip files in node_modules
    if (sourceFilePath.includes("node_modules")) continue

    const sourceFileDir = path.dirname(sourceFilePath)
    const fileContent = sourceFile.getFullText()

    // Process import declarations: import { x } from "./foo"
    for (const importDecl of sourceFile.getImportDeclarations()) {
      const specNode = importDecl.getModuleSpecifier()
      const edit = createImportEdit(
        sourceFilePath,
        sourceFileDir,
        importDecl.getModuleSpecifierValue(),
        specNode.getStart(),
        specNode.getEnd(),
        fileContent,
        oldPathToOp,
        movedSourcePathByOldPath,
        cwd,
      )
      if (edit) edits.push(edit)
    }

    // Process export declarations: export { x } from "./foo"
    for (const exportDecl of sourceFile.getExportDeclarations()) {
      const moduleSpecifier = exportDecl.getModuleSpecifierValue()
      if (!moduleSpecifier) continue // export { x } without from clause

      const specNode = exportDecl.getModuleSpecifier()!
      const edit = createImportEdit(
        sourceFilePath,
        sourceFileDir,
        moduleSpecifier,
        specNode.getStart(),
        specNode.getEnd(),
        fileContent,
        oldPathToOp,
        movedSourcePathByOldPath,
        cwd,
      )
      if (edit) edits.push(edit)
    }

    // Process dynamic imports and require calls via descendant traversal
    sourceFile.forEachDescendant((node) => {
      // Dynamic import: import("./foo") or require("./foo")
      if (node.getKindName() === "CallExpression") {
        const text = node.getText()
        // Check for import() or require() calls
        if (text.startsWith("import(") || text.startsWith("require(")) {
          // Extract the module specifier from the call
          const match = text.match(/^(?:import|require)\s*\(\s*(['"`])(.+?)\1/)
          if (match) {
            const [, quote, moduleSpecifier] = match
            // Find the position of the string literal within the call
            const callStart = node.getStart()
            const literalOffset = text.indexOf(quote!)
            const start = callStart + literalOffset
            const end = start + quote!.length + moduleSpecifier!.length + quote!.length

            const edit = createImportEdit(
              sourceFilePath,
              sourceFileDir,
              moduleSpecifier!,
              start,
              end,
              fileContent,
              oldPathToOp,
              movedSourcePathByOldPath,
              cwd,
            )
            if (edit) edits.push(edit)
          }
        }
      }
    })
  }

  // Sort by file then offset descending (for safe application)
  return edits.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file)
    return b.offset - a.offset
  })
}

/**
 * Create an edit for an import/export module specifier.
 * Works with both AST nodes (getStart/getEnd) and raw offsets.
 */
function createImportEdit(
  sourceFilePath: string,
  sourceFileDir: string,
  moduleSpecifier: string,
  start: number,
  end: number,
  fileContent: string,
  oldPathToOp: Map<string, FileOp>,
  movedSourcePathByOldPath: Map<string, string>,
  cwd: string,
): Edit | null {
  if (!moduleSpecifier.startsWith(".")) return null

  const resolvedPath = resolveModulePath(sourceFileDir, moduleSpecifier)
  const op = oldPathToOp.get(resolvedPath) || oldPathToOp.get(stripTsJsExtension(resolvedPath))
  const newSourcePath = movedSourcePathByOldPath.get(absolutePathFor(sourceFilePath, cwd))
  if (!op && !newSourcePath) return null

  const fromDir = newSourcePath ? path.dirname(newSourcePath) : sourceFileDir
  const toPath = op ? absolutePathFor(op.newPath, cwd) : resolvedPath
  const newRelativePath = computeNewRelativePath(fromDir, toPath, moduleSpecifier)
  if (newRelativePath === moduleSpecifier) return null

  const originalQuote = fileContent[start]
  const newSpecifier = `${originalQuote}${newRelativePath}${originalQuote}`

  return {
    file: path.relative(cwd, sourceFilePath),
    offset: start,
    length: end - start,
    replacement: newSpecifier,
  }
}

function absolutePathFor(filePath: string, cwd: string): string {
  return path.resolve(path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath))
}

function stripTsJsExtension(filePath: string): string {
  return filePath.replace(/\.(ts|tsx|js|jsx)$/, "")
}

/**
 * Resolve a module specifier to an absolute path
 * Handles: ./foo, ./foo.ts, ../foo, ./foo/index
 */
function resolveModulePath(fromDir: string, moduleSpecifier: string): string {
  const resolved = path.resolve(fromDir, moduleSpecifier)

  // Try with common extensions
  const extensions = [".ts", ".tsx", ".js", ".jsx", ""]
  for (const ext of extensions) {
    const withExt = resolved + ext
    if (fs.existsSync(withExt)) return withExt
  }

  // Try index files
  for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
    const indexPath = path.join(resolved, `index${ext}`)
    if (fs.existsSync(indexPath)) return indexPath
  }

  return resolved
}

/**
 * Compute the new relative path from an importing file to the renamed file
 * Preserves the original import style (with/without extension, with/without index)
 */
function computeNewRelativePath(fromDir: string, toAbsPath: string, originalSpecifier: string): string {
  // Get relative path from importing file's directory to new file
  let relativePath = path.relative(fromDir, toAbsPath)

  // Ensure it starts with ./ or ../
  if (!relativePath.startsWith(".")) {
    relativePath = "./" + relativePath
  }

  // Preserve original style: with or without extension
  const hadExtension = /\.(ts|tsx|js|jsx)$/.test(originalSpecifier)
  if (!hadExtension) {
    relativePath = relativePath.replace(/\.(ts|tsx|js|jsx)$/, "")
  }

  // Preserve index handling: ./foo/index -> ./foo
  const hadIndex = originalSpecifier.endsWith("/index") || originalSpecifier.endsWith("/index.ts")
  if (!hadIndex && relativePath.endsWith("/index")) {
    relativePath = relativePath.replace(/\/index$/, "")
  }

  // Normalize path separators for the platform
  return relativePath.split(path.sep).join("/")
}

/**
 * Find all wikilinks that reference the files being renamed
 * Returns edit operations to update those links
 *
 * Supports: [[note]], [[note|alias]], [[note#heading]], ![[embed]]
 */
export function findWikilinkEdits(fileOps: FileOp[], cwd: string = process.cwd()): Edit[] {
  const edits: Edit[] = []

  for (const op of fileOps) {
    // Only process markdown files
    const ext = path.extname(op.oldPath).toLowerCase()
    if (![".md", ".markdown", ".mdx"].includes(ext)) continue

    const oldName = path.basename(op.oldPath).replace(/\.(md|markdown|mdx)$/i, "")
    const newName = path.basename(op.newPath).replace(/\.(md|markdown|mdx)$/i, "")

    // Find all files that link to this one
    const refs = findLinksToFile(op.oldPath, cwd, "**/*.md")

    for (const ref of refs) {
      const filePath = path.isAbsolute(ref.file) ? ref.file : path.join(cwd, ref.file)
      if (!fs.existsSync(filePath)) continue

      const content = fs.readFileSync(filePath, "utf-8")
      const links = parseWikiLinks(content)

      // Find links that point to the old file
      for (const link of links) {
        const linkTarget = link.target.toLowerCase()
        if (linkTarget === oldName.toLowerCase() || linkTarget.endsWith("/" + oldName.toLowerCase())) {
          // Determine new target (preserve path if present)
          let newTarget = newName
          if (link.target.includes("/")) {
            const linkDir = path.dirname(link.target)
            newTarget = `${linkDir}/${newName}`
          }

          const replacement = generateReplacement(link, newTarget)

          edits.push({
            file: ref.file,
            offset: link.start,
            length: link.end - link.start,
            replacement,
          })
        }
      }
    }
  }

  // Sort by file then offset descending (for safe application)
  return edits.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file)
    return b.offset - a.offset
  })
}

/**
 * Create a file rename editset
 */
export async function createFileRenameProposal(
  pattern: string,
  replacement: string,
  glob: string = "**/*",
  cwd: string = process.cwd(),
): Promise<FileEditset> {
  // Find files to rename
  const fileOps = await findFilesToRename(pattern, replacement, glob, cwd)

  // Check for conflicts
  const report = checkFileConflicts(fileOps, cwd)
  if (report.conflicts.length > 0) {
    console.error(`[file-ops] Found ${report.conflicts.length} conflicts:`)
    for (const c of report.conflicts) {
      console.error(`  ${c.oldPath} -> ${c.newPath}: ${c.reason}`)
    }
  }

  // Find import edits for safe renames (TypeScript)
  const importEdits = findImportEdits(report.safe, cwd)

  // Find wikilink edits for safe renames (Markdown)
  const wikilinkEdits = findWikilinkEdits(report.safe, cwd)

  // Find package.json and tsconfig.json edits
  const packageJsonEdits: Edit[] = []
  const tsconfigEdits: Edit[] = []
  for (const op of report.safe) {
    packageJsonEdits.push(...findPackageJsonEdits(op.oldPath, op.newPath, cwd))
    tsconfigEdits.push(...findTsConfigEdits(op.oldPath, op.newPath, cwd))
  }

  // Combine all link updates, removing duplicates / conflicting overlaps.
  const allLinkEdits = dedupeEdits([...importEdits, ...wikilinkEdits, ...packageJsonEdits, ...tsconfigEdits])

  return {
    id: `file-rename-${pattern}-to-${replacement}-${Date.now()}`,
    operation: "file-rename",
    pattern,
    replacement,
    fileOps: report.safe,
    importEdits: allLinkEdits,
    createdAt: new Date().toISOString(),
  }
}

/**
 * Remove duplicate and conflicting edits from a combined edit list.
 *
 * Directory moves gather link edits from several backends (imports, wikilinks, package.json,
 * tsconfig) and per-fileOp loops, so the same edit can be produced more than once. This:
 *   - drops exact duplicates (same file/offset/length/replacement)
 *   - drops any edit that overlaps an already-kept edit in the same file (would corrupt on apply),
 *     keeping the first by ascending offset and warning
 * Returns edits sorted by file then offset DESCENDING (the safe application order).
 */
export function dedupeEdits(edits: Edit[]): Edit[] {
  const seen = new Set<string>()
  const kept: Edit[] = []
  const lastEndByFile = new Map<string, number>()

  // Sort by file, then offset ascending, then length ascending — deterministic, overlap-friendly.
  const sorted = [...edits].sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file)
    if (a.offset !== b.offset) return a.offset - b.offset
    return a.length - b.length
  })

  for (const e of sorted) {
    const key = `${e.file}|${e.offset}|${e.length}|${e.replacement}`
    if (seen.has(key)) continue // exact duplicate

    const lastEnd = lastEndByFile.get(e.file)
    if (lastEnd !== undefined && e.offset < lastEnd) {
      console.error(
        `[file-ops] dropping overlapping edit in ${e.file} at offset ${e.offset} (conflicts with a prior edit)`,
      )
      continue
    }

    seen.add(key)
    kept.push(e)
    lastEndByFile.set(e.file, e.offset + e.length)
  }

  return kept.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file)
    return b.offset - a.offset
  })
}

/**
 * Find every file under `oldPrefix` and map it to `newPrefix`, producing "move" FileOps.
 *
 * Unlike findFilesToRename (which pattern-matches basenames), this moves a whole directory/prefix:
 * `apps/silvercode/x/y.ts` → `apps/ag/x/y.ts` when oldPrefix=apps/silvercode, newPrefix=apps/ag.
 * `glob` restricts by file type (default: all files).
 */
export async function findFilesToMovePrefix(
  oldPrefix: string,
  newPrefix: string,
  glob: string = "**/*",
  cwd: string = process.cwd(),
): Promise<FileOp[]> {
  const fileOps: FileOp[] = []
  const normOld = oldPrefix.replace(/\/+$/, "")
  const normNew = newPrefix.replace(/\/+$/, "")
  const globber = new Glob(glob)

  for await (const file of globber.scan({ cwd, onlyFiles: true })) {
    // Only files at or under the old prefix.
    if (file !== normOld && !file.startsWith(normOld + "/")) continue

    const rest = file.slice(normOld.length) // leading "/" preserved, or "" for an exact-file prefix
    const newPath = normNew + rest
    if (newPath === file) continue

    const oldAbs = path.join(cwd, file)
    fileOps.push({
      opId: generateOpId(oldAbs, path.join(cwd, newPath)),
      type: "move",
      oldPath: file,
      newPath,
      checksum: fileChecksum(oldAbs),
    })
  }

  return fileOps
}

/**
 * Create a directory/prefix-move editset: move every file under `oldPrefix` to `newPrefix` and
 * update all references (imports, wikilinks, package.json, tsconfig), deduped.
 *
 * `opts.excludeGlobs` skips REWRITING links inside files matching those globs — the bead-safety
 * lever (e.g. `@km/**\/*.md` so a bead's wikilinks are preserved verbatim during a reorg).
 */
export async function createDirectoryMoveProposal(
  oldPrefix: string,
  newPrefix: string,
  glob: string = "**/*",
  cwd: string = process.cwd(),
  opts?: { excludeGlobs?: string[] },
): Promise<FileEditset> {
  const fileOps = await findFilesToMovePrefix(oldPrefix, newPrefix, glob, cwd)

  const report = checkFileConflicts(fileOps, cwd)
  if (report.conflicts.length > 0) {
    console.error(`[file-ops] Found ${report.conflicts.length} conflicts:`)
    for (const c of report.conflicts) {
      console.error(`  ${c.oldPath} -> ${c.newPath}: ${c.reason}`)
    }
  }

  const importEdits = findImportEdits(report.safe, cwd)
  const wikilinkEdits = findWikilinkEdits(report.safe, cwd)
  const packageJsonEdits: Edit[] = []
  const tsconfigEdits: Edit[] = []
  for (const op of report.safe) {
    packageJsonEdits.push(...findPackageJsonEdits(op.oldPath, op.newPath, cwd))
    tsconfigEdits.push(...findTsConfigEdits(op.oldPath, op.newPath, cwd))
  }

  let allLinkEdits = dedupeEdits([...importEdits, ...wikilinkEdits, ...packageJsonEdits, ...tsconfigEdits])

  // Bead-safety: never rewrite links INSIDE excluded files (e.g. @km bead markdown).
  if (opts?.excludeGlobs?.length) {
    const matchers = opts.excludeGlobs.map((g) => new Glob(g))
    allLinkEdits = allLinkEdits.filter((e) => !matchers.some((m) => m.match(e.file)))
  }

  return {
    id: `dir-move-${normalizeId(oldPrefix)}-to-${normalizeId(newPrefix)}-${Date.now()}`,
    operation: "file-rename",
    pattern: oldPrefix,
    replacement: newPrefix,
    fileOps: report.safe,
    importEdits: allLinkEdits,
    createdAt: new Date().toISOString(),
  }
}

function normalizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")
}

/**
 * Verify a file editset can be applied (checksums still match)
 */
export function verifyFileEditset(
  editset: FileEditset,
  cwd: string = process.cwd(),
): { valid: boolean; drifted: string[] } {
  const drifted: string[] = []

  for (const op of editset.fileOps) {
    const absolutePath = path.isAbsolute(op.oldPath) ? op.oldPath : path.join(cwd, op.oldPath)

    if (!fs.existsSync(absolutePath)) {
      drifted.push(`${op.oldPath}: file no longer exists`)
      continue
    }

    const currentChecksum = fileChecksum(absolutePath)
    if (currentChecksum !== op.checksum) {
      drifted.push(`${op.oldPath}: checksum mismatch (file changed)`)
    }
  }

  return { valid: drifted.length === 0, drifted }
}

/**
 * Apply file renames AND their link edits.
 *
 * Two phases: (1) move/rename the files (checksum-verified), then (2) apply the editset's
 * `importEdits` — the import/wikilink/package.json/tsconfig rewrites — to their files. An edit
 * targeting a file that was just moved is remapped to the new path (the move leaves content
 * unchanged, so the recorded offsets stay valid). Without phase 2 the files move but every
 * importer breaks — the bug this previously had.
 *
 * `applied` counts renamed files (stable for callers); `linkEditsApplied` counts link rewrites.
 */
export function applyFileRenames(
  editset: FileEditset,
  dryRun: boolean = false,
  cwd: string = process.cwd(),
): { applied: number; skipped: number; errors: string[]; linkEditsApplied: number } {
  const errors: string[] = []
  let applied = 0
  let skipped = 0

  // Verify first
  const verification = verifyFileEditset(editset, cwd)
  if (!verification.valid) {
    console.error("[file-ops] Some files have drifted:")
    for (const msg of verification.drifted) {
      console.error(`  ${msg}`)
    }
  }

  // Phase 1: move files, tracking old→new for link-edit remapping.
  const movedMap = new Map<string, string>()
  for (const op of editset.fileOps) {
    const absoluteOldPath = path.isAbsolute(op.oldPath) ? op.oldPath : path.join(cwd, op.oldPath)
    const absoluteNewPath = path.isAbsolute(op.newPath) ? op.newPath : path.join(cwd, op.newPath)

    // Check if file still exists with correct checksum
    if (!fs.existsSync(absoluteOldPath)) {
      errors.push(`${op.oldPath}: file no longer exists`)
      skipped++
      continue
    }

    const currentChecksum = fileChecksum(absoluteOldPath)
    if (currentChecksum !== op.checksum) {
      errors.push(`${op.oldPath}: checksum mismatch, skipping`)
      skipped++
      continue
    }

    if (dryRun) {
      console.log(`[dry-run] mv ${op.oldPath} -> ${op.newPath}`)
      applied++
      movedMap.set(op.oldPath, op.newPath)
      continue
    }

    // Ensure target directory exists
    const targetDir = path.dirname(absoluteNewPath)
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true })
    }

    // Perform the rename
    try {
      fs.renameSync(absoluteOldPath, absoluteNewPath)
      applied++
      movedMap.set(op.oldPath, op.newPath)
    } catch (err) {
      errors.push(`${op.oldPath}: rename failed - ${err}`)
      skipped++
    }
  }

  // Phase 2: apply link edits (remapping any edit whose file was moved).
  const linkEditsApplied = applyLinkEdits(editset.importEdits, movedMap, dryRun, cwd, errors)

  return { applied, skipped, errors, linkEditsApplied }
}

/**
 * Apply a list of offset-based edits, grouping by their (post-move) target file.
 * In dry-run mode it only counts the edits.
 */
function applyLinkEdits(
  edits: Edit[],
  movedMap: Map<string, string>,
  dryRun: boolean,
  cwd: string,
  errors: string[],
): number {
  if (edits.length === 0) return 0
  if (dryRun) return edits.length

  // Group by resolved file path (a moved file's edits target its new location).
  const byFile = new Map<string, Edit[]>()
  for (const edit of edits) {
    const resolved = movedMap.get(edit.file) ?? edit.file
    if (!byFile.has(resolved)) byFile.set(resolved, [])
    byFile.get(resolved)!.push(edit)
  }

  let count = 0
  for (const [file, fileEdits] of byFile) {
    const absPath = path.isAbsolute(file) ? file : path.join(cwd, file)
    if (!fs.existsSync(absPath)) {
      errors.push(`${file}: link-edit target missing, skipping ${fileEdits.length} edit(s)`)
      continue
    }
    let content = fs.readFileSync(absPath, "utf-8")
    // Apply offset-descending so earlier edits don't shift later offsets.
    const sorted = [...fileEdits].sort((a, b) => b.offset - a.offset)
    for (const edit of sorted) {
      content = content.slice(0, edit.offset) + edit.replacement + content.slice(edit.offset + edit.length)
      count++
    }
    fs.writeFileSync(absPath, content)
  }
  return count
}

/**
 * Save a file editset to disk
 */
export function saveFileEditset(editset: FileEditset, outputPath: string): void {
  fs.writeFileSync(outputPath, JSON.stringify(editset, null, 2))
}

/**
 * Load a file editset from disk
 */
export function loadFileEditset(inputPath: string): FileEditset {
  const content = fs.readFileSync(inputPath, "utf-8")
  return JSON.parse(content) as FileEditset
}
