/**
 * Built-in ecosystem project glossary — auto-links mentions of Silvery,
 * Termless, Flexily, Loggily, terminfo.dev, mdtest, and Vimonkey across
 * all VitePress sites that use @bearly/vitepress-enrich.
 *
 * Usage:
 * ```typescript
 * import { loadEcosystemGlossary } from "@bearly/vitepress-enrich/ecosystem-glossary"
 *
 * // Omit self-references: silvery.dev won't link "Silvery" to itself
 * const ecosystem = loadEcosystemGlossary({ exclude: ["silvery.dev"] })
 * const glossary = [...siteGlossary, ...ecosystem]
 * md.use(glossaryPlugin, { entities: glossary })
 * ```
 */
import type { GlossaryEntity } from "./types.ts"

interface EcosystemProject {
  /** Term(s) to match — first is primary, rest are aliases. */
  terms: string[]
  /** URL to link to. */
  href: string
  /** Tooltip description. */
  tooltip: string
  /** Hostname used for self-reference exclusion (e.g., "silvery.dev"). */
  hostname: string
}

const ECOSYSTEM_PROJECTS: EcosystemProject[] = [
  {
    terms: ["Silvery"],
    href: "https://silvery.dev",
    tooltip: "React-based TUI framework for building terminal applications. Reconciler, components, and theme system.",
    hostname: "silvery.dev",
  },
  {
    terms: ["Termless"],
    href: "https://termless.dev",
    tooltip:
      "Headless terminal testing and recording. Test ANSI output, capture screenshots, record asciicast animations.",
    hostname: "termless.dev",
  },
  {
    terms: ["Flexily"],
    href: "https://beorn.codes/flexily",
    tooltip: "High-performance flexbox layout engine. Yoga-compatible with zero allocations and composable plugins.",
    hostname: "beorn.codes/flexily",
  },
  {
    terms: ["Loggily"],
    href: "https://beorn.codes/loggily",
    tooltip: "Structured logging with namespace filtering, spans, and zero-overhead conditional logging.",
    hostname: "beorn.codes/loggily",
  },
  {
    terms: ["terminfo.dev"],
    href: "https://terminfo.dev",
    tooltip: "Comprehensive terminal feature database. 148 features across 10+ terminals with probe-based testing.",
    hostname: "terminfo.dev",
  },
  {
    terms: ["mdtest"],
    href: "https://github.com/beorn/mdtest",
    tooltip: "Markdown-driven test specifications. Write tests as documentation.",
    hostname: "github.com/beorn/mdtest",
  },
  {
    terms: ["Vimonkey"],
    href: "https://github.com/beorn/vimonkey",
    tooltip: "Vitest monkey-patching utilities for test isolation and mocking.",
    hostname: "github.com/beorn/vimonkey",
  },
]

export interface EcosystemGlossaryOptions {
  /**
   * Hostnames to exclude (self-references). Matches against the project's
   * hostname field. For example, `["silvery.dev"]` prevents Silvery from
   * linking to itself on silvery.dev.
   *
   * Also supports full hostnames with path prefixes like "beorn.codes/flexily"
   * for sites hosted at subpaths.
   */
  exclude?: string[]
}

/**
 * Load ecosystem project entities for cross-linking.
 *
 * Returns GlossaryEntity[] suitable for passing to the glossary plugin.
 * Pass `exclude` with the current site's hostname(s) to prevent self-references.
 */
export function loadEcosystemGlossary(options?: EcosystemGlossaryOptions): GlossaryEntity[] {
  const exclude = new Set(options?.exclude ?? [])
  const entities: GlossaryEntity[] = []

  for (const project of ECOSYSTEM_PROJECTS) {
    if (exclude.has(project.hostname)) continue

    for (const term of project.terms) {
      entities.push({
        term,
        href: project.href,
        tooltip: project.tooltip,
        external: true,
      })
    }
  }

  return entities
}
