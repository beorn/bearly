/**
 * Shared terminal glossary — loads terms from terminfo.dev's glossary.json
 * and converts them to GlossaryEntity format with absolute URLs.
 *
 * This is the canonical source for terminal sequence terms (CSI, SGR, OSC,
 * CUP, ED, DECSTBM, etc.). Sites that use @bearly/vitepress-enrich can
 * compose this with their site-specific glossary instead of duplicating
 * terminal terms in every glossary.json.
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

const TERMINFO_HOST = "https://terminfo.dev"

/**
 * Load terminal glossary terms from terminfo.dev's content/glossary.json.
 *
 * @param glossaryPath - Path to terminfo.dev's glossary.json.
 *   Defaults to looking for it as a sibling submodule (vendor/terminfo.dev/content/glossary.json)
 *   or in node_modules.
 */
export function loadTerminalGlossary(glossaryPath?: string): GlossaryEntity[] {
  const candidates = glossaryPath
    ? [glossaryPath]
    : [
        // Sibling submodule in km monorepo
        join(dirname(import.meta.dirname ?? ""), "..", "..", "..", "terminfo.dev", "content", "glossary.json"),
        // npm installed
        join(dirname(import.meta.dirname ?? ""), "..", "..", "terminfo.dev", "content", "glossary.json"),
      ]

  for (const path of candidates) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<
        string,
        { expansion: string; description: string; link?: string }
      >

      const entities: GlossaryEntity[] = []
      for (const [term, entry] of Object.entries(raw)) {
        // Convert relative links to absolute terminfo.dev URLs
        const href = entry.link ? `${TERMINFO_HOST}${entry.link}` : undefined
        entities.push({
          term,
          href,
          tooltip: `${entry.expansion} — ${entry.description}`,
          external: true,
        })
      }
      return entities
    } catch {
      continue
    }
  }

  // Fallback: return empty if glossary not found (build still works, just no terminal terms)
  return []
}
