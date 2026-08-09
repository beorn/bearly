import { execFileSync } from "child_process"
import { readFileSync, existsSync } from "fs"
import type { Reference, Editset, Edit } from "../../core/types"
import { computeChecksum, computeRefId } from "../../core/apply"
import { createByteToCharMapper } from "../../core/text-utils"

/**
 * Normalize a glob argument to an array. Each entry maps to one ripgrep `--glob`.
 * Inclusion globs are passed verbatim; exclusion globs use ripgrep's native `!` prefix
 * (an exclude such as a bead-markdown glob), so callers express both in one ordered list.
 */
function normalizeGlobs(glob?: string | string[]): string[] {
  if (!glob) return []
  return Array.isArray(glob) ? glob.filter(Boolean) : [glob]
}

/**
 * Find text patterns using ripgrep
 *
 * @param pattern - Regex pattern to search for
 * @param glob - Optional file glob filter. Accepts a single glob ("*.md") or an ordered
 *               list of include/exclude globs (["**\/*.ts", "!@km/**\/*.md"]) — each maps to
 *               a repeated ripgrep `--glob`. `!`-prefixed entries are exclusions.
 * @param caseInsensitive - If true, pass `-i` to ripgrep for case-insensitive matching
 */
export function findPatterns(pattern: string, glob?: string | string[], caseInsensitive = false): Reference[] {
  // --hidden: ripgrep skips dot-directories by default, which silently drops
  // whole tracked trees like `.claude/` and `.agents/` (skills, tent scripts) from
  // any refactor. `.git/` is only excluded because it is hidden, so --hidden hands it
  // back — and a refactor must never propose edits to repository internals or to the
  // scratch worktrees tools keep in there. Exclude it explicitly, first, so a caller
  // who really means to search it can still say so with a later --glob.
  const args = ["--json", "--line-number", "--column", "--hidden", "--glob", "!.git/"]
  if (caseInsensitive) args.push("-i")
  args.push(pattern)
  for (const g of normalizeGlobs(glob)) {
    args.push("--glob", g)
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
 * @param glob - Optional file glob filter — a single glob or an ordered include/exclude list
 *               (see findPatterns); `!`-prefixed entries are exclusions.
 * @param caseInsensitive - If true, match any case and apply case-preservation to the replacement
 *                          (widget→gadget, Widget→Gadget, WIDGET→GADGET). If false (default),
 *                          match exactly and replace literally.
 */
export function createPatternReplaceProposal(
  pattern: string,
  replacement: string,
  glob?: string | string[],
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

/**
 * Everything needed to turn ripgrep's byte positions into character offsets for one file.
 *
 * ripgrep strips a leading UTF-8 BOM before searching, so all of its byte positions are
 * relative to the content *without* the BOM, while the decoded string still carries it.
 * Doing the arithmetic on the same text ripgrep saw — and adding the BOM character back
 * at the end — is what keeps line-1 matches from landing three bytes short.
 */
interface FileOffsets {
  content: string
  /** Byte offset of each line start, in the text ripgrep searched. */
  lineStarts: number[]
  toChar: (byteOffset: number) => number
  /** 1 when the file begins with a BOM that ripgrep did not count. */
  bomChars: number
}

function buildFileOffsets(content: string): FileOffsets {
  const bomChars = content.charCodeAt(0) === 0xfeff ? 1 : 0
  const searched = bomChars ? content.slice(1) : content

  const lineStarts: number[] = [0]
  let byteIndex = 0
  for (const line of searched.split("\n")) {
    byteIndex += Buffer.byteLength(line, "utf-8") + 1 // +1 for the newline
    lineStarts.push(byteIndex)
  }

  return { content, lineStarts, toChar: createByteToCharMapper(searched), bomChars }
}

function generateEdits(refs: Reference[], pattern: string, replacement: string, caseInsensitive: boolean): Edit[] {
  const edits: Edit[] = []
  const offsetsByFile = new Map<string, FileOffsets | null>()
  // The `g` flag is always set (we're processing file content, replacing all matches);
  // the `i` flag is only added if the caller asked for case-insensitive matching.
  const regex = new RegExp(pattern, caseInsensitive ? "gi" : "g")

  for (const ref of refs) {
    if (!ref.selected) continue

    let offsets = offsetsByFile.get(ref.file)
    if (offsets === undefined) {
      offsets = existsSync(ref.file) ? buildFileOffsets(readFileSync(ref.file, "utf-8")) : null
      offsetsByFile.set(ref.file, offsets)
    }
    if (offsets === null) continue

    // ripgrep reports a 0-indexed byte column within the line; ref.range stores it 1-indexed.
    const lineStart = offsets.lineStarts[ref.range[0] - 1]
    if (lineStart === undefined) {
      throw new Error(
        `${ref.file}: ripgrep reported a match on line ${ref.range[0]}, but the file has ` +
          `${offsets.lineStarts.length - 1} lines — it changed while being searched`,
      )
    }
    const startByte = lineStart + ref.range[1] - 1
    const endByte = startByte + (ref.range[3] - ref.range[1])

    // Throws rather than guessing when the byte positions don't describe this text.
    const charOffset = offsets.toChar(startByte) + offsets.bomChars
    const matchLength = offsets.toChar(endByte) + offsets.bomChars - charOffset

    const matchedText = offsets.content.slice(charOffset, charOffset + matchLength)
    // Case-insensitive matches apply case-preservation (widget→Widget→WIDGET);
    // case-sensitive matches use the replacement literally.
    const actualReplacement = caseInsensitive
      ? matchedText.replace(regex, (m) => caseMatch(m, replacement))
      : matchedText.replace(regex, replacement)

    if (actualReplacement === matchedText) {
      // ripgrep matched text that this pattern does not rewrite — a Rust/JS regex
      // difference (lookaround, unicode class, …). Emitting it would be a no-op edit
      // counted as applied, so say so instead of writing nothing quietly.
      console.error(
        `  ⚠ ${ref.file}:${ref.range[0]}: ripgrep matched ${JSON.stringify(matchedText)} but the ` +
          `JavaScript pattern /${pattern}/ produces no replacement for it — skipping this edit`,
      )
      continue
    }

    edits.push({
      file: ref.file,
      offset: charOffset,
      length: matchLength,
      replacement: actualReplacement,
      before: matchedText,
    })
  }

  // Sort by file then by offset descending
  return edits.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file)
    return b.offset - a.offset
  })
}
