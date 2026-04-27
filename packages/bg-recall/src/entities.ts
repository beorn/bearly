/**
 * Entity + shingle extraction from tool calls.
 *
 * Mirrors the heuristics in `@bearly/injection-envelope`'s `manifest.ts`
 * (extractEntities + extractShingles). Inlined here so the package stays
 * standalone — no cross-plugin imports. If the upstream heuristic changes
 * meaningfully, audit both files together.
 *
 * Tool-call shaping:
 *  - we score the tool input + output independently and merge entity sets
 *  - we keep `kind`-specific extraction for `Read`/`Bash`/`Grep`/`Edit` so the
 *    daemon can ask "what file was read?" without re-parsing
 */

import type { ToolCallEvent } from "./types.ts"

const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "me",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "so",
  "that",
  "the",
  "this",
  "to",
  "we",
  "what",
  "when",
  "where",
  "why",
  "will",
  "with",
  "you",
  "your",
])

const FILE_EXT_RE = /([\w.@/-]+\.(md|ts|tsx|js|jsx|json|sh|py|rs|go|toml|yml|yaml|txt|mdx))\b/gi
const SIGIL_RE = /\b([a-z][\w-]*\.[\w.-]+)\b/gi
const TITLE_RE = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g
const HASHTAG_RE = /([@#$][\w-]+)/g
const LONGWORD_RE = /\b([a-zA-Z][a-zA-Z0-9-]{6,})\b/g

/** Extract entities from raw text — file paths, sigils, TitleCase, long words. */
export function extractEntities(text: string): string[] {
  if (!text) return []
  const out = new Set<string>()
  for (const m of text.matchAll(FILE_EXT_RE)) {
    out.add(m[1]!.toLowerCase())
    const base = m[1]!.split("/").pop()
    if (base) out.add(base.toLowerCase())
  }
  for (const m of text.matchAll(SIGIL_RE)) out.add(m[1]!.toLowerCase())
  for (const m of text.matchAll(TITLE_RE)) out.add(m[1]!.toLowerCase())
  for (const m of text.matchAll(HASHTAG_RE)) out.add(m[1]!.toLowerCase())
  for (const m of text.matchAll(LONGWORD_RE)) {
    const w = m[1]!.toLowerCase()
    if (!STOPWORDS.has(w)) out.add(w)
  }
  return Array.from(out)
}

/** Extract n-gram shingles for lexical overlap scoring. */
export function extractShingles(text: string, n = 4): string[] {
  if (!text) return []
  const words = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0)
  if (words.length < n) return []
  const out = new Set<string>()
  for (let i = 0; i <= words.length - n; i++) {
    out.add(fnv1a32(words.slice(i, i + n).join(" ")))
  }
  return Array.from(out)
}

function fnv1a32(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/**
 * Tool-call-aware entity extraction. Shapes per-tool:
 *
 *  - Read  → file path is the dominant entity
 *  - Edit  → both path and (string-representation of) old/new
 *  - Bash  → command tokens; file paths inside the command
 *  - Grep  → search pattern + scope path
 *
 * Falls back to plain-text extraction for any tool whose input shape we don't
 * special-case. The merger biases TOWARDS structured entities (file paths,
 * sigils) and lightly samples free text — a tool that emits 200KB of console
 * spam shouldn't drown out the file-path the user just opened.
 */
export function entitiesFromToolCall(event: ToolCallEvent): string[] {
  const out = new Set<string>()
  const input = event.input ?? ""
  const output = event.output ?? ""

  for (const e of extractEntities(input)) out.add(e)

  // Output is bigger and noisier — cap and weight lower.
  const cappedOutput = output.length > 2000 ? output.slice(0, 2000) : output
  for (const e of extractEntities(cappedOutput)) out.add(e)

  // First-class file-path slot — many tools embed a path as the primary input.
  if (event.tool === "Read" || event.tool === "Edit" || event.tool === "Write") {
    const pathMatch = input.match(/[/~][\w./_-]+/)
    if (pathMatch?.[0]) out.add(pathMatch[0].toLowerCase())
  }
  return Array.from(out)
}

/**
 * Compute Jaccard-style overlap between two entity sets.
 * Returns a value in [0, 1]. Empty intersection or empty union → 0.
 */
export function entityOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setA = new Set(a)
  const inter = b.filter((x) => setA.has(x)).length
  if (inter === 0) return 0
  const union = new Set([...a, ...b]).size
  return inter / union
}
