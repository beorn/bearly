/**
 * Offsets in this tool are ALWAYS character offsets — JS string indices, the unit
 * `String.prototype.slice` uses. Search backends speak bytes (ripgrep columns,
 * ast-grep `byteOffset`); they convert at their own boundary via
 * `createByteToCharMapper` and never let a byte offset reach an `Edit`.
 */

/**
 * Convert a character offset to a 1-based line and column number.
 */
export function offsetToLineCol(content: string, offset: number): [number, number] {
  let line = 1
  let col = 1
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") {
      line++
      col = 1
    } else {
      col++
    }
  }
  return [line, col]
}

/**
 * Convert a 1-based line and column number back to a character offset.
 */
export function lineColToOffset(content: string, line: number, col: number): number {
  let currentLine = 1
  let offset = 0

  for (let i = 0; i < content.length; i++) {
    if (currentLine === line) {
      return offset + col - 1
    }
    if (content[i] === "\n") {
      currentLine++
    }
    offset++
  }

  return offset
}

/**
 * Get a trimmed preview of a specific line (1-based), capped at 80 chars.
 */
export function getLinePreview(content: string, line: number): string {
  const lines = content.split("\n")
  const lineContent = lines[line - 1] || ""
  return lineContent.trim().slice(0, 80)
}

/** UTF-8 byte length of a single code point (lone surrogates encode as U+FFFD: 3 bytes). */
function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1
  if (codePoint < 0x800) return 2
  if (codePoint < 0x10000) return 3
  return 4
}

/**
 * Build a byte-offset → character-offset mapper for one file's content.
 *
 * Search tools report positions in UTF-8 bytes; every edit this tool emits is in
 * characters. Build the mapping once per file — the obvious per-offset form
 * (`Buffer.from(content).subarray(0, n).toString().length`) re-encodes the whole
 * file for every match, which is quadratic on a large editset.
 *
 * The mapper throws rather than guessing. A byte offset past the end, or one that
 * lands inside a multi-byte sequence, means the producer is describing text that
 * isn't this text — there is no character offset that would be correct, and
 * returning a nearby one is how a replacement lands in the wrong place.
 */
export function createByteToCharMapper(content: string): (byteOffset: number) => number {
  // One entry per code point, plus a terminator: parallel byte/char boundaries.
  const byteStarts: number[] = []
  const charStarts: number[] = []

  let byteIndex = 0
  let charIndex = 0
  for (const codePoint of content) {
    byteStarts.push(byteIndex)
    charStarts.push(charIndex)
    byteIndex += utf8Length(codePoint.codePointAt(0)!)
    charIndex += codePoint.length // 2 for surrogate pairs
  }
  byteStarts.push(byteIndex)
  charStarts.push(charIndex)

  return (byteOffset: number): number => {
    if (byteOffset < 0 || byteOffset > byteIndex) {
      throw new Error(
        `byte offset ${byteOffset} is outside the file (${byteIndex} bytes) — ` +
          `the search result does not describe this content`,
      )
    }
    // Binary search for the exact boundary.
    let lo = 0
    let hi = byteStarts.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const value = byteStarts[mid]!
      if (value === byteOffset) return charStarts[mid]!
      if (value < byteOffset) lo = mid + 1
      else hi = mid - 1
    }
    throw new Error(
      `byte offset ${byteOffset} falls inside a multi-byte character — ` +
        `the search result does not describe this content`,
    )
  }
}
