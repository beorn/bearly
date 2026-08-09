/**
 * Dependency-NAME rename for package.json.
 *
 * Distinct from the path-field rename in ./search.ts (which updates main/module/types/exports/...
 * when a FILE moves). This renames a package IDENTIFIER — e.g. `@km/code` → `@ag/code` — across:
 *   - the declaring package's own `name` field (the value)
 *   - every dependency map KEY: dependencies, devDependencies, peerDependencies,
 *     optionalDependencies, peerDependenciesMeta, overrides
 *
 * It deliberately does NOT touch prose (descriptions), scripts, or version-range values — only the
 * exact identifier occurrences in the structural positions above. This is the gating capability for
 * the v0.7 namespace reorg (20146 §156-169), where package scopes are renamed before files move.
 */

import { readFileSync, existsSync } from "fs"
import { relative, join } from "path"
import type { Edit, Editset, Reference } from "../../core/types"
import { computeChecksum, computeRefId } from "../../core/apply"
import { offsetToLineCol } from "../../core/text-utils"
import { findFiles } from "../../core/file-discovery"

/** Dependency maps whose KEYS are package names. */
const DEP_MAP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "peerDependenciesMeta",
  "overrides",
] as const

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Locate the object value span for a top-level field: returns [openBraceIndex, closeBraceIndex]
 * (inclusive of the braces) or null if the field is absent / not an object.
 */
function findObjectFieldSpan(content: string, field: string): [number, number] | null {
  const keyMatch = new RegExp(`"${escapeRegex(field)}"\\s*:\\s*\\{`).exec(content)
  if (!keyMatch) return null

  // The opening brace is the last char of the match.
  const openBrace = keyMatch.index + keyMatch[0].length - 1

  // Scan forward to the matching close brace, respecting string literals.
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = openBrace; i < content.length; i++) {
    const ch = content[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return [openBrace, i]
    }
  }
  return null
}

/**
 * Find the quoted KEY `"<name>":` within [start, end] and return an edit replacing the quoted
 * string (quotes included) with `"<newName>"`.
 */
function findKeyEdit(
  content: string,
  span: [number, number],
  oldName: string,
  newName: string,
): Omit<Edit, "file"> | null {
  const [start, end] = span
  const region = content.slice(start, end + 1)
  const keyRe = new RegExp(`"${escapeRegex(oldName)}"\\s*:`)
  const m = keyRe.exec(region)
  if (!m) return null
  const offset = start + m.index // position of the opening quote
  const length = oldName.length + 2 // include both quotes
  return { offset, length, replacement: `"${newName}"`, before: content.slice(offset, offset + length) }
}

/**
 * Find the `name` field VALUE `"name": "<old>"` and return an edit on the value's quoted string.
 */
function findNameValueEdit(content: string, oldName: string, newName: string): Omit<Edit, "file"> | null {
  const re = new RegExp(`("name"\\s*:\\s*)"${escapeRegex(oldName)}"`)
  const m = re.exec(content)
  if (!m) return null
  const offset = m.index + m[1]!.length // position of the value's opening quote
  const length = oldName.length + 2
  return { offset, length, replacement: `"${newName}"`, before: content.slice(offset, offset + length) }
}

/**
 * Generate edits to rename a package identifier across all package.json files under `searchPath`.
 */
export function findDependencyNameEdits(
  oldName: string,
  newName: string,
  searchPath: string = ".",
  glob: string = "**/package.json",
): Edit[] {
  const edits: Edit[] = []

  for (const pkgFile of findFiles(glob, searchPath, true)) {
    if (!existsSync(pkgFile)) continue

    const content = readFileSync(pkgFile, "utf-8")
    let pkg: Record<string, unknown>
    try {
      pkg = JSON.parse(content) as Record<string, unknown>
    } catch {
      continue // malformed package.json — skip, don't guess
    }

    const fileRel = relative(searchPath, pkgFile)
    const fileEdits: Omit<Edit, "file">[] = []

    // The declaring package's own name.
    if (pkg.name === oldName) {
      const e = findNameValueEdit(content, oldName, newName)
      if (e) fileEdits.push(e)
    }

    // Dependency-map keys.
    for (const field of DEP_MAP_FIELDS) {
      const map = pkg[field]
      if (!map || typeof map !== "object" || Array.isArray(map)) continue
      if (!Object.prototype.hasOwnProperty.call(map, oldName)) continue
      const span = findObjectFieldSpan(content, field)
      if (!span) continue
      const e = findKeyEdit(content, span, oldName, newName)
      if (e) fileEdits.push(e)
    }

    for (const e of fileEdits) {
      edits.push({ file: fileRel, ...e })
    }
  }

  // Sort by file then offset descending (safe application order).
  return edits.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file)
    return b.offset - a.offset
  })
}

/**
 * Build an applyable Editset for a dependency-name rename (refs carry checksums for drift safety).
 */
export function createDependencyRenameEditset(
  oldName: string,
  newName: string,
  searchPath: string = ".",
  glob: string = "**/package.json",
): Editset {
  const edits = findDependencyNameEdits(oldName, newName, searchPath, glob)

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
      preview: `Rename dependency ${oldName} → ${newName}`,
      checksum,
      selected: true,
    })
  }

  return {
    id: `package-dep-rename-${Date.now()}`,
    operation: "rename",
    from: oldName,
    to: newName,
    refs,
    edits,
    createdAt: new Date().toISOString(),
  }
}
