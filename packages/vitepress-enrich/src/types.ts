/**
 * Shared types for vitepress-enrich.
 */

/** A glossary entity that can be auto-linked in content. */
export interface GlossaryEntity {
  /** The term to match (case-sensitive, word-boundary matched). */
  term: string
  /** URL to link to. Omit for tooltip-only (no navigation). */
  href?: string
  /** Tooltip text shown on hover. */
  tooltip?: string
  /** If true, open link in new tab (external links). */
  external?: boolean
}

/** Internal compiled entity with regex pattern. */
export interface CompiledEntity {
  term: string
  pattern: RegExp
  href: string
  tooltip: string
  tooltipOnly: boolean
  external: boolean
}

/** SEO configuration for a VitePress site. */
export interface SeoOptions {
  /** Site hostname with protocol (e.g., "https://silvery.dev"). */
  hostname: string
  /** Site display name (e.g., "Silvery"). */
  siteName: string
  /** Default meta description. */
  description?: string
  /** OG image URL (absolute). */
  ogImage?: string
  /** Author name or object with optional URL and sameAs links. */
  author?: string | { name: string; url?: string; sameAs?: string[] }
  /** Additional JSON-LD properties merged into the WebSite schema. */
  jsonLd?: Record<string, unknown>
  /** Repository URL for SoftwareSourceCode schema on API pages. */
  codeRepository?: string
  /** URL path prefix that triggers SoftwareSourceCode schema (default: "/api/"). */
  apiPathPrefix?: string
}
