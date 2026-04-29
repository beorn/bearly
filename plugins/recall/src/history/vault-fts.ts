/**
 * Vault FTS adapter — searches the km tree db (`.km/state.db`).
 *
 * The recall search ground truth has been the Claude Code session
 * transcript index — but the highest-signal targets in this project live in
 * the vault (beads, design docs, CLAUDE.md, README.md, hub/* docs). Those
 * are indexed by km in `nodes_fts` keyed on `(name, title, content)`.
 *
 * Adapter is opt-in: when `KM_VAULT_DB` is set, or when `.km/state.db` is
 * found by walking up from CWD, the recall pipeline merges vault matches
 * into its result list. Vault matches get a typed pointer (path + title +
 * snippet) so the inject path can render a high-signal hint instead of
 * lexical noise from message FTS.
 */

import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { toFts5Query } from "./db-queries.ts"

let cachedDb: Database | null = null
let cachedPath: string | null = null
let resolveAttempted = false

function findVaultDb(): string | null {
  const fromEnv = process.env.KM_VAULT_DB
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  let dir = process.cwd()
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, ".km/state.db")
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export function getVaultDb(): Database | null {
  if (cachedDb) return cachedDb
  if (resolveAttempted) return null
  resolveAttempted = true

  const path = findVaultDb()
  if (!path) return null

  try {
    const db = new Database(path, { readonly: true })
    db.exec("PRAGMA query_only = ON")
    cachedDb = db
    cachedPath = path
    return db
  } catch {
    return null
  }
}

export function getVaultDbPath(): string | null {
  if (!resolveAttempted) getVaultDb()
  return cachedPath
}

export interface VaultMatch {
  id: string
  fsPath: string | null
  name: string | null
  title: string | null
  snippet: string
  rank: number
}

// Common English / chat stopwords — words too generic to be salient
// project-vocab anchors. Kept conservative; project-specific terms (e.g.
// "test", "bead", "fix", "make") are NOT in this list since they're
// genuine signal in this codebase.
const PROBE_STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can",
  "had", "was", "were", "this", "that", "with", "have", "from", "they",
  "what", "when", "where", "which", "while", "their", "there", "these",
  "those", "would", "could", "should", "about", "after", "again",
  "before", "being", "between", "during", "into", "just", "like",
  "more", "much", "only", "other", "over", "such", "than", "then",
  "things", "think", "very", "well", "your", "yours", "really", "still",
  "some", "also", "perhaps", "kind", "name", "now", "here", "much",
  "going", "doing", "done", "does", "did", "do", "is", "it", "of",
  "to", "in", "on", "at", "as", "be", "we", "i", "a", "an", "or",
  "if", "so", "yes", "no", "ok",
])

/**
 * Extract the salient tokens from a prompt for vault-probe purposes.
 *
 * The full-prompt FTS query AND-joins every word — a rare project term
 * like "termless" gets diluted by the dozens of common words around it.
 * For the salience probe we want OR-of-rare-tokens: any rare token that
 * resolves against the vault is itself signal.
 *
 * Returns up to `max` candidate tokens. Empty when nothing rare survives.
 */
export function extractProbeTokens(prompt: string, max = 6): string[] {
  const out = new Set<string>()
  // Split on non-word chars but keep camelCase intact via the / / lowercase
  // pass below; tokens like "createTestApp" survive as one chunk.
  const raw = prompt.split(/[^A-Za-z0-9_-]+/)
  for (const t of raw) {
    if (t.length < 4) continue
    const lower = t.toLowerCase()
    if (PROBE_STOPWORDS.has(lower)) continue
    if (/^\d+$/.test(t)) continue
    out.add(lower)
    if (out.size >= max) break
  }
  return [...out]
}

/**
 * FTS search over the vault. Returns matches biased toward titled,
 * file-backed content (beads, docs) over body-only nodes.
 *
 * Rank shape mirrors the existing message FTS — bm25 negative numbers,
 * smaller is better. We boost titled+pathed results so a bead beats a
 * random list-item that happens to share a token.
 *
 * `mode` controls how the prompt is converted to an FTS query:
 *  - `"phrase"` (default): existing behavior — AND-join every token via
 *    toFts5Query. Best when the prompt is a tight question.
 *  - `"any-of-anchors"`: OR-join the rare tokens (extractProbeTokens).
 *    Best for salience probing — finds rare project vocab buried inside
 *    long sentences.
 */
export function searchVault(
  query: string,
  limit: number,
  mode: "phrase" | "any-of-anchors" = "phrase",
): VaultMatch[] {
  const db = getVaultDb()
  if (!db) return []

  let ftsQuery: string
  if (mode === "any-of-anchors") {
    const tokens = extractProbeTokens(query)
    if (tokens.length === 0) return []
    // Restrict to the `name` and `title` columns — body matches dilute
    // every prompt to a "fires" verdict. Anchor-only matching catches
    // prompts that name a real bead/path/alias and rejects prompts that
    // merely happen to share a body token with the vault.
    ftsQuery = `{name title} : (${tokens.map((t) => `${t}*`).join(" OR ")})`
  } else {
    ftsQuery = toFts5Query(query)
  }
  if (!ftsQuery) return []

  try {
    const rows = db
      .prepare(
        `SELECT n.id,
                n.fs_path,
                n.name,
                n.title,
                snippet(nodes_fts, 3, '«', '»', '…', 24) AS snippet,
                bm25(nodes_fts, 8.0, 4.0, 1.0) AS rank
           FROM nodes_fts
           JOIN nodes n ON nodes_fts.id = n.id
          WHERE nodes_fts MATCH ?
            AND (n.fs_path IS NOT NULL OR n.title IS NOT NULL)
          ORDER BY rank
          LIMIT ?`,
      )
      .all(ftsQuery, limit * 2) as Array<{
      id: string
      fs_path: string | null
      name: string | null
      title: string | null
      snippet: string
      rank: number
    }>

    const out: VaultMatch[] = []
    for (const r of rows) {
      // Boost titled+pathed (beads/docs) above body-only nodes.
      const titleBoost = r.title ? 1.4 : 1.0
      const pathBoost = r.fs_path ? 1.2 : 1.0
      out.push({
        id: r.id,
        fsPath: r.fs_path,
        name: r.name,
        title: r.title,
        snippet: r.snippet,
        rank: r.rank * titleBoost * pathBoost,
      })
      if (out.length >= limit) break
    }
    return out
  } catch {
    return []
  }
}
