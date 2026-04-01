/**
 * @bearly/vitepress-enrich — Glossary auto-linking, content linkification,
 * SEO helpers, and tooltip CSS for VitePress sites.
 *
 * Quick start:
 * ```typescript
 * import { glossaryPlugin, seoHead, seoTransformPageData } from "@bearly/vitepress-enrich"
 * import { defineConfig } from "vitepress"
 *
 * const glossary = [
 *   { term: "SelectList", href: "/api/select-list", tooltip: "Interactive list component" },
 *   { term: "SGR", tooltip: "Select Graphic Rendition — controls text styling" },
 * ]
 *
 * export default defineConfig({
 *   head: [
 *     ...seoHead({ hostname: "https://example.com", siteName: "My Site" }),
 *   ],
 *   markdown: {
 *     config(md) {
 *       md.use(glossaryPlugin, { entities: glossary })
 *     }
 *   },
 *   transformPageData: seoTransformPageData({
 *     hostname: "https://example.com",
 *     siteName: "My Site",
 *     author: "Author Name",
 *   }),
 * })
 * ```
 *
 * CSS (import in your theme/index.ts):
 * ```typescript
 * import "@bearly/vitepress-enrich/css/tooltip.css"
 * import "@bearly/vitepress-enrich/css/glossary-links.css"
 * ```
 */
export { glossaryPlugin } from "./glossary.ts"
export type { GlossaryPluginOptions } from "./glossary.ts"
export { createLinkifier } from "./linkify.ts"
export { seoHead, seoTransformPageData } from "./seo.ts"
export { compileEntities, replaceEntities, replaceInHtml } from "./entity-engine.ts"
export { validateGlossary } from "./validate.ts"
export type { GlossaryEntity, CompiledEntity, SeoOptions } from "./types.ts"
