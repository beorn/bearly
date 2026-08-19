import { execFileSync } from "child_process"
import { readFileSync, existsSync } from "fs"
import type { Reference, Editset, Edit } from "../../core/types"
import { computeChecksum, computeRefId } from "../../core/apply"
import { createByteToCharMapper } from "../../core/text-utils"

/**
 * Find patterns using ast-grep structural search
 *
 * @param pattern - ast-grep pattern (e.g., "fmt.Println($MSG)" for Go)
 * @param glob - Optional file glob filter (e.g., "**\/*.go")
 */
export function findPatterns(pattern: string, glob?: string): Reference[] {
  const args = ["run", "-p", pattern, "--json"]
  if (glob) {
    args.push("--filter", glob)
  }

  const result = runSg(args)
  if (!result) return []

  return parseMatches(result)
}

/**
 * Create an editset for pattern-based replacements
 *
 * @param pattern - ast-grep pattern with metavariables (e.g., "fmt.Println($MSG)")
 * @param replacement - Replacement with metavariables (e.g., "log.Info($MSG)")
 * @param glob - Optional file glob filter
 */
export function createPatternReplaceProposal(pattern: string, replacement: string, glob?: string): Editset {
  const args = ["run", "-p", pattern, "--json"]
  if (glob) args.push("--filter", glob)
  const matches = runSg(args) ?? []

  const refs = parseMatches(matches)
  const id = `pattern-replace-${Date.now()}`

  // Edits come from the same match objects as the refs, so they can use ast-grep's own
  // byteOffset instead of reconstructing a position from line/column.
  const edits = generateEdits(matches, replacement)

  return {
    id,
    operation: "rename", // Using "rename" since that's what Editset supports
    pattern,
    from: pattern,
    to: replacement,
    refs,
    edits,
    createdAt: new Date().toISOString(),
  }
}

// Internal helpers

interface SgMatch {
  file: string
  range: {
    byteOffset: { start: number; end: number }
    start: { line: number; column: number }
    end: { line: number; column: number }
  }
  text: string
  replacement?: string
  metaVariables?: Record<string, { text: string }>
}

function runSg(args: string[]): SgMatch[] | null {
  try {
    const output = execFileSync("sg", args, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large codebases
      stdio: ["pipe", "pipe", "pipe"],
    })
    return JSON.parse(output) as SgMatch[]
  } catch (error: unknown) {
    // ast-grep returns exit code 1 when no matches found
    const execError = error as { status?: number; stdout?: string }
    if (execError.status === 1 && !execError.stdout) {
      return []
    }
    // Check if sg is installed
    if (error instanceof Error && (error.message.includes("ENOENT") || error.message.includes("not found"))) {
      throw new Error("ast-grep CLI (sg) not found. Install via: brew install ast-grep or cargo install ast-grep")
    }
    throw error
  }
}

function parseMatches(matches: SgMatch[]): Reference[] {
  const refs: Reference[] = []
  const fileContents = new Map<string, string>()

  for (const match of matches) {
    // Get file content for checksum
    let content = fileContents.get(match.file)
    if (!content) {
      if (!existsSync(match.file)) continue
      content = readFileSync(match.file, "utf-8")
      fileContents.set(match.file, content)
    }

    const checksum = computeChecksum(content)
    const { start, end } = match.range
    const refId = computeRefId(match.file, start.line, start.column, end.line, end.column)

    // Get preview (the line containing the match)
    const lines = content.split("\n")
    const preview = lines[start.line - 1]?.trim() || ""

    refs.push({
      refId,
      file: match.file,
      range: [start.line, start.column, end.line, end.column],
      preview,
      checksum,
      selected: true,
    })
  }

  return refs
}

/**
 * Turn ast-grep matches into edits.
 *
 * ast-grep reports `range.byteOffset` in UTF-8 bytes; an Edit carries character offsets.
 * Converting through the shared mapper is the whole reason this doesn't rebuild positions
 * from line/column — mixing a character-counted line start with a byte column is how a
 * replacement ends up a few characters off in any file with non-ASCII text.
 */
function generateEdits(matches: SgMatch[], replacement: string): Edit[] {
  const edits: Edit[] = []
  const fileOffsets = new Map<string, { content: string; toChar: (byteOffset: number) => number } | null>()

  for (const match of matches) {
    let offsets = fileOffsets.get(match.file)
    if (offsets === undefined) {
      if (existsSync(match.file)) {
        const content = readFileSync(match.file, "utf-8")
        offsets = { content, toChar: createByteToCharMapper(content) }
      } else {
        offsets = null
      }
      fileOffsets.set(match.file, offsets)
    }
    if (offsets === null) continue

    // Throws rather than guessing when the byte positions don't describe this text.
    const offset = offsets.toChar(match.range.byteOffset.start)
    const length = offsets.toChar(match.range.byteOffset.end) - offset

    // Note: For ast-grep, the replacement should ideally come from sg --rewrite
    // For now, we use the provided replacement directly
    // TODO: Use `sg run -p <pattern> --rewrite <replacement> --json` to get actual replacements
    //
    // refId is recomputed from the same match.range fields parseMatches() hashed for the
    // Reference — deterministic, so it lands on the identical id without threading refs
    // through this function's signature.
    const { start, end } = match.range
    edits.push({
      file: match.file,
      offset,
      length,
      replacement,
      before: offsets.content.slice(offset, offset + length),
      refId: computeRefId(match.file, start.line, start.column, end.line, end.column),
    })
  }

  // Sort by file then by offset descending
  return edits.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file)
    return b.offset - a.offset
  })
}
