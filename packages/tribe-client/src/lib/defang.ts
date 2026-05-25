/**
 * Defang model input — strip transcript-shape from a string before it
 * lands in user-role context, breaking the autocatalytic role-prefix
 * hallucination trigger.
 *
 * NOTE: this is a vendored copy of the canonical implementation in
 * `@bearly/injection-envelope` (`plugins/injection-envelope/src/defang.ts`).
 * Kept in sync by convention — the two functions must remain
 * byte-identical. Tribe-client carries its own copy so the published
 * package has no plugin-cross dependency.
 *
 * Three transformations, applied in order:
 *
 *   1. `[log-redacted]` substitution for `HH:MM:SS LEVEL <namespace>` line
 *      shapes.
 *   2. Zero-width-space defang of role-prefix literals at line starts.
 *   3. Cap consecutive newlines at 2 to suppress transcript layout.
 *   4. Replace any lone UTF-16 surrogate with U+FFFD — JSON.stringify of a
 *      lone surrogate becomes invalid JSON the Anthropic API rejects.
 */

const LOG_LINE_RE = /\d{2}:\d{2}:\d{2}\s+(?:INFO|WARN|ERROR|DEBUG|TRACE)\s+\S+(?:\s[^\n]*)?/g

const ROLE_PREFIX_RE = /(^|\n)(Human|Assistant|User|H):(?=\s|$)/g

const ZWSP = String.fromCharCode(0x200b)

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

function defangRolePrefix(_match: string, lead: string, role: string): string {
  return `${lead}${role[0]}${ZWSP}${role.slice(1)}:`
}

/**
 * Apply transcript-shape defanging to a string bound for the model's
 * user-role context. Idempotent.
 */
export function defangModelInput(text: string): string {
  if (text.length === 0) return text
  return text
    .replace(LOG_LINE_RE, "[log-redacted]")
    .replace(ROLE_PREFIX_RE, defangRolePrefix)
    .replace(/\n{3,}/g, "\n\n")
    .replace(LONE_SURROGATE_RE, "�")
}
