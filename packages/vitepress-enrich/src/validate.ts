/**
 * Build-time glossary validation — checks that glossary hrefs point to
 * real pages and reports coverage stats.
 *
 * Usage in VitePress config:
 * ```typescript
 * import { validateGlossary } from "@bearly/vitepress-enrich/validate"
 *
 * export default defineConfig({
 *   buildEnd(siteConfig) {
 *     validateGlossary(glossary, siteConfig)
 *   }
 * })
 * ```
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { GlossaryEntity } from "./types.ts"

interface ValidationResult {
  totalTerms: number
  withLinks: number
  tooltipOnly: number
  external: number
  broken: string[]
  pagesWithLinks: number
  totalPages: number
}

/**
 * Validate glossary entries against built pages.
 * Logs a coverage summary and warns about broken internal links.
 *
 * @param entities - The glossary entity array
 * @param siteConfig - VitePress siteConfig from buildEnd hook
 * @returns ValidationResult with stats and any broken links
 */
export function validateGlossary(
  entities: GlossaryEntity[],
  siteConfig: { outDir: string; pages: string[] },
): ValidationResult {
  const broken: string[] = []
  let withLinks = 0
  let tooltipOnly = 0
  let external = 0

  for (const entity of entities) {
    if (!entity.href) {
      tooltipOnly++
      continue
    }
    if (entity.external || entity.href.startsWith("http")) {
      external++
      withLinks++
      continue
    }

    withLinks++

    // Check if the internal link target exists as a built page
    const cleanHref = entity.href.replace(/^\//, "").replace(/\/$/, "")
    const candidates = [`${cleanHref}.html`, `${cleanHref}/index.html`, `${cleanHref}.md`]

    const exists = candidates.some((c) => {
      const fullPath = join(siteConfig.outDir, c)
      return existsSync(fullPath)
    })

    // Also check against the pages list (source .md files)
    const pageExists = siteConfig.pages.some((p) => {
      const cleanPage = p.replace(/\.md$/, "").replace(/\/index$/, "")
      return cleanPage === cleanHref || cleanPage === `${cleanHref}/index`
    })

    if (!exists && !pageExists) {
      broken.push(`"${entity.term}" → ${entity.href}`)
    }
  }

  const result: ValidationResult = {
    totalTerms: entities.length,
    withLinks,
    tooltipOnly,
    external,
    broken,
    pagesWithLinks: 0, // Filled by caller if they have page-level stats
    totalPages: siteConfig.pages.length,
  }

  // Log summary
  const prefix = "[glossary]"
  console.log(
    `${prefix} ${entities.length} terms (${withLinks} linked, ${tooltipOnly} tooltip-only, ${external} external)`,
  )

  if (broken.length > 0) {
    console.warn(`${prefix} ⚠ ${broken.length} broken internal links:`)
    for (const b of broken) {
      console.warn(`${prefix}   ${b}`)
    }
  } else {
    console.log(`${prefix} ✓ All internal links valid`)
  }

  return result
}
