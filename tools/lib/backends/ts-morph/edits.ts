import { Project } from "ts-morph"
import type { Editset, Reference, Edit, SymbolMatch, ConflictReport, Conflict, SafeRename } from "../../core/types"
import { getReferences, findSymbols, findAllSymbols, computeNewName } from "./symbols"
import { computeChecksum, computeRefId } from "../../core/apply"

/**
 * Create an editset for renaming a single symbol
 */
export function createRenameProposal(project: Project, symbolKey: string, newName: string): Editset {
  const [filePath, lineStr, colStr, oldName] = symbolKey.split(":")
  const refs = getReferences(project, symbolKey)

  const id = `rename-${oldName}-to-${newName}-${Date.now()}`

  // Generate edits from references
  const edits = generateEditsFromRefs(project, refs, oldName!, newName)

  return {
    id,
    operation: "rename",
    symbolKey,
    from: oldName!,
    to: newName,
    refs,
    edits,
    createdAt: new Date().toISOString(),
  }
}

/**
 * Create an editset for batch renaming all symbols matching a pattern
 */
export function createBatchRenameProposal(project: Project, pattern: RegExp, replacement: string): Editset {
  const symbols = findSymbols(project, pattern)
  const allRefs: Reference[] = []
  const seenRefIds = new Set<string>()

  for (const sym of symbols) {
    const newName = computeNewName(sym.name, pattern, replacement)
    if (newName === sym.name) continue // Skip if no change

    const refs = getReferences(project, sym.symbolKey)
    for (const ref of refs) {
      // Deduplicate refs (same location might be found from different symbols)
      if (!seenRefIds.has(ref.refId)) {
        seenRefIds.add(ref.refId)
        // Update ref with the specific rename for this symbol
        allRefs.push({
          ...ref,
          preview: `${ref.preview} // ${sym.name} → ${newName}`,
        })
      }
    }
  }

  const id = `rename-batch-${pattern.source}-to-${replacement}-${Date.now()}`

  // Generate edits - we'll apply them per-symbol during apply phase
  const { edits, defRefs } = generateBatchEdits(project, symbols, pattern, replacement)
  mergeDefRefs(allRefs, defRefs, seenRefIds)

  return {
    id,
    operation: "rename",
    pattern: pattern.source,
    from: pattern.source,
    to: replacement,
    refs: allRefs,
    edits,
    createdAt: new Date().toISOString(),
  }
}

/**
 * Check for naming conflicts before batch rename
 */
export function checkConflicts(project: Project, pattern: RegExp, replacement: string): ConflictReport {
  // Get symbols that match the rename pattern
  const matchingSymbols = findSymbols(project, pattern)

  // Get ALL symbols in the codebase for conflict detection
  const allSymbols = findAllSymbols(project)

  // Build a map of existing names -> symbolKey
  const existingNames = new Map<string, string>()
  for (const sym of allSymbols) {
    // Only add the first occurrence (in case of duplicates)
    if (!existingNames.has(sym.name)) {
      existingNames.set(sym.name, sym.symbolKey)
    }
  }

  const conflicts: Conflict[] = []
  const safe: SafeRename[] = []
  const seenNames = new Set<string>()

  for (const sym of matchingSymbols) {
    // Skip if we've already processed a symbol with this name
    if (seenNames.has(sym.name)) continue
    seenNames.add(sym.name)

    const newName = computeNewName(sym.name, pattern, replacement)
    if (newName === sym.name) continue // Skip if no change

    // Check if newName already exists
    const existingKey = existingNames.get(newName)
    if (existingKey) {
      // Conflict: the new name already exists as a different symbol
      conflicts.push({
        from: sym.name,
        to: newName,
        existingSymbol: existingKey,
        suggestion: `use --skip ${sym.name} (keep as deprecated API)`,
      })
    } else {
      safe.push({ from: sym.name, to: newName })
    }
  }

  return { conflicts, safe }
}

/**
 * Create batch rename proposal, optionally skipping certain symbols
 */
export function createBatchRenameProposalFiltered(
  project: Project,
  pattern: RegExp,
  replacement: string,
  skipNames: string[],
): Editset {
  const skipSet = new Set(skipNames)
  const symbols = findSymbols(project, pattern).filter((sym) => !skipSet.has(sym.name))

  const allRefs: Reference[] = []
  const seenRefIds = new Set<string>()

  for (const sym of symbols) {
    const newName = computeNewName(sym.name, pattern, replacement)
    if (newName === sym.name) continue

    const refs = getReferences(project, sym.symbolKey)
    for (const ref of refs) {
      if (!seenRefIds.has(ref.refId)) {
        seenRefIds.add(ref.refId)
        allRefs.push({
          ...ref,
          preview: `${ref.preview} // ${sym.name} → ${newName}`,
        })
      }
    }
  }

  const id = `rename-batch-${pattern.source}-to-${replacement}-${Date.now()}`
  const { edits, defRefs } = generateBatchEdits(project, symbols, pattern, replacement)
  mergeDefRefs(allRefs, defRefs, seenRefIds)

  return {
    id,
    operation: "rename",
    pattern: pattern.source,
    from: pattern.source,
    to: replacement,
    refs: allRefs,
    edits,
    createdAt: new Date().toISOString(),
  }
}

// Internal helpers

/** Merge synthetic declaration refs (from generateBatchEdits) into the caller's ref list,
 *  respecting the same refId dedup the caller already applies to usage refs. */
