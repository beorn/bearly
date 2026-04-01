/**
 * Doc-derived glossary — extracts glossary terms directly from markdown
 * source files at build time. Three extraction patterns:
 *
 * 1. **Heading + first paragraph** with `<!-- glossary: bucket -->` marker
 * 2. **Abbreviation syntax** `*[TERM]: tooltip text`
 * 3. **dfn marking** `<dfn>term</dfn>` with surrounding sentence as tooltip
 *
 * Usage:
 * ```typescript
 * import { extractGlossary, loadBucket } from "@bearly/vitepress-enrich/doc-glossary"
 *
 * const terms = extractGlossary({
 *   include: ["docs/**\/*.md"],
 *   pathBuckets: { "docs/api/**": "api", "docs/guide/**": "guide" },
 *   baseUrl: "/",
 * })
 *
 * const apiTerms = loadBucket(terms, "api")
 * md.use(glossaryPlugin, { entities: apiTerms })
 * ```
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, dirname, extname } from "node:path"
import type { GlossaryEntity } from "./types.ts"

/** Options for scanning markdown files and extracting glossary terms. */
export interface DocGlossaryOptions {
  /** Glob patterns for markdown files to scan (relative to cwd or absolute). */
  include: string[]
  /** Default bucket when not specified via marker or pathBuckets. */
  defaultBucket?: string
  /** Map file path patterns to buckets: { "docs/api/**": "api" }. */
  pathBuckets?: Record<string, string>
  /** Base URL prefix for generating hrefs from file paths. */
  baseUrl?: string
}

/** A glossary term extracted from a markdown source file. */
export interface ExtractedTerm {
  /** The term text. */
  term: string
  /** Tooltip/description text. */
  tooltip: string
  /** Bucket name for grouping terms. */
  bucket: string
  /** URL derived from source file path. */
  href?: string
  /** Source file path (for debugging). */
  source: string
}

/**
 * Match a file path against a simple glob pattern.
 * Supports `*` (any segment chars) and `**` (any path segments).
 */
function matchGlob(pattern: string, filePath: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*")
  return new RegExp(`^${regexStr}$`).test(filePath)
}

/** Recursively collect all .md files under a directory. */
function collectMarkdownFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      // Skip node_modules and hidden dirs
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      results.push(...collectMarkdownFiles(full))
    } else if (extname(entry.name) === ".md") {
      results.push(full)
    }
  }
  return results
}

/** Resolve include patterns to absolute file paths. */
function resolveFiles(include: string[]): string[] {
  const files = new Set<string>()
  for (const pattern of include) {
    // If pattern is an absolute path or relative dir, try to collect from it
    const base = pattern.replace(/\/?\*.*$/, "") || "."
    let dir: string
    try {
      dir = statSync(base).isDirectory() ? base : dirname(base)
    } catch {
      continue
    }
    for (const file of collectMarkdownFiles(dir)) {
      const rel = relative(dir, file)
      const fullPattern = pattern.startsWith(base) ? pattern.slice(base.length + 1) : pattern
      if (matchGlob(fullPattern || "**/*.md", rel)) {
        files.add(file)
      }
    }
  }
  return [...files]
}

/** Determine bucket for a file path from pathBuckets mapping. */
function inferBucket(filePath: string, pathBuckets?: Record<string, string>, defaultBucket?: string): string {
  if (pathBuckets) {
    for (const [pattern, bucket] of Object.entries(pathBuckets)) {
      if (matchGlob(pattern, filePath)) return bucket
    }
  }
  return defaultBucket ?? "default"
}

/** Derive a URL href from a source file path and baseUrl. */
function deriveHref(filePath: string, baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined
  // Convert file path to URL: docs/api/select-list.md → /api/select-list
  const withoutExt = filePath.replace(/\.md$/, "").replace(/\/index$/, "")
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
  return `${base}${withoutExt}`
}

/**
 * Extract heading + first paragraph terms.
 *
 * Pattern:
 * ```markdown
 * <!-- glossary: bucket -->
 * ## TermName
 * First paragraph becomes the tooltip.
 * ```
 */
