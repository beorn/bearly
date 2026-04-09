import { execFileSync } from "child_process"
import { readFileSync, existsSync } from "fs"
import type { Reference, Editset, Edit } from "../../core/types"
import { computeChecksum, computeRefId } from "../../core/apply"

/**
 * Find text patterns using ripgrep
 *
 * @param pattern - Regex pattern to search for
 * @param glob - Optional file glob filter (e.g., "*.md")
 * @param caseInsensitive - If true, pass `-i` to ripgrep for case-insensitive matching
 */
export function findPatterns(pattern: string, glob?: string, caseInsensitive = false): Reference[] {
  const args = ["--json", "--line-number", "--column"]
  if (caseInsensitive) args.push("-i")
  args.push(pattern)
  if (glob) {
    args.push("--glob", glob)
  }
  args.push(".") // Search current directory

  const result = runRg(args)
  if (!result) return []

  return parseMatches(result, pattern, caseInsensitive)
}

/**
 * Create an editset for text-based search and replace
 *
 * @param pattern - Regex pattern to match
 * @param replacement - Replacement string (supports $1, $2, etc. for capture groups)
 * @param glob - Optional file glob filter
 * @param caseInsensitive - If true, match any case and apply case-preservation to the replacement
 *                          (widget→gadget, Widget→Gadget, WIDGET→GADGET). If false (default),
 *                          match exactly and replace literally.
 */
export function createPatternReplaceProposal(
  pattern: string,
  replacement: string,
  glob?: string,
  caseInsensitive = false,
): Editset {
  const refs = findPatterns(pattern, glob, caseInsensitive)

  const id = `text-replace-${Date.now()}`

  // Generate edits with proper replacements
  const edits = generateEdits(refs, pattern, replacement, caseInsensitive)

  return {
    id,
    operation: "rename",
    pattern,
    from: pattern,
    to: replacement,
    refs,
    edits,
    createdAt: new Date().toISOString(),
  }
}

// Internal helpers

interface RgMatch {
  type: "match"
  data: {
    path: { text: string }
    lines: { text: string }
    line_number: number
    absolute_offset: number
    submatches: Array<{
      match: { text: string }
      start: number
      end: number
    }>
  }
}

interface RgLine {
  type: string
  data?: unknown
}

function runRg(args: string[]): RgMatch[] | null {
  try {
    const output = execFileSync("rg", args, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
      stdio: ["pipe", "pipe", "pipe"],
    })

    // Parse NDJSON output (one JSON object per line)
    const matches: RgMatch[] = []
    for (const line of output.split("\n")) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as RgLine
        if (parsed.type === "match") {
          matches.push(parsed as RgMatch)
        }
      } catch {
        // Skip malformed lines
      }
    }
    return matches
  } catch (error: unknown) {
    // ripgrep returns exit code 1 when no matches found
    const execError = error as { status?: number }
    if (execError.status === 1) {
      return []
    }
    // Check if rg is installed
    if (error instanceof Error && (error.message.includes("ENOENT") || error.message.includes("not found"))) {
      throw new Error("ripgrep (rg) not found. Install via: brew install ripgrep")
    }
    throw error
  }
}

function parseMatches(matches: RgMatch[], pattern: string, _caseInsensitive: boolean): Reference[] {
  const refs: Reference[] = []
  const fileContents = new Map<string, string>()

  for (const match of matches) {
    const filePath = match.data.path.text
    const lineNumber = match.data.line_number

    // Get file content for checksum
    let content = fileContents.get(filePath)
    if (!content) {
      if (!existsSync(filePath)) continue
      content = readFileSync(filePath, "utf-8")
      fileContents.set(filePath, content)
    }

    const checksum = computeChecksum(content)

    // Process each submatch on this line
    for (const submatch of match.data.submatches) {
      const startCol = submatch.start + 1 // Convert to 1-indexed
      const endCol = submatch.end + 1

      const refId = computeRefId(filePath, lineNumber, startCol, lineNumber, endCol)

      // Use the line text as preview
      const preview = match.data.lines.text.trim()

      refs.push({
        refId,
        file: filePath,
        range: [lineNumber, startCol, lineNumber, endCol],
        preview: `${preview} // "${submatch.match.text}" → "${pattern}"`,
        checksum,
        selected: true,
      })
    }
  }

  return refs
}

