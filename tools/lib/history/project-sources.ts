/**
 * project-sources.ts - Project source indexing (beads, memory, docs, CLAUDE.md scanning)
 */

import { getDb } from "./db.ts"
import { indexProjectSources } from "./indexer.ts"
import { log } from "./recall-shared.ts"

/**
 * Ensure project sources are indexed before searching.
 * Called from hookRecall when CLAUDE_PROJECT_DIR is set.
 * Uses mtime checks — fast (few ms) when nothing changed.
 */
export function ensureProjectSourcesIndexed(): void {
  const projectRoot = process.env.CLAUDE_PROJECT_DIR
  if (!projectRoot) return

  try {
    const db = getDb()
    const startTime = Date.now()
    const result = indexProjectSources(db, projectRoot)
    const total =
      result.beads + result.sessionMemory + result.projectMemory + result.docs + result.claudeMd + result.research
    if (total > 0) {
      log(
        `indexed ${total} project sources (${Date.now() - startTime}ms): beads=${result.beads} memory=${result.sessionMemory} project=${result.projectMemory} docs=${result.docs} claude=${result.claudeMd} research=${result.research}`,
      )
    }
    // Don't close db here — recall() will use it and close when done
  } catch (e) {
    log(`project source indexing failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}
