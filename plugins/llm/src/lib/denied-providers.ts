/**
 * `RECALL_LLM_DENY_PROVIDERS` — the host's list of providers it has already declared broken.
 *
 * @bearly/recall owns this policy and passes it into its own model selector, but the CLI it spawns
 * never saw it, so a provider the host had excluded still got called and still failed (28886). The
 * CLI parses the same variable locally: the recall package lives in a different repository and is
 * not importable from here, and the list is a plain comma-separated provider-name set.
 *
 * Format: `openai,xai` — case-insensitive, whitespace-tolerant, empty entries ignored.
 */
export function deniedProviders(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const raw = env.RECALL_LLM_DENY_PROVIDERS
  if (!raw) return new Set()
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  )
}
