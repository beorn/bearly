/**
 * Build context for a query: explicit text, file path, and FTS-snippet
 * lookup against session history. Returns a single string ready to be
 * prepended to the user prompt.
 */

import { emitJson } from "./output-mode"

// ---------------------------------------------------------------------------
// Session-history FTS — optional dependency on the recall engine, which moved
// to github.com/beorn/tribe (packages/recall) in June 2026. Hosts that have a
// tribe checkout point TRIBE_RECALL_ENGINE_DIR at its `src` directory (same
// seam the tribe daemon uses for overrides). Without it, --with-history
// degrades to no-history with a one-line note — never silently.
// ---------------------------------------------------------------------------

type RecallDbApi = {
  getDb: () => unknown
  closeDb: () => void
  ftsSearchWithSnippet: (
    db: unknown,
    topic: string,
    opts: { limit?: number },
  ) => { results: Array<{ type: string; snippet: string }> }
}

let recallDbProbe: Promise<RecallDbApi | null> | undefined

async function loadRecallDb(): Promise<RecallDbApi | null> {
  if (recallDbProbe !== undefined) return recallDbProbe
  recallDbProbe = (async () => {
    const dir = process.env.TRIBE_RECALL_ENGINE_DIR
    if (!dir) return null
    try {
      const mod = await import(`${dir}/history/db.ts`)
      return { getDb: mod.getDb, closeDb: mod.closeDb, ftsSearchWithSnippet: mod.ftsSearchWithSnippet } as RecallDbApi
    } catch (err) {
      console.error(
        `[llm] recall engine FAILED to load from TRIBE_RECALL_ENGINE_DIR=${dir}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return null
    }
  })()
  return recallDbProbe
}

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
    const recall = await loadRecallDb()
    if (!recall) {
      console.error(
        "📚 session-history context unavailable — recall engine moved to github.com/beorn/tribe; set TRIBE_RECALL_ENGINE_DIR to enable",
      )
    } else {
      try {
        const db = recall.getDb()
        try {
          const { results } = recall.ftsSearchWithSnippet(db, topic, { limit: 3 })
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
          recall.closeDb()
        }
      } catch {
        /* History not indexed */
      }
    }
  }
  return parts.length > 0 ? parts.join("\n\n---\n\n") : undefined
}
