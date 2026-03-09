import { readFileSync, existsSync } from "fs"
import { dirname, join, relative } from "path"
import type { Reference, Edit, Editset } from "../../core/types"
import { computeChecksum, computeRefId } from "../../core/apply"
import { offsetToLineCol } from "../../core/text-utils"
import { findFiles } from "../../core/file-discovery"
import { parseTsConfig, tsconfigPathMatchesFile, generateTsConfigReplacementPath } from "./parser"

/**
 * Find all tsconfig.json files that reference a specific file
 */
export function findTsConfigRefs(
  targetFile: string,
  searchPath: string = ".",
  glob: string = "**/tsconfig*.json",
): Reference[] {
  const refs: Reference[] = []
  const tsconfigFiles = findFiles(glob, searchPath, true)

  for (const configFile of tsconfigFiles) {
    if (!existsSync(configFile)) continue

    const content = readFileSync(configFile, "utf-8")
    const checksum = computeChecksum(content)
    const pathRefs = parseTsConfig(content)
    const configDir = dirname(configFile)

    for (const pathRef of pathRefs) {
      const targetRelative = relative(configDir, join(searchPath, targetFile))

      if (tsconfigPathMatchesFile(pathRef.path, targetRelative)) {
        const [line, col] = offsetToLineCol(content, pathRef.start)
        const [endLine, endCol] = offsetToLineCol(content, pathRef.end)

        refs.push({
          refId: computeRefId(configFile, line, col, endLine, endCol),
          file: relative(searchPath, configFile),
          range: [line, col, endLine, endCol],
          preview: `${pathRef.field}: "${pathRef.path}"`,
          checksum,
          selected: true,
        })
      }
    }
  }

  return refs
}

/**
 * Generate edits to update tsconfig.json when files are renamed
 */
export function findTsConfigEdits(oldPath: string, newPath: string, searchPath: string = "."): Edit[] {
  const edits: Edit[] = []
  const tsconfigFiles = findFiles("**/tsconfig*.json", searchPath, true)

  for (const configFile of tsconfigFiles) {
    if (!existsSync(configFile)) continue

    const content = readFileSync(configFile, "utf-8")
    const pathRefs = parseTsConfig(content)
    const configDir = dirname(configFile)

    for (const pathRef of pathRefs) {
      const oldRelative = relative(configDir, join(searchPath, oldPath))

      if (tsconfigPathMatchesFile(pathRef.path, oldRelative)) {
        const newRelative = relative(configDir, join(searchPath, newPath))
        const replacement = generateTsConfigReplacementPath(pathRef.path, oldPath, newRelative)

        const originalQuote = content[pathRef.start]
        const fullReplacement = `${originalQuote}${replacement}${originalQuote}`

        edits.push({
          file: relative(searchPath, configFile),
          offset: pathRef.start,
          length: pathRef.end - pathRef.start,
          replacement: fullReplacement,
        })
      }
    }
  }

  return edits.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file)
    return b.offset - a.offset
  })
}

/**
 * Create an editset for updating tsconfig.json paths
 */
export function createTsConfigEditset(oldPath: string, newPath: string, searchPath: string = "."): Editset {
  const edits = findTsConfigEdits(oldPath, newPath, searchPath)

  const refs: Reference[] = []
  for (const edit of edits) {
    const filePath = join(searchPath, edit.file)
    if (!existsSync(filePath)) continue

    const content = readFileSync(filePath, "utf-8")
    const checksum = computeChecksum(content)
    const [line, col] = offsetToLineCol(content, edit.offset)
    const [endLine, endCol] = offsetToLineCol(content, edit.offset + edit.length)

    refs.push({
      refId: computeRefId(edit.file, line, col, endLine, endCol),
      file: edit.file,
      range: [line, col, endLine, endCol],
      preview: `Update path to ${newPath}`,
      checksum,
      selected: true,
    })
  }

  return {
    id: `tsconfig-json-${Date.now()}`,
    operation: "rename",
    from: oldPath,
    to: newPath,
    refs,
    edits,
    createdAt: new Date().toISOString(),
  }
}

