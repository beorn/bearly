/**
 * Shared terminal glossary — loads terms from terminfo.dev's glossary
 * and converts them to GlossaryEntity format with absolute URLs.
 *
 * Terms are bundled into the npm package (terminal-glossary-data.json)
 * so they work without the terminfo.dev submodule. In the km monorepo,
 * the live version is preferred if available.
 *
 * Usage:
 * ```typescript
 * import { loadTerminalGlossary } from "@bearly/vitepress-enrich/terminal-glossary"
 * import siteGlossary from "../content/glossary.json"
 *
 * const glossary = [...siteGlossary, ...loadTerminalGlossary()]
 * md.use(glossaryPlugin, { entities: glossary })
 * ```
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import type { GlossaryEntity } from "./types.ts"
// Direct import as fallback — works in all bundler contexts (Rollup, Vite, Bun, Node)
// where import.meta.dirname may be undefined (e.g., vitepress SSR build via Rollup)
import bundledData from "./terminal-glossary-data.json"

const TERMINFO_HOST = "https://terminfo.dev"

function parseGlossary(
  raw: Record<string, { expansion: string; description: string; link?: string }>,
): GlossaryEntity[] {
  const entities: GlossaryEntity[] = []
  for (const [term, entry] of Object.entries(raw)) {
    const href = entry.link ? `${TERMINFO_HOST}${entry.link}` : undefined
    entities.push({
      term,
      href,
      tooltip: `${entry.expansion} — ${entry.description}`,
      external: true,
    })
  }
  return entities
}

/**
 * Load terminal glossary terms. Tries live terminfo.dev submodule first,
 * falls back to bundled snapshot via direct import.
 */
export function loadTerminalGlossary(glossaryPath?: string): GlossaryEntity[] {
  // Try explicit path first
  if (glossaryPath) {
    try {
      const raw = JSON.parse(readFileSync(glossaryPath, "utf-8")) as Record<
        string,
        { expansion: string; description: string; link?: string }
      >
      return parseGlossary(raw)
    } catch {
      // fall through to other candidates
    }
  }

  // Try live terminfo.dev submodule (km monorepo only)
  if (import.meta.dirname) {
    const submodulePath = join(
      dirname(import.meta.dirname),
      "..",
      "..",
      "..",
      "terminfo.dev",
      "content",
      "glossary.json",
    )
    try {
      const raw = JSON.parse(readFileSync(submodulePath, "utf-8")) as Record<
        string,
        { expansion: string; description: string; link?: string }
      >
      return parseGlossary(raw)
    } catch {
      // fall through to bundled
    }
  }

  // Bundled snapshot via direct import — always works regardless of
  // import.meta.dirname, Rollup, Vite SSR, or any other bundler context
  return parseGlossary(
    bundledData as unknown as Record<string, { expansion: string; description: string; link?: string }>,
  )
}