function mergeDefRefs(allRefs: Reference[], defRefs: Reference[], seenRefIds: Set<string>): void {
  for (const ref of defRefs) {
    if (!seenRefIds.has(ref.refId)) {
      seenRefIds.add(ref.refId)
      allRefs.push(ref)
    }
  }
}

function generateEditsFromRefs(project: Project, refs: Reference[], oldName: string, newName: string): Edit[] {
  const edits: Edit[] = []
  const fileContents = new Map<string, string>()

  for (const ref of refs) {
    // Get file content
    let content = fileContents.get(ref.file)
    if (!content) {
      const sf = project.getSourceFile(ref.file)
      if (!sf) continue
      content = sf.getFullText()
      fileContents.set(ref.file, content)
    }

    // Character offset from line/col — ts-morph counts in JS string indices throughout,
    // which is the unit an Edit carries.
    const lines = content.split("\n")
    let offset = 0
    for (let i = 0; i < ref.range[0] - 1; i++) {
      offset += lines[i]!.length + 1 // +1 for newline
    }
    offset += ref.range[1] - 1 // column offset

    edits.push({
      file: ref.file,
      offset,
      length: oldName.length,
      replacement: newName,
      before: content.slice(offset, offset + oldName.length),
      refId: ref.refId,
    })
  }

  return sortEditsForApplication(edits)
}

function generateBatchEdits(
  project: Project,
  symbols: SymbolMatch[],
  pattern: RegExp,
  replacement: string,
): { edits: Edit[]; defRefs: Reference[] } {
  const allEdits: Edit[] = []
  const defRefs: Reference[] = []
  const seenLocations = new Set<string>()
  const fileContents = new Map<string, string>()

  for (const sym of symbols) {
    const newName = computeNewName(sym.name, pattern, replacement)
    if (newName === sym.name) continue

    // Add edit for the symbol DEFINITION itself (not included in references — ts-morph's
    // findReferencesAsNodes() excludes the declaring identifier itself; confirmed empirically
    // against this vendored ts-morph version, not assumed).
    const def = createDefinitionEdit(project, sym, newName, fileContents)
    if (def) {
      const key = `${def.edit.file}:${def.edit.offset}:${def.edit.length}`
      if (!seenLocations.has(key)) {
        seenLocations.add(key)
        allEdits.push(def.edit)
        defRefs.push(def.ref)
      }
    }

    // Add edits for all references
    const refs = getReferences(project, sym.symbolKey)
    const edits = generateEditsFromRefs(project, refs, sym.name, newName)

    for (const edit of edits) {
      const key = `${edit.file}:${edit.offset}:${edit.length}`
      if (!seenLocations.has(key)) {
        seenLocations.add(key)
        allEdits.push(edit)
      }
    }
  }

  return { edits: sortEditsForApplication(allEdits), defRefs }
}

/**
 * Locate a symbol's own definition/declaration site within its file — line, column, and
 * character offset — from the first occurrence of `sym.name` on `sym.line`.
 *
 * This heuristic can mis-locate when the name recurs earlier on the same line (tracked
 * separately as @hh/tooling ledger defect #2 — `createDefinitionEdit` indexOf corruption).
 * This function doesn't fix that; it exists so createDefinitionEdit's Edit and its matching
 * Reference are derived from the exact same computation and therefore always agree on
 * refId — the declaration becomes independently selectable instead of structurally unable
 * to carry a refId at all.
 */
function findDefinitionSpan(
  content: string,
  line: number,
  name: string,
): { offset: number; col: number; lineText: string } | null {
  const lines = content.split("\n")
  let offset = 0
  for (let i = 0; i < line - 1 && i < lines.length; i++) {
    offset += (lines[i]?.length ?? 0) + 1 // +1 for newline
  }
  const lineText = lines[line - 1]
  if (!lineText) return null
  const symIndex = lineText.indexOf(name)
  if (symIndex === -1) return null
  return { offset: offset + symIndex, col: symIndex + 1, lineText }
}

function createDefinitionEdit(
  project: Project,
  sym: SymbolMatch,
  newName: string,
  fileContents: Map<string, string>,
): { edit: Edit; ref: Reference } | null {
  // Get file content
  let content = fileContents.get(sym.file)
  if (!content) {
    const sf = project.getSourceFile(sym.file)
    if (!sf) return null
    content = sf.getFullText()
    fileContents.set(sym.file, content)
  }

  const span = findDefinitionSpan(content, sym.line, sym.name)
  if (!span) return null

  const endCol = span.col + sym.name.length
  const refId = computeRefId(sym.file, sym.line, span.col, sym.line, endCol)
  const before = content.slice(span.offset, span.offset + sym.name.length)

  return {
    edit: {
      file: sym.file,
      offset: span.offset,
      length: sym.name.length,
      replacement: newName,
      before,
      refId,
    },
    ref: {
      refId,
      file: sym.file,
      range: [sym.line, span.col, sym.line, endCol],
      preview: `${span.lineText.trim()} // ${sym.name} → ${newName} (declaration)`,
      checksum: computeChecksum(content),
      selected: true,
      kind: "decl",
    },
  }
}

/** Sort edits by file, then by offset descending (for safe reverse application) */
function sortEditsForApplication(edits: Edit[]): Edit[] {
  return edits.sort((a, b) => (a.file !== b.file ? a.file.localeCompare(b.file) : b.offset - a.offset))
}
