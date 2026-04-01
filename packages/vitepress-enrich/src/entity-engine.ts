/**
 * Core entity replacement engine — longest-match-first, first-occurrence-only,
 * HTML-aware text replacement. Used by both the markdown-it plugin and the
 * build-time linkifier.
 *
 * Extracted from terminfo.dev's glossary-links.ts and linkify-content.ts.
 */
import type { GlossaryEntity, CompiledEntity } from "./types.ts"

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Compile raw glossary entities into regex-ready compiled entities. */
export function compileEntities(entities: GlossaryEntity[]): CompiledEntity[] {
  const compiled: CompiledEntity[] = []
  const seen = new Set<string>()

  for (const e of entities) {
    if (seen.has(e.term)) continue
    seen.add(e.term)
    compiled.push({
      term: e.term,
      pattern: new RegExp(`\\b${escapeRegex(e.term)}\\b`, "g"),
      href: e.href ?? "",
      tooltip: e.tooltip ?? "",
      tooltipOnly: !e.href,
      external: e.external ?? false,
    })
  }

  // Sort longest term first so "Kitty keyboard protocol" matches before "Kitty"
  compiled.sort((a, b) => b.term.length - a.term.length)
  return compiled
}

/** Render an entity match as an HTML string. */
function renderEntity(original: string, entity: CompiledEntity): string {
  const tooltip = entity.tooltip ? ` data-tooltip="${escapeAttr(entity.tooltip)}"` : ""
  if (entity.href) {
    const target = entity.external ? ' target="_blank" rel="noopener"' : ""
    return `<a href="${entity.href}" class="hover-link"${tooltip}${target}>${original}</a>`
  }
  return `<span class="glossary-hint"${tooltip}>${original}</span>`
}

/**
 * Replace entity mentions in a text string with HTML tags.
 * Entities are processed longest-first; positions already matched are skipped.
 * If `linkedTerms` is provided, only the first occurrence of each term is linked.
 */
export function replaceEntities(text: string, entities: CompiledEntity[], linkedTerms?: Set<string>): string {
  const matches: Array<{ start: number; end: number; entity: CompiledEntity }> = []
  const occupied = new Set<number>()

  for (const entity of entities) {
    if (linkedTerms?.has(entity.term)) continue
    entity.pattern.lastIndex = 0
    let m: RegExpExecArray | null
    let matched = false
    while ((m = entity.pattern.exec(text)) !== null) {
      const start = m.index
      const end = start + m[0].length
      let overlap = false
      for (let p = start; p < end; p++) {
        if (occupied.has(p)) {
          overlap = true
          break
        }
      }
      if (overlap) continue
      if (matched) continue
      matched = true
      for (let p = start; p < end; p++) occupied.add(p)
      matches.push({ start, end, entity })
    }
  }

  if (matches.length === 0) return text

  if (linkedTerms) {
    for (const { entity } of matches) linkedTerms.add(entity.term)
  }

  matches.sort((a, b) => b.start - a.start)
  let result = text
  for (const { start, end, entity } of matches) {
    result = result.slice(0, start) + renderEntity(result.slice(start, end), entity) + result.slice(end)
  }
  return result
}

/**
 * Replace entity mentions in raw HTML content.
 * Skips text inside tags, <a>, <code>, <h1>–<h6>, and <script>/<style>.
 */
export function replaceInHtml(html: string, entities: CompiledEntity[], linkedTerms?: Set<string>): string {
  const skipTags = /^<(a|code|h[1-6]|script|style|pre)\b/i
  const skipClose = /^<\/(a|code|h[1-6]|script|style|pre)>/i
  const textRegions: Array<{ start: number; end: number }> = []
  let i = 0
  let skipDepth = 0

  while (i < html.length) {
    if (html[i] === "<") {
      const tagEnd = html.indexOf(">", i)
      if (tagEnd === -1) break
      const tag = html.slice(i, tagEnd + 1)
      if (skipClose.test(tag)) {
        skipDepth = Math.max(0, skipDepth - 1)
      } else if (skipTags.test(tag)) {
        skipDepth++
      }
      i = tagEnd + 1
    } else {
      if (skipDepth === 0) {
        const nextTag = html.indexOf("<", i)
        const end = nextTag === -1 ? html.length : nextTag
        if (end > i) textRegions.push({ start: i, end })
        i = end
      } else {
        const nextTag = html.indexOf("<", i)
        i = nextTag === -1 ? html.length : nextTag
      }
    }
  }

  const matches: Array<{ start: number; end: number; entity: CompiledEntity }> = []
  const occupied = new Set<number>()

  for (const entity of entities) {
    if (linkedTerms?.has(entity.term)) continue
    let matched = false
    for (const region of textRegions) {
      if (matched) break
      const segment = html.slice(region.start, region.end)
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
        if (matched) continue
        matched = true
        for (let p = absStart; p < absEnd; p++) occupied.add(p)
        matches.push({ start: absStart, end: absEnd, entity })
      }
    }
  }

  if (matches.length === 0) return html

  if (linkedTerms) {
    for (const { entity } of matches) linkedTerms.add(entity.term)
  }

  matches.sort((a, b) => b.start - a.start)
  let result = html
  for (const { start, end, entity } of matches) {
    result = result.slice(0, start) + renderEntity(result.slice(start, end), entity) + result.slice(end)
  }
  return result
}
