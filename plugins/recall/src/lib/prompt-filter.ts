/**
 * Shared prompt-filtering and snippet-cleaning primitives used by the
 * UserPromptSubmit hook path (library `hookRecall`) and the in-daemon
 * injection path (`tribe.inject_delta`). Both filter the same classes of
 * trivial prompts and format recall snippets identically, so these helpers
 * are the single source of truth.
 */

export type InjectSkipReason = "empty" | "short" | "trivial" | "slash_command" | "no_results" | "all_seen"

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
