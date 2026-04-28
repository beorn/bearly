/**
 * Build context for a query: explicit text, file path, and FTS-snippet
 * lookup against session history. Returns a single string ready to be
 * prepended to the user prompt.
 */

import { getDb, closeDb, ftsSearchWithSnippet } from "../../../recall/src/history/db"
import { emitJson } from "./output-mode"

/** Build context from explicit text, file(s), and session history.
 *
 * Multiple files concatenate in argv order (each separated by the same
 * `\n\n---\n\n` divider used between context, files, and history). Single
 * `contextFile` is supported for legacy callers; `contextFiles` is preferred.
 * Earlier the CLI accepted multiple `--context-file` flags but `getArg`
 * returned only the first occurrence, silently dropping the rest — caused a
 * 19-minute stalled rewrite call on 2026-04-28 before the bug was caught.
 */
export async function buildContext(
  topic: string,
  options: {
    contextArg?: string
    contextFile?: string
    contextFiles?: string[]
    withHistory: boolean
  },
): Promise<string | undefined> {
  const parts: string[] = []
  if (options.contextArg) parts.push(options.contextArg)
  const files = [...(options.contextFile ? [options.contextFile] : []), ...(options.contextFiles ?? [])]
  for (const file of files) {
    try {
      parts.push(await Bun.file(file).text())
    } catch {
      emitJson({ error: `Failed to read context file: ${file}`, status: "failed" })
      process.exit(1)
    }
  }
  if (options.withHistory) {
    try {
      const db = getDb()
      try {
        const { results } = ftsSearchWithSnippet(db, topic, { limit: 3 })
        if (results.length > 0) {
          console.error("📚 Including context from session history...\n")
          parts.push(
            "Relevant context from previous sessions:\n\n" +
              results
                .map((r) => {
                  const role = r.type === "user" ? "User" : "Assistant"
                  return `[${role}]: ${r.snippet.replace(/>>>/g, "").replace(/<<</g, "")}`
                })
                .join("\n\n"),
          )
        }
      } finally {
        // try/finally ensures closeDb() runs even if the FTS query throws —
        // previously the catch path leaked the SQLite handle. Same pattern
        // as cli.ts history lookup.
        closeDb()
      }
    } catch {
      /* History not indexed */
    }
  }
  return parts.length > 0 ? parts.join("\n\n---\n\n") : undefined
}
