/**
 * retrieve_memory — fetch full content for a pointer injected via
 * `wrapInjectedContext({ mode: "pointer" })`.
 *
 * Pointer-mode injection shows only title + path + date + tags +
 * 1-line summary — no body prose. The model is told to call
 * `retrieve_memory(id)` if it needs the full content to answer the
 * user's actual typed request.
 *
 * This module is the source-agnostic dispatcher: given an `id`, it
 * tries each registered fetcher in turn. Fetchers are registered via
 * `registerRetrieveSource()`; the qmd fetcher is built in. Callers
 * (e.g. the MCP tool handler or a direct CLI) should treat a null
 * result as "not found" and surface it to the model as a tool_result.
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"

import { sanitize } from "./sanitize.ts"

export interface RetrievedMemory {
  /** The id that was passed in, echoed back for audit. */
  id: string
  /** Registered source that successfully resolved the id. */
  source: string
  /** Full content (sanitized — tag-escapes stripped, but body preserved). */
  content: string
  /** Path on disk (if applicable). */
  path?: string
  /** ISO date (if parseable from the content). */
  date?: string
  /** Optional title for display. */
  title?: string
}

export type RetrieveFetcher = (id: string) => Promise<RetrievedMemory | null>

const fetchers: RetrieveFetcher[] = []

/**
 * Register a new fetcher. Fetchers are tried in registration order;
 * the first one to return a non-null result wins. Unknown ids fall
 * through to the next fetcher.
 */
export function registerRetrieveSource(fetcher: RetrieveFetcher): void {
  fetchers.push(fetcher)
}

/**
 * Try every registered fetcher until one resolves the id. Returns null
 * if no fetcher knows how to handle it.
 *
 * Body content is passed through `sanitize()` with a generous limit
 * (64KB). The goal is structural hygiene — strip tag-escape attempts
 * but keep the content the model asked for.
 */
export async function retrieveMemory(id: string): Promise<RetrievedMemory | null> {
  for (const f of fetchers) {
    try {
      const m = await f(id)
      if (m) {
        return { ...m, content: sanitize(m.content, 64 * 1024) }
      }
    } catch {
      // Fall through to next fetcher
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Built-in: qmd fetcher
// ---------------------------------------------------------------------------

/**
 * qmd-backed fetcher: if the id looks like a filesystem path (absolute
 * path OR contains a slash AND ends in a known markdown ext), read it
 * directly. Otherwise try `qmd get <id>`.
 *
 * Registered by default so the qmd-based accountly recall path works
 * out of the box.
 */
export const qmdFetcher: RetrieveFetcher = async (id: string) => {
  // Direct file path
  if (id.startsWith("/") && existsSync(id)) {
    try {
      const content = readFileSync(id, "utf8")
      return { id, source: "qmd", content, path: id }
    } catch {
      return null
    }
  }
  // qmd get <id>
  const res = spawnSync("qmd", ["get", id], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 3000,
  })
  if (res.status !== 0 || !res.stdout) return null
  return { id, source: "qmd", content: res.stdout }
}

// Auto-register unless explicitly disabled (tests use this).
if (process.env.INJECTION_ENVELOPE_NO_AUTOREGISTER !== "1") {
  registerRetrieveSource(qmdFetcher)
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/** Clear all registered fetchers. Used by tests to isolate. */
export function resetRetrieveFetchers(): void {
  fetchers.length = 0
}

/** Inspect the current fetcher count. Used by tests. */
export function retrieveFetcherCount(): number {
  return fetchers.length
}
