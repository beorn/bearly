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
 * falls back to bundled snapshot.
 */
export function loadTerminalGlossary(glossaryPath?: string): GlossaryEntity[] {
  // Try explicit path or live submodule first
  const candidates = glossaryPath
    ? [glossaryPath]
    : [
        // Sibling submodule in km monorepo
        join(dirname(import.meta.dirname ?? ""), "..", "..", "..", "terminfo.dev", "content", "glossary.json"),
      ]

  for (const path of candidates) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, { expansion: string; description: string; link?: string }>
      return parseGlossary(raw)
    } catch {
      continue
    }
  }

  // Fallback: bundled snapshot (works in standalone CI / npm installs)
  try {
    const bundledPath = join(dirname(import.meta.dirname ?? ""), "terminal-glossary-data.json")
    const raw = JSON.parse(readFileSync(bundledPath, "utf-8")) as Record<string, { expansion: string; description: string; link?: string }>
    return parseGlossary(raw)
  } catch {
    return []
  }
}