/**
 * Case-matching replacement, used ONLY when the user asked for case-insensitive matching
 * (the `/i` flag on the pattern). Matches the case pattern of the original text in the
 * replacement — the standard behavior for prose terminology migrations.
 *
 * Examples:
 *   caseMatch("widget", "gadget") → "gadget"  (lowercase → lowercase)
 *   caseMatch("Widget", "gadget") → "Gadget"  (PascalCase → PascalCase)
 *   caseMatch("WIDGET", "gadget") → "GADGET"  (UPPER → UPPER)
 *
 * When the pattern is case-SENSITIVE (no `/i`), this function is not called and the
 * replacement is applied literally — which is the correct behavior for code identifier
 * renames where mixed case like `scrollRect` must be preserved exactly as written.
 */
function caseMatch(match: string, replacement: string): string {
  // SCREAMING_CASE: entire match is uppercase
  if (match === match.toUpperCase() && match.length > 1) {
    return replacement.toUpperCase()
  }
  // PascalCase/TitleCase: first char is uppercase
  if (match[0] === match[0]!.toUpperCase()) {
    return replacement[0]!.toUpperCase() + replacement.slice(1)
  }
  // camelCase/lowercase
  return replacement.toLowerCase()
}

function generateEdits(refs: Reference[], pattern: string, replacement: string, caseInsensitive: boolean): Edit[] {
  const edits: Edit[] = []
  const fileContents = new Map<string, string>()
  // The `g` flag is always set (we're processing file content, replacing all matches);
  // the `i` flag is only added if the caller asked for case-insensitive matching.
  const regex = new RegExp(pattern, caseInsensitive ? "gi" : "g")

  for (const ref of refs) {
    if (!ref.selected) continue

    // Get file content
    let content = fileContents.get(ref.file)
    if (!content) {
      if (!existsSync(ref.file)) continue
      content = readFileSync(ref.file, "utf-8")
      fileContents.set(ref.file, content)
    }

    // Calculate byte offset from line/col
    // Note: ripgrep returns byte offsets (0-indexed) which we store as 1-indexed in ref.range
    // We need to convert these to character offsets for string.slice()
    const lines = content.split("\n")
    let byteOffset = 0
    // Add byte length of all previous lines
    for (let i = 0; i < ref.range[0] - 1; i++) {
      byteOffset += Buffer.byteLength(lines[i]!, "utf-8") + 1 // +1 for newline
    }
    // Add byte offset within the current line (ref.range[1] is 1-indexed byte offset)
    byteOffset += ref.range[1] - 1

    // Convert byte offset to character offset for string.slice()
    // We need to find how many characters are in the first byteOffset bytes
    const contentAsBuffer = Buffer.from(content, "utf-8")
    const prefixBytes = contentAsBuffer.slice(0, byteOffset)
    const charOffset = prefixBytes.toString("utf-8").length

    // Calculate match length: convert byte positions to character positions
    const matchEndByteOffset = byteOffset + (ref.range[3] - ref.range[1])
    const matchEndBytes = contentAsBuffer.slice(0, matchEndByteOffset)
    const matchEndCharOffset = matchEndBytes.toString("utf-8").length
    const matchLength = matchEndCharOffset - charOffset

    // Get the actual matched text to compute proper replacement
    const matchedText = content.slice(charOffset, charOffset + matchLength)
    // Case-insensitive matches apply case-preservation (widget→Widget→WIDGET);
    // case-sensitive matches use the replacement literally.
    const actualReplacement = caseInsensitive
      ? matchedText.replace(regex, (m) => caseMatch(m, replacement))
      : matchedText.replace(regex, replacement)

    edits.push({
      file: ref.file,
      offset: charOffset,
      length: matchLength,
      replacement: actualReplacement,
    })
  }

  // Sort by file then by offset descending
  return edits.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file)
    return b.offset - a.offset
  })
}
