/**
 * Build-time content linkification — wraps known entity names in HTML links.
 * Used by VitePress route generators ([id].paths.ts) to linkify descriptions
 * before passing to Vue templates via v-html.
 *
 * Unlike the glossary markdown-it plugin (which processes markdown at parse time),
 * this works on plain strings at build time.
 */
import type { GlossaryEntity, CompiledEntity } from "./types.ts"
import { compileEntities } from "./entity-engine.ts"

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/**
 * Create a linkifier function from glossary entities.
 * Returns a function that replaces entity mentions in plain text/HTML strings.
 *
 * Usage:
 * ```typescript
 * import { createLinkifier } from "@bearly/vitepress-enrich/linkify"
 *
 * const linkify = createLinkifier([
 *   { term: "SelectList", href: "/api/select-list", tooltip: "Interactive list" },
 * ])
 *
 * const enriched = linkify("Use SelectList for keyboard navigation")
 * // → 'Use <a href="/api/select-list" class="hover-link" data-tooltip="Interactive list">SelectList</a> for keyboard navigation'
 * ```
 */
export function createLinkifier(entities: GlossaryEntity[]): (text: string) => string {
  const compiled = compileEntities(entities)

  return function linkifyContent(text: string): string {
    if (!text) return text

    // Identify text regions (outside HTML tags and <a>...</a> blocks)
    const textRegions: Array<{ start: number; end: number }> = []
    let i = 0
    while (i < text.length) {
      if (text[i] === "<") {
        const tagEnd = text.indexOf(">", i)
        if (tagEnd === -1) break
        const tag = text.slice(i, tagEnd + 1)
        if (tag.startsWith("<a ") || tag === "<a>") {
          const closeA = text.indexOf("</a>", tagEnd)
          i = closeA !== -1 ? closeA + 4 : tagEnd + 1
        } else {
          i = tagEnd + 1
        }
      } else {
        const nextTag = text.indexOf("<", i)
        const end = nextTag === -1 ? text.length : nextTag
        if (end > i) textRegions.push({ start: i, end })
        i = end
      }
    }

    // Collect all matches across text regions
    const matches: Array<{ start: number; end: number; entity: CompiledEntity }> = []
    const occupied = new Set<number>()

    for (const entity of compiled) {
      for (const region of textRegions) {
        const segment = text.slice(region.start, region.end)
        entity.pattern.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = entity.pattern.exec(segment)) !== null) {
          const absStart = region.start + m.index
          const absEnd = absStart + m[0].length
          let overlap = false
          for (let p = absStart; p < absEnd; p++) {
            if (occupied.has(p)) {
              overlap = true
              break
            }
          }
          if (overlap) continue
          for (let p = absStart; p < absEnd; p++) occupied.add(p)
          matches.push({ start: absStart, end: absEnd, entity })
        }
      }
    }

    // Apply in reverse order so offsets stay valid
    matches.sort((a, b) => b.start - a.start)
    let result = text
    for (const { start, end, entity } of matches) {
      const original = result.slice(start, end)
      const tooltip = entity.tooltip ? ` data-tooltip="${escapeAttr(entity.tooltip)}"` : ""
      const target = entity.external ? ' target="_blank" rel="noopener"' : ""
      const replacement = entity.href
        ? `<a href="${entity.href}" class="hover-link"${tooltip}${target}>${original}</a>`
        : `<span class="glossary-hint"${tooltip}>${original}</span>`
      result = result.slice(0, start) + replacement + result.slice(end)
    }

    return result
  }
}
