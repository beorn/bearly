/**
 * Shared prompt-filtering and snippet-cleaning primitives used by the
 * UserPromptSubmit hook path (library `hookRecall`) and the in-daemon
 * injection path (`tribe.inject_delta`). Both filter the same classes of
 * trivial prompts and format recall snippets identically, so these helpers
 * are the single source of truth.
 */

export type InjectSkipReason =
  | "empty"
  | "short"
  | "trivial"
  | "slash_command"
  | "no_results"
  | "all_seen"
  | "low_salience"
  | "low_quality"

export const TRIVIAL_PROMPTS: ReadonlySet<string> = new Set([
  "yes",
  "no",
  "y",
  "n",
  "ok",
  "okay",
  "sure",
  "continue",
  "go ahead",
  "lgtm",
  "looks good",
  "do it",
  "proceed",
  "thanks",
  "thank you",
  "done",
  "sounds good",
  "go for it",
])

/**
 * Classify a prompt into a skip reason, or null if it's substantive enough
 * to feed into recall. Order matters: short-check runs before trivial-check
 * because all current trivial phrases are <15 chars (trivial is effectively
 * a fail-safe for exact-match short phrases that might slip past a relaxed
 * short-check in the future).
 */
export function classifyPromptSkip(prompt: string): InjectSkipReason | null {
  if (!prompt || prompt.trim().length === 0) return "empty"
  if (prompt.trim().length < 15) return "short"
  const lower = prompt.toLowerCase().trim()
  if (TRIVIAL_PROMPTS.has(lower)) return "trivial"
  if (prompt.startsWith("/")) return "slash_command"
  return null
}

/**
 * Extract recallable identifiers from a prompt — tokens that anchor the
 * prompt to specific past content. If none are present and the prompt is
 * short, it's likely a meta-question ("how should we improve?") for which
 * FTS will return tangentially-related noise.
 *
 * Identifiers we recognize:
 *  - kebab-case IDs with ≥1 hyphen (km-tribe.recall, ambient-context-excellence)
 *  - file paths with `/` and a dotted extension OR a tools/-style anchor
 *  - backticked tokens (`recall.ts`, `tribe.ask`)
 *  - quoted phrases ("how does X work")
 *  - error-string shapes (CamelCase ending in Error/Exception/Warning)
 *  - explicit @scope/pkg or scoped package names
 */
// Kebab IDs need to look like real project identifiers, not English
// phrasal compounds ("kind-of", "out-of") or numeric quantities ("4-line",
// "7-day"). Require either:
//  - 2+ hyphens (test-system-migration), OR
//  - 1 hyphen AND BOTH sides ≥3 letters AND letters-only (test-system,
//    fork-isolation, parent-death — but NOT kind-of, out-of, sub-3)
const RE_KEBAB_ID = /\b(?:[a-z]+(?:-[a-z0-9]+){2,}|[a-z]{3,}-[a-z]{3,}[a-z0-9]*)\b/
const RE_PATH =
  /\b[a-zA-Z0-9_./-]*\/[a-zA-Z0-9_./-]+\.[a-z]{1,5}\b|\b(?:tools|packages|apps|hub|docs|vendor)\/[a-zA-Z0-9_./-]+/
const RE_BACKTICKED = /`[^`\n]{2,}`/
const RE_QUOTED = /"[^"\n]{4,}"/
const RE_ERROR = /\b[A-Z][a-zA-Z]+(?:Error|Exception|Warning|Bug|Failure)\b/
const RE_SCOPED_PKG = /@[a-z0-9-]+\/[a-z0-9-]+/

export function hasSalience(prompt: string): boolean {
  if (RE_KEBAB_ID.test(prompt)) return true
  if (RE_PATH.test(prompt)) return true
  if (RE_BACKTICKED.test(prompt)) return true
  if (RE_QUOTED.test(prompt)) return true
  if (RE_ERROR.test(prompt)) return true
  if (RE_SCOPED_PKG.test(prompt)) return true
  return false
}

/**
 * Length above which a substantive prompt bypasses the salience gate.
 * A long question ("does it support X?") is itself enough signal for FTS to
 * find content; the gate is mainly there to reject short meta-prompts
 * ("improve this", "fix it", "what now?").
 */
export const LONG_PROMPT_BYPASS_LENGTH = 120

/**
 * Body patterns that signal a snippet is its own evidence of irrelevance —
 * either it's a stored verdict from prior research, or it's about a
 * superseded/rejected/deprecated outcome. Catches the literal failure mode
 * we saw in dogfooding (a stored llm-research session containing the field
 * `"verdict": "orthogonal"` was being emitted as if it were relevant context).
 *
 * Conservative: matches require the keyword to appear in a labeled position
 * to avoid false positives on legitimate content discussing these concepts.
 */
const RE_BODY_REJECTED_SIGNAL =
  /(?:verdict|status|outcome|state|reason|disposition)["\s]*[:=]\s*["\s]*(?:orthogonal|incidental|irrelevant|rejected|superseded|deprecated|wontfix|invalid)\b/i

export function containsRejectedSignal(text: string): boolean {
  return RE_BODY_REJECTED_SIGNAL.test(text)
}

/**
 * Minimum FTS5 BM25 rank for a snippet to be considered. Ranks are negative
 * (closer to 0 = weaker match). A rank of -5 or higher (i.e., -4, -3, …)
 * indicates a marginal token-overlap match that's typically noise.
 *
 * Calibrated from dogfooding: ranks ≤ -8 produce mostly relevant hits;
 * ranks in the [-7, -3] band are mixed; ranks > -3 are almost always noise.
 */
export const MIN_RANK_THRESHOLD = -3

/**
 * Strip FTS5 highlight markers, JSON fragments, role tags, and collapse
 * whitespace so snippets render cleanly in injected context. Both the
 * daemon and the library path format snippets identically.
 */
export function cleanSnippet(raw: string): string {
  let text = raw.trim()
  text = text.replace(/>>>|<<</g, "")
  text = text
    .replace(/\{"[^"]*"[^}]*\}/g, "")
    .replace(/\{[^}]{0,50}\}?/g, "")
    .trim()
  text = text
    .replace(/\[(?:Assistant|User)\]\s*/g, "")
    .replace(/^-{3,}\n?/gm, "")
    .trim()
  text = text.replace(/\n{3,}/g, "\n\n").trim()
  return text
}