function extractHeadingTerms(
  content: string,
  filePath: string,
  defaultBucket: string,
  baseUrl?: string,
): ExtractedTerm[] {
  const terms: ExtractedTerm[] = []
  const markerRe = /<!--\s*glossary:\s*(\S+)\s*-->/g

  let marker: RegExpExecArray | null
  while ((marker = markerRe.exec(content)) !== null) {
    const bucket = marker[1]
    const afterMarker = content.slice(marker.index + marker[0].length)

    // Find the next heading
    const headingMatch = afterMarker.match(/\n#{1,6}\s+(.+)/)
    if (!headingMatch) continue

    const term = headingMatch[1]!.trim()
    const afterHeading = afterMarker.slice(headingMatch.index! + headingMatch[0].length)

    // First non-empty paragraph after the heading
    const paraMatch = afterHeading.match(/\n\n*([^\n#<][^\n]+)/)
    const tooltip = paraMatch ? paraMatch[1]!.trim() : ""
    if (!tooltip) continue

    terms.push({
      term,
      tooltip,
      bucket: bucket!,
      href: deriveHref(filePath, baseUrl),
      source: filePath,
    })
  }

  return terms
}

/**
 * Extract abbreviation-syntax terms.
 *
 * Pattern: `*[TERM]: tooltip text`
 */
function extractAbbreviationTerms(content: string, filePath: string, bucket: string): ExtractedTerm[] {
  const terms: ExtractedTerm[] = []
  const abbrRe = /^\*\[([^\]]+)\]:\s*(.+)$/gm

  let match: RegExpExecArray | null
  while ((match = abbrRe.exec(content)) !== null) {
    const term = match[1]!
    const tooltip = match[2]!.trim()
    if (!tooltip) continue

    terms.push({
      term,
      tooltip,
      bucket,
      source: filePath,
    })
  }

  return terms
}

/**
 * Extract dfn-marked terms.
 *
 * Pattern: `<dfn>term</dfn>` — tooltip is the surrounding sentence.
 */
function extractDfnTerms(content: string, filePath: string, bucket: string): ExtractedTerm[] {
  const terms: ExtractedTerm[] = []
  const dfnRe = /<dfn>([^<]+)<\/dfn>/g

  let match: RegExpExecArray | null
  while ((match = dfnRe.exec(content)) !== null) {
    const term = match[1]!

    // Find the surrounding sentence for tooltip
    const before = content.slice(0, match.index)
    const after = content.slice(match.index + match[0].length)

    // Walk back to sentence start (period/newline/start)
    const sentStart = Math.max(
      before.lastIndexOf(". ") + 2,
      before.lastIndexOf(".\n") + 2,
      before.lastIndexOf("\n\n") + 2,
      0,
    )
    // Walk forward to sentence end
    const periodIdx = after.search(/\.\s|\.\n|$/)
    const sentEnd = periodIdx >= 0 ? match.index + match[0].length + periodIdx + 1 : content.length

    let tooltip = content.slice(sentStart, sentEnd).trim()
    // Remove the dfn tags from the tooltip
    tooltip = tooltip.replace(/<\/?dfn>/g, "")
    if (!tooltip || tooltip === term) continue

    terms.push({
      term,
      tooltip,
      bucket,
      source: filePath,
    })
  }

  return terms
}

/** Extract frontmatter bucket if present: `glossary_bucket: name`. */
function extractFrontmatterBucket(content: string): string | undefined {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) return undefined
  const bucketMatch = fmMatch[1]!.match(/^glossary_bucket:\s*(.+)$/m)
  return bucketMatch ? bucketMatch[1]!.trim() : undefined
}

/**
 * Extract glossary terms from markdown files at build time.
 *
 * Scans files matching the include patterns and extracts terms using
 * three pattern types: heading markers, abbreviation syntax, and dfn tags.
 */
export function extractGlossary(options: DocGlossaryOptions): ExtractedTerm[] {
  const { include, defaultBucket, pathBuckets, baseUrl } = options
  const files = resolveFiles(include)
  const allTerms: ExtractedTerm[] = []

  for (const filePath of files) {
    const content = readFileSync(filePath, "utf-8")
    const rel = filePath // Use as-is; caller provides relative patterns

    // Determine bucket: frontmatter > pathBuckets > defaultBucket
    const fmBucket = extractFrontmatterBucket(content)
    const bucket = fmBucket ?? inferBucket(rel, pathBuckets, defaultBucket)

    allTerms.push(...extractHeadingTerms(content, rel, bucket, baseUrl))
    allTerms.push(...extractAbbreviationTerms(content, rel, bucket))
    allTerms.push(...extractDfnTerms(content, rel, bucket))
  }

  // Deduplicate by term (first occurrence wins)
  const seen = new Set<string>()
  return allTerms.filter((t) => {
    if (seen.has(t.term)) return false
    seen.add(t.term)
    return true
  })
}

/**
 * Extract terms from a single markdown string (no filesystem access).
 * Useful for testing and programmatic usage.
 */
export function extractFromMarkdown(
  content: string,
  options: { bucket?: string; filePath?: string; baseUrl?: string } = {},
): ExtractedTerm[] {
  const filePath = options.filePath ?? "<inline>"
  const bucket = options.bucket ?? "default"
  const terms: ExtractedTerm[] = []

  const fmBucket = extractFrontmatterBucket(content)
  const effectiveBucket = fmBucket ?? bucket

  terms.push(...extractHeadingTerms(content, filePath, effectiveBucket, options.baseUrl))
  terms.push(...extractAbbreviationTerms(content, filePath, effectiveBucket))
  terms.push(...extractDfnTerms(content, filePath, effectiveBucket))

  // Deduplicate
  const seen = new Set<string>()
  return terms.filter((t) => {
    if (seen.has(t.term)) return false
    seen.add(t.term)
    return true
  })
}

/** Load terms from a specific bucket, converting to GlossaryEntity[]. */
export function loadBucket(terms: ExtractedTerm[], bucket: string): GlossaryEntity[] {
  return terms
    .filter((t) => t.bucket === bucket)
    .map((t) => ({
      term: t.term,
      tooltip: t.tooltip,
      href: t.href,
    }))
}

/** Save extracted terms to a JSONL file for cross-site import. */
export function writeGlossaryBucket(terms: ExtractedTerm[], bucket: string, outPath: string): void {
  const filtered = terms.filter((t) => t.bucket === bucket)
  const lines = filtered.map((t) => JSON.stringify(t))
  writeFileSync(outPath, lines.join("\n") + "\n", "utf-8")
}

/** Load terms from a JSONL bucket file. */
export function readGlossaryBucket(path: string): ExtractedTerm[] {
  const content = readFileSync(path, "utf-8")
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ExtractedTerm)
}
