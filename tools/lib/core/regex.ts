/**
 * Parse a regex literal from a CLI argument.
 *
 * Requires the standard `/pattern/flags` form. This forces the caller to make
 * case sensitivity an explicit decision, because case-insensitive match and
 * case-preserving replacement are the same concern (when you say "match any
 * case", you also mean "preserve that case on replace").
 *
 * ## Accepted
 *
 * - `/screenRect/g`      — exact match, literal replacement
 * - `/screenRect/`       — exact match (g added internally for multi-match)
 * - `/widget/gi`         — case-insensitive match + case-preserving replace
 * - `/\bfoo\b/g`         — anchored with word boundaries
 * - `/foo(bar)/g`        — capture groups (use $1 in replacement)
 *
 * ## Rejected
 *
 * - `screenRect`         — plain string, the old API. Force the user to
 *                          wrap in `/.../` so they confront case handling.
 *
 * ## Returns
 *
 * - `source`: pattern body
 * - `flags`: flags as written, plus `g` if not already present (global match
 *            within a file is always the semantic intent)
 * - `caseInsensitive`: true if `i` flag was specified. Downstream code uses
 *                      this to decide whether to apply case-preservation to
 *                      the replacement string.
 */
export interface ParsedRegex {
  source: string
  flags: string
  caseInsensitive: boolean
}

const REGEX_LITERAL = /^\/((?:\\.|[^/\\])*)\/([gimsuy]*)$/

export function parseRegexLiteral(input: string, argName = "pattern"): ParsedRegex {
  const match = REGEX_LITERAL.exec(input)
  if (!match) {
    throw new Error(
      `${argName} must be a regex literal in the form /pattern/flags. Got: ${JSON.stringify(input)}\n\n` +
        `Examples:\n` +
        `  /screenRect/g   — exact match, literal replacement\n` +
        `  /widget/gi      — case-insensitive match + case-preserving replacement\n` +
        `  /\\bfoo\\b/g     — word-boundary match\n\n` +
        `The /i flag is significant: it enables case-insensitive matching AND\n` +
        `case-preserving replacement (widget→gadget, Widget→Gadget, WIDGET→GADGET).\n` +
        `Without /i, match and replace are both exact.`,
    )
  }
  const source = match[1]!
  let flags = match[2] ?? ""
  // Multi-match within a file is always the semantic intent — add `g` if missing.
  if (!flags.includes("g")) flags += "g"
  return {
    source,
    flags,
    caseInsensitive: flags.includes("i"),
  }
}

/**
 * Build a RegExp from a parsed literal. Convenience wrapper.
 */
export function buildRegex(parsed: ParsedRegex): RegExp {
  return new RegExp(parsed.source, parsed.flags)
}
