/**
 * Vault glossary — distinctive, file-backed vault terms that count as
 * salience anchors even when they don't match the regex shapes in
 * prompt-filter.ts.
 *
 * Built lazily from `.km/state.db` on first use. Strict whitelist: only
 * pulls names from positions where being "named" implies project vocab,
 * not arbitrary `name` fields. Specifically:
 *
 *  - top-level directory names under vendor/, apps/, packages/, hub/,
 *    .claude/skills/ (e.g. "termless", "silvercode", "km-tui")
 *  - npm scope names like @silvery, @bearly, @flexily, @termless
 *  - per-vault bead scope segments from canonical bead paths
 *    (`@km/<scope>/<slug>` → both <scope> and <slug>)
 *
 * Plus a small explicit alias list for camelCase code-symbol terms that
 * never surface as path basenames (testEnv, createTestApp, etc).
 *
 * Anti-goal: this list is NOT a full project lexicon. Common words that
 * happen to be node names ("test", "check", "slow", "migration") must
 * NOT end up in here — that turns the salience override into a no-op.
 * Past 200 entries is a smell; past 500 means we're indexing noise.
 */

import { getVaultDb } from "./vault-fts.ts"

let glossarySet: Set<string> | null = null
let buildAttempted = false

const EXPLICIT_ALIASES: ReadonlyArray<string> = [
  // camelCase code-symbol terms
  "testenv",
  "createtestapp",
  // Frequently-named files
  "claude.md",
  "agents.md",
  "readme.md",
]

/**
 * 3-char project terms that are too short to pass the default token-length
 * gate but ARE distinctive in this codebase. Allowed at the lookup site
 * only — never auto-discovered. Each entry must be a project-specific
 * abbreviation that almost never appears as common English; "max", "big",
 * "why", "sop", "pro" are deliberately EXCLUDED because they clash with
 * conversational English ("max value", "big deal", "why...?", "I'm a pro
 * at this").
 */
const SHORT_EXPLICIT_ALIASES: ReadonlySet<string> = new Set([
  "tdd", // .claude/skills/tdd/SKILL.md — test-driven dev
  "csw", // .claude/skills/csw/SKILL.md — complete staff work
])

/**
 * Top-level directories whose immediate children are project-vocab terms.
 * "vendor/termless/..." → "termless". "apps/km-tui/..." → "km-tui".
 *
 * `.claude/skills/` is intentionally EXCLUDED. Skill invocation goes
 * through slash-command syntax (`/pro`, `/max`) which the slash-filter
 * already routes; bare mentions of skill names are almost always
 * conversational English ("Claude", "code", "open", "why", "pro", "max",
 * "big", "deep", "fresh", "complete", "discuss", "docs", "tests",
 * "tui", "sync", "release", "recall"). Auto-adding 50+ skill dir
 * names to the glossary would let conversational prompts trigger
 * retrieval — exactly the false_emit pattern we worked to eliminate.
 */
const PROJECT_DIRS: ReadonlyArray<string> = [
  "vendor/",
  "apps/",
  "packages/",
  "hub/",
]

function buildGlossary(): Set<string> | null {
  if (glossarySet) return glossarySet
  if (buildAttempted) return null
  buildAttempted = true

  const db = getVaultDb()
  if (!db) return null

  const out = new Set<string>(EXPLICIT_ALIASES.map((s) => s.toLowerCase()))

  try {
    const pathRows = db
      .prepare(
        `SELECT DISTINCT fs_path FROM nodes WHERE fs_path IS NOT NULL`,
      )
      .all() as Array<{ fs_path: string }>

    for (const { fs_path } of pathRows) {
      // Direct file basenames (strict — only when the file looks like a
      // dotfile-or-readme variant; full lowercase basenames are too noisy
      // to whitelist wholesale).
      const lastSlash = fs_path.lastIndexOf("/")
      const basename = lastSlash >= 0 ? fs_path.slice(lastSlash + 1) : fs_path
      const lower = basename.toLowerCase()
      if (
        lower === "claude.md" ||
        lower === "agents.md" ||
        lower === "readme.md" ||
        lower === "package.json" ||
        lower === "tsconfig.json"
      ) {
        // Add the full filename only — NOT the stem. "claude" / "agents"
        // / "readme" / "package" / "tsconfig" are too common as bare
        // English words to use as salience anchors. The dotted form
        // ("CLAUDE.md") is itself the distinctive marker.
        out.add(lower)
      }

      // Project-dir children: vendor/<NAME>/..., apps/<NAME>/...
      for (const prefix of PROJECT_DIRS) {
        if (!fs_path.startsWith(prefix)) continue
        const rest = fs_path.slice(prefix.length)
        const slash = rest.indexOf("/")
        const name = slash >= 0 ? rest.slice(0, slash) : rest
        if (name.length >= 3 && /^[a-z][a-z0-9-]*$/.test(name)) {
          out.add(name)
        }
        break
      }
    }

    // Bead canonical-form scopes from sigil-prefixed paths.
    // `@km/<scope>/<slug>` → add only <scope> when the scope is a
    // distinctive project area (km-tui, km-storage, km-beads, ...). Slugs
    // are too varied and almost always contain common English words —
    // including them would let "migration" / "testing" / "performance"
    // through as anchors.
    const beadRows = db
      .prepare(
        `SELECT DISTINCT fs_path FROM nodes
         WHERE fs_path LIKE '@%/%'`,
      )
      .all() as Array<{ fs_path: string }>

    for (const { fs_path } of beadRows) {
      const parts = fs_path.replace(/\.md$/, "").split("/")
      // parts[0] = "@km", parts[1] = scope. Only the scope.
      const scope = parts[1]
      if (scope && scope.length >= 4 && /^[a-z][a-z0-9-]*$/.test(scope)) {
        out.add(scope)
      }
    }

    glossarySet = out
    return out
  } catch {
    return null
  }
}

/**
 * Tokenize a prompt and return the first matching glossary term, or null.
 *
 * Tokens are lowercased; tokens shorter than 4 chars are ignored to
 * suppress common-word matches.
 */
export function findGlossaryAnchor(prompt: string): string | null {
  const glossary = buildGlossary()
  if (!glossary || glossary.size === 0) return null

  const tokens = prompt.split(/[^A-Za-z0-9.]+/)
  for (const t of tokens) {
    if (t.length < 3) continue
    const lower = t.toLowerCase()
    // 3-char tokens only match against the explicit short-alias set
    // (skill names like "pro", "tdd"). Auto-discovered glossary entries
    // require length 4+ to suppress common-word matches.
    if (t.length === 3) {
      if (SHORT_EXPLICIT_ALIASES.has(lower)) return lower
      continue
    }
    if (glossary.has(lower)) return lower
    const stripped = lower.replace(/[?!.,;:]+$/, "")
    if (stripped !== lower && stripped.length >= 4 && glossary.has(stripped)) return stripped
  }
  return null
}

export function glossarySize(): number {
  const g = buildGlossary()
  return g?.size ?? 0
}
