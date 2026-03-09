import { execSync } from "child_process"
import { readFileSync, existsSync } from "fs"
import { basename, dirname, relative, resolve } from "path"
import type { Reference, Edit, FileEditset, FileOp } from "../../core/types"
import { computeChecksum, computeRefId } from "../../core/apply"
import { offsetToLineCol, lineColToOffset, getLinePreview } from "../../core/text-utils"
import { findFiles } from "../../core/file-discovery"
import { parseWikiLinks, linkMatchesTarget, generateReplacement, type WikiLink } from "./parser"

/**
 * Find all wikilinks pointing to a specific file
 *
 * @param targetFile - The file that links point TO (absolute or relative path)
 * @param searchPath - Directory to search for markdown files
 * @param glob - Optional glob pattern (defaults to "*.md")
 */
export function findLinksToFile(targetFile: string, searchPath: string = ".", glob: string = "**/*.md"): Reference[] {
  const targetName = basename(targetFile).replace(/\.md$/, "")
  const targetPath = targetFile.replace(/\.md$/, "")

  // Use ripgrep to find candidate files (fast pre-filter)
  const candidates = findCandidateFiles(targetName, searchPath, glob)
  if (candidates.length === 0) return []

  const refs: Reference[] = []

  for (const file of candidates) {
    if (!existsSync(file)) continue

    const content = readFileSync(file, "utf-8")
    const checksum = computeChecksum(content)
    const links = parseWikiLinks(content)

    for (const link of links) {
      if (linkMatchesTarget(link, targetName, targetPath)) {
        // Calculate line/column from byte offset
        const [line, col] = offsetToLineCol(content, link.start)
        const [endLine, endCol] = offsetToLineCol(content, link.end)

        const refId = computeRefId(file, line, col, endLine, endCol)
        const preview = getLinePreview(content, line)

        refs.push({
          refId,
          file,
          range: [line, col, endLine, endCol],
          preview: `${preview} // ${link.raw}`,
          checksum,
          selected: true,
        })
      }
    }
  }

  return refs
}

/**
 * Create a file rename editset that updates all wikilinks
 *
 * This is the main entry point for file renames in wiki repos.
 *
 * @param oldPath - Current file path
 * @param newPath - New file path
 * @param searchPath - Directory to search for markdown files
 */
export function createFileRenameEditset(oldPath: string, newPath: string, searchPath: string = "."): FileEditset {
  const oldName = basename(oldPath).replace(/\.md$/, "")
  const newName = basename(newPath).replace(/\.md$/, "")

  // Find all links to the old file
  const refs = findLinksToFile(oldPath, searchPath)

  // Generate edits to update each link
  const edits: Edit[] = []

  for (const ref of refs) {
    if (!ref.selected) continue
    if (!existsSync(ref.file)) continue

    const content = readFileSync(ref.file, "utf-8")
    const links = parseWikiLinks(content)

    // Find the specific link at this reference's location
    const link = links.find((l) => l.start === lineColToOffset(content, ref.range[0], ref.range[1]))
    if (!link) continue

    // Determine if we need path in the new link
    let replacementTarget = newName
    if (link.target.includes("/")) {
      // Original link had a path, preserve directory structure
      const linkDir = dirname(link.target)
      replacementTarget = `${linkDir}/${newName}`
    }

    const replacement = generateReplacement(link, replacementTarget)

    edits.push({
      file: ref.file,
      offset: link.start,
      length: link.end - link.start,
      replacement,
    })
  }

  // Sort edits by file then offset descending (for safe application)
  edits.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file)
    return b.offset - a.offset
  })

  // Create the file operation for the actual rename
  const fileChecksum = existsSync(oldPath) ? computeChecksum(readFileSync(oldPath, "utf-8")) : ""

  const fileOp: FileOp = {
    opId: computeRefId(oldPath, 0, 0, 0, 0),
    type: "rename",
    oldPath: resolve(oldPath),
    newPath: resolve(newPath),
    checksum: fileChecksum,
  }

  return {
    id: `wikilink-rename-${oldName}-to-${newName}-${Date.now()}`,
    operation: "file-rename",
    pattern: oldName,
    replacement: newName,
    fileOps: [fileOp],
    importEdits: edits,
    createdAt: new Date().toISOString(),
  }
}

/**
 * Find all broken wikilinks (links to non-existent files)
 */
export function findBrokenLinks(searchPath: string = ".", glob: string = "**/*.md"): Reference[] {
  const files = findFiles(glob, searchPath)
  const existingFiles = new Set(files.map((f) => basename(f).replace(/\.md$/, "").toLowerCase()))

  const refs: Reference[] = []

  for (const file of files) {
    const content = readFileSync(file, "utf-8")
    const checksum = computeChecksum(content)
    const links = parseWikiLinks(content)

    for (const link of links) {
      // Check if target exists (simple name match)
      const targetName = basename(link.target).toLowerCase()
      if (!existingFiles.has(targetName)) {
        const [line, col] = offsetToLineCol(content, link.start)
        const [endLine, endCol] = offsetToLineCol(content, link.end)

        refs.push({
          refId: computeRefId(file, line, col, endLine, endCol),
          file,
          range: [line, col, endLine, endCol],
          preview: `BROKEN: ${link.raw} → target "${link.target}" not found`,
          checksum,
          selected: true,
        })
      }
    }
  }

  return refs
}

// Internal helpers

function findCandidateFiles(targetName: string, searchPath: string, glob: string): string[] {
  try {
    // Use ripgrep to find files containing the target name
    const pattern = targetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const output = execSync(`rg -l "${pattern}" --glob "${glob}" "${searchPath}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
    return output.trim().split("\n").filter(Boolean)
  } catch (error: unknown) {
    const execError = error as { status?: number }
    if (execError.status === 1) return [] // No matches
    throw error
  }
}

