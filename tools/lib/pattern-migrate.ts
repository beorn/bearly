/**
 * pattern-migrate.ts - LLM-powered API migration
 *
 * Simple workflow:
 * 1. Search: Use ripgrep to find patterns
 * 2. Context: Gather matches with surrounding lines
 * 3. LLM: Send all matches in ONE call, let LLM figure out replacements
 * 4. Apply: Generate editset for review/apply
 */

import { spawnSync } from "child_process"
import { readFileSync, existsSync } from "fs"
import { createHash } from "crypto"
import type { Editset, Reference, Edit } from "./core/types"

export interface Match {
  file: string
  line: number
  text: string // The matching line
  context: string[] // Lines before/after for LLM understanding
}

export interface Replacement {
  index: number
  old: string
  new: string | null // null = skip
}

/**
 * Find all matches for patterns across files.
 * Uses ripgrep for speed.
 */
export function findPatterns(patterns: string[], glob: string): Match[] {
  const matches: Match[] = []
  const seen = new Set<string>() // Dedupe by file:line

  for (const pattern of patterns) {
    // Use ripgrep: fast, respects gitignore
    const result = spawnSync("rg", ["-n", "--json", pattern, "--glob", glob], {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    })

    if (result.error) {
      console.error(`Error running ripgrep: ${result.error.message}`)
      continue
    }

    const output = result.stdout || ""

    for (const line of output.split("\n").filter(Boolean)) {
      try {
        const data = JSON.parse(line) as {
          type: string
          data: {
            path: { text: string }
            line_number: number
            lines: { text: string }
          }
        }
        if (data.type !== "match") continue

        const file = data.data.path.text
        const lineNum = data.data.line_number
        const text = data.data.lines.text.trim()

        // Dedupe
        const key = `${file}:${lineNum}`
        if (seen.has(key)) continue
        seen.add(key)

        // Get context (3 lines before/after)
        const context = getContext(file, lineNum, 3)

        matches.push({ file, line: lineNum, text, context })
      } catch {
        // Skip malformed JSON lines
      }
    }
  }

  // Sort by file, then line
  matches.sort((a, b) => {
    const fileCmp = a.file.localeCompare(b.file)
    if (fileCmp !== 0) return fileCmp
    return a.line - b.line
  })

  return matches
}

/**
 * Get context lines around a match.
 */
function getContext(file: string, line: number, radius: number): string[] {
  if (!existsSync(file)) return []

  try {
    const content = readFileSync(file, "utf-8")
    const lines = content.split("\n")
    const start = Math.max(0, line - radius - 1)
    const end = Math.min(lines.length, line + radius)
    return lines.slice(start, end)
  } catch {
    // silent-fallback-allow: unreadable match file contributes no LLM context lines.
    return []
  }
}

/**
 * Format matches for LLM prompt.
 */
export function formatForLLM(matches: Match[]): string {
  return matches
    .map(
      (m, i) => `
## Match ${i}: ${m.file}:${m.line}

\`\`\`typescript
${m.context.join("\n")}
\`\`\`

Line to transform: \`${m.text}\`
`,
    )
    .join("\n---\n")
}

/**
 * Build the full LLM prompt for migration.
 */
export function buildMigrationPrompt(matches: Match[], userPrompt: string): string {
  const llmInput = formatForLLM(matches)

  return `${userPrompt}

For each match below, provide the replacement. Output ONLY a JSON array:
[{ "index": 0, "old": "original line", "new": "replacement line" }, ...]

Rules:
- "index" is the match number (0-indexed)
- "old" should match the original line exactly
- "new" is the full replacement line (not just the changed part)
- If a match should be skipped (no change needed), set "new": null
- Output ONLY the JSON array, no other text

${llmInput}`
}

/**
 * Parse LLM response into replacements.
 * Handles markdown code blocks and extracts JSON.
 */
export function parseReplacements(response: string): Replacement[] {
  // Try to extract JSON from markdown code block
  const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  const jsonStr = jsonMatch ? jsonMatch[1]! : response

  // Find the JSON array in the response
  const arrayMatch = jsonStr.match(/\[\s*\{[\s\S]*\}\s*\]/)
  if (!arrayMatch) {
    throw new Error("Could not find JSON array in LLM response")
  }

  return JSON.parse(arrayMatch[0]) as Replacement[]
}

/**
 * Create an editset from matches and replacements.
 */
export function createEditset(matches: Match[], replacements: Replacement[]): Editset {
  const refs: Reference[] = []
  const edits: Edit[] = []
  const fileChecksums = new Map<string, string>()

  // Build a map of replacements by index
  const replaceMap = new Map<number, Replacement>()
  for (const r of replacements) {
    replaceMap.set(r.index, r)
  }

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!
    const replacement = replaceMap.get(i)

    // Skip if no replacement or null
    if (!replacement || replacement.new === null) continue

    // Get or compute file checksum
    if (!fileChecksums.has(match.file)) {
      try {
        const content = readFileSync(match.file, "utf-8")
        const hash = createHash("sha256").update(content).digest("hex").slice(0, 12)
        fileChecksums.set(match.file, hash)
      } catch {
        fileChecksums.set(match.file, "unknown")
      }
    }

    const refId = createHash("sha256").update(`${match.file}:${match.line}:${match.text}`).digest("hex").slice(0, 8)

    refs.push({
      refId,
      file: match.file,
      range: [match.line, 1, match.line, match.text.length + 1],
      preview: match.text,
      checksum: fileChecksums.get(match.file)!,
      selected: true,
      line: match.line,
      kind: "call",
      replace: replacement.new,
    })

    // Create edit: find the line in the file and replace it
    try {
      const content = readFileSync(match.file, "utf-8")
      const lines = content.split("\n")
      const lineContent = lines[match.line - 1]

      if (lineContent !== undefined) {
        // Calculate character offset (JS string index) to this line.
        // Uses string .length which counts UTF-16 code units, matching
        // how apply.ts uses string.slice() to apply edits.
        let offset = 0
        for (let j = 0; j < match.line - 1; j++) {
          offset += lines[j]!.length + 1 // +1 for newline
        }

        // Preserve original indentation
        const indentMatch = lineContent.match(/^(\s*)/)
        const indent = indentMatch ? indentMatch[1]! : ""
        const finalReplacement = indent + replacement.new.trimStart()

        edits.push({
          file: match.file,
          offset,
          length: lineContent.length,
          replacement: finalReplacement,
          before: lineContent,
        })
      }
    } catch {
      // Skip files we can't read
    }
  }

  return {
    id: `pattern-migrate-${Date.now()}`,
    operation: "rename",
    from: "pattern",
    to: "migration",
    refs,
    edits,
    createdAt: new Date().toISOString(),
  }
}

/**
 * Group matches by file for summary output.
 */
export function summarizeMatches(matches: Match[]): Map<string, number> {
  const byFile = new Map<string, number>()
  for (const m of matches) {
    byFile.set(m.file, (byFile.get(m.file) || 0) + 1)
  }
  return byFile
}
