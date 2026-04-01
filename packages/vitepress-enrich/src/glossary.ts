/**
 * Markdown-it plugin for glossary/entity auto-linking.
 *
 * Renders: <a href="/path" class="hover-link" data-tooltip="...">term</a>
 * Uses tooltip.css + glossary-links.css for styling.
 *
 * Skips: code spans, code blocks, fences, existing links, headings.
 * First-occurrence-only per page. Longest-match-first.
 */
import type MarkdownIt from "markdown-it"
import type Token from "markdown-it/lib/token.mjs"
import type { GlossaryEntity, CompiledEntity } from "./types.ts"
import { compileEntities, replaceEntities, replaceInHtml } from "./entity-engine.ts"

export interface GlossaryPluginOptions {
  /** Array of glossary entities to auto-link. */
  entities: GlossaryEntity[]
}

/**
 * Markdown-it plugin that auto-links glossary terms in prose content.
 *
 * Usage:
 * ```typescript
 * import { glossaryPlugin } from "@bearly/vitepress-enrich/glossary"
 *
 * // In VitePress config:
 * markdown: {
 *   config(md) {
 *     md.use(glossaryPlugin, {
 *       entities: [
 *         { term: "SelectList", href: "/api/select-list", tooltip: "Interactive list component" },
 *         { term: "SGR", tooltip: "Select Graphic Rendition" },
 *       ]
 *     })
 *   }
 * }
 * ```
 */
export function glossaryPlugin(md: MarkdownIt, options: GlossaryPluginOptions): void {
  const entities = compileEntities(options.entities)

  md.core.ruler.push("glossary_links", (state) => {
    for (const blockToken of state.tokens) {
      // Process HTML blocks (tables, divs embedded in markdown)
      if (blockToken.type === "html_block" && blockToken.content) {
        blockToken.content = replaceInHtml(blockToken.content, entities)
        continue
      }

      // Only process inline tokens (paragraphs, list items, etc.)
      if (blockToken.type !== "inline" || !blockToken.children) continue

      // Skip headings entirely
      const blockIdx = state.tokens.indexOf(blockToken)
      let inHeading = false
      for (let i = blockIdx - 1; i >= 0; i--) {
        if (state.tokens[i].type === "heading_open") {
          inHeading = true
          break
        }
        if (state.tokens[i].type === "heading_close") break
      }
      if (inHeading) continue

      // Process children: find text tokens not inside links or code
      const children = blockToken.children
      const newChildren: Token[] = []
      let insideLink = false

      for (const child of children) {
        if (child.type === "link_open") {
          insideLink = true
          newChildren.push(child)
          continue
        }
        if (child.type === "link_close") {
          insideLink = false
          newChildren.push(child)
          continue
        }
        if (child.type === "code_inline" || insideLink) {
          newChildren.push(child)
          continue
        }
        if (child.type !== "text") {
          newChildren.push(child)
          continue
        }

        const replaced = replaceEntities(child.content, entities)
        if (replaced === child.content) {
          newChildren.push(child)
          continue
        }

        // Emit as html_inline so markdown-it renders the <a> tags
        const htmlToken = new state.Token("html_inline", "", 0)
        htmlToken.content = replaced
        newChildren.push(htmlToken)
      }

      blockToken.children = newChildren
    }
  })
}
