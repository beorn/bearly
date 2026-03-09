/**
 * Convert a byte offset to a 1-based line and column number.
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
 * Convert a 1-based line and column number back to a byte offset.
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
