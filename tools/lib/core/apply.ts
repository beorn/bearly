import { readFileSync, writeFileSync, existsSync } from "fs"
import { createHash } from "crypto"
import type { Editset, ApplyOutput, Edit } from "./types"

/** Cap the quoted text in a mismatch message so one bad edit can't print a whole file. */
function quote(text: string, limit = 60): string {
  return JSON.stringify(text.length > limit ? `${text.slice(0, limit)}…` : text)
}

/**
 * Check every edit against the text it claims to replace.
 *
 * This is the whole safety story. An editset is a set of positions into a file the
 * producer read earlier; nothing else downstream knows whether those positions still —
 * or ever did — point at the matched text. Offsets in the wrong unit, a file edited
 * since the proposal, a backend that miscounted a multi-byte line: every one of them
 * shows up here as "the text at this offset is not what you said you matched".
 *
 * Returns one message per bad edit. Empty means every edit is safe to write.
 */
export function verifyEdits(content: string, edits: Edit[]): string[] {
  const problems: string[] = []

  for (const edit of edits) {
    if (edit.before === undefined) {
      problems.push(
        `${edit.file}: edit at offset ${edit.offset} has no 'before' text, so it cannot be checked — ` +
          `regenerate the editset with a current version of this tool`,
      )
      continue
    }
    if (edit.offset < 0 || edit.offset + edit.length > content.length) {
      problems.push(
        `${edit.file}: segment mismatch at offset ${edit.offset} (+${edit.length}) — ` +
          `runs past the end of the file (${content.length} characters)`,
      )
      continue
    }
    const actual = content.slice(edit.offset, edit.offset + edit.length)
    if (actual !== edit.before) {
      problems.push(
        `${edit.file}: segment mismatch at offset ${edit.offset} (+${edit.length}) — ` +
          `expected ${quote(edit.before)}, found ${quote(actual)}`,
      )
    }
  }

  return problems
}

/**
 * Apply verified edits to content, right to left so earlier edits don't shift later ones.
 * Throws unless every edit still matches the text it recorded — a mismatch is never
 * something to write through.
 */
export function applyEditsToContent(content: string, edits: Edit[]): string {
  const problems = verifyEdits(content, edits)
  if (problems.length > 0) {
    throw new Error(
      `Refusing to apply ${problems.length} edit(s) that do not match the file:\n  ${problems.join("\n  ")}\n` +
        `Nothing was written. Regenerate the editset against the current files.`,
    )
  }

  let result = content
  for (const edit of [...edits].sort((a, b) => b.offset - a.offset)) {
    result = result.slice(0, edit.offset) + edit.replacement + result.slice(edit.offset + edit.length)
  }
  return result
}

/**
 * Compute SHA256 checksum of content (first 12 chars)
 */
export function computeChecksum(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12)
}

/**
 * Compute stable reference ID from location
 */
export function computeRefId(
  file: string,
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
): string {
  const input = `${file}:${startLine}:${startCol}:${endLine}:${endCol}`
  return createHash("sha256").update(input).digest("hex").slice(0, 8)
}

/**
 * Apply an editset.
 *
 * Two different guards, because they answer to two different situations:
 *   - A file whose checksum no longer matches the proposal has been edited since —
 *     expected during a long session. Those files are skipped and reported as drift.
 *   - A file whose checksum matches but whose text at an edit's offset is not what
 *     the edit recorded means the editset itself is wrong. That is a bug, never a
 *     data condition, so it throws and nothing is written.
 *
 * A dry run performs both checks and writes nothing, so `--dry-run` is a real preflight.
 */
export function applyEditset(editset: Editset, dryRun = false): ApplyOutput {
  const result: ApplyOutput = {
    applied: 0,
    skipped: 0,
    driftDetected: [],
  }

  // Group edits by file
  const editsByFile = new Map<string, Edit[]>()
  for (const edit of editset.edits) {
    if (!editsByFile.has(edit.file)) {
      editsByFile.set(edit.file, [])
    }
    editsByFile.get(edit.file)!.push(edit)
  }

  // Get selected refs for checksum verification
  const selectedRefs = editset.refs.filter((ref) => ref.selected)
  const refsByFile = new Map<string, (typeof selectedRefs)[0][]>()
  for (const ref of selectedRefs) {
    if (!refsByFile.has(ref.file)) {
      refsByFile.set(ref.file, [])
    }
    refsByFile.get(ref.file)!.push(ref)
  }

  // Process each file
  for (const [filePath, fileEdits] of editsByFile) {
    // Check if file exists
    if (!existsSync(filePath)) {
      result.driftDetected.push({
        file: filePath,
        reason: "File not found",
      })
      result.skipped += fileEdits.length
      continue
    }

    // Read current content
    const currentContent = readFileSync(filePath, "utf-8")
    const currentChecksum = computeChecksum(currentContent)

    // Verify checksum if we have refs for this file
    const refs = refsByFile.get(filePath) || []
    if (refs.length > 0) {
      const expectedChecksum = refs[0]!.checksum
      if (currentChecksum !== expectedChecksum) {
        result.driftDetected.push({
          file: filePath,
          reason: `Checksum mismatch: expected ${expectedChecksum}, got ${currentChecksum}`,
        })
        result.skipped += fileEdits.length
        continue
      }
    }

    // Throws if any edit doesn't match the text it recorded — before anything is written.
    const newContent = applyEditsToContent(currentContent, fileEdits)
    result.applied += fileEdits.length

    // Write file (unless dry run)
    if (!dryRun) {
      writeFileSync(filePath, newContent)
    }
  }

  return result
}

/**
 * Verify an editset can be applied: files exist, checksums still match, and every
 * edit still points at the text it recorded. Same segment check the applier runs,
 * reported instead of thrown so `editset.verify` can list everything at once.
 */
export function verifyEditset(editset: Editset): {
  valid: boolean
  issues: string[]
  warnings: string[]
} {
  const issues: string[] = []
  const warnings: string[] = []

  // Check all files exist and checksums match
  const checkedFiles = new Set<string>()

  for (const ref of editset.refs) {
    if (checkedFiles.has(ref.file)) continue
    checkedFiles.add(ref.file)

    if (!existsSync(ref.file)) {
      issues.push(`File not found: ${ref.file}`)
      continue
    }

    const content = readFileSync(ref.file, "utf-8")
    const checksum = computeChecksum(content)

    if (checksum !== ref.checksum) {
      issues.push(`Checksum mismatch for ${ref.file}: expected ${ref.checksum}, got ${checksum}`)
    }
  }

  // Every edit must still select the text it recorded.
  const fileContents = new Map<string, string>()
  const editsByFile = new Map<string, Edit[]>()
  for (const edit of editset.edits) {
    let content = fileContents.get(edit.file)
    if (content === undefined) {
      if (!existsSync(edit.file)) continue
      content = readFileSync(edit.file, "utf-8")
      fileContents.set(edit.file, content)
    }
    if (!editsByFile.has(edit.file)) editsByFile.set(edit.file, [])
    editsByFile.get(edit.file)!.push(edit)
  }

  for (const [file, fileEdits] of editsByFile) {
    issues.push(...verifyEdits(fileContents.get(file)!, fileEdits))
  }

  return {
    valid: issues.length === 0,
    issues,
    warnings,
  }
}
