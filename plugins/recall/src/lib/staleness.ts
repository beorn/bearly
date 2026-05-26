/**
 * Pure staleness helpers — see @km/bearly/19216-recall-freshness-shrink-threshold.
 *
 * Split from search.ts so unit tests can import these without dragging the
 * search.ts transitive closure (`bun:sqlite`, indexer, llm/agent → zod) into
 * vitest's node runtime. search.ts re-exports these for the existing surface.
 */

/** Default stale threshold — matches Anthropic's 5m prompt-cache TTL. */
export const RECALL_STALE_THRESHOLD_DEFAULT = "5m"

/** Parse "5m" / "30s" / "1h" / "500ms" / bare number-as-minutes → ms. */
export function parseThreshold(s: string): number {
  const m = /^(\d+)\s*(ms|s|m|h)?$/.exec(s.trim())
  if (!m) {
    throw new Error(`parseThreshold: invalid duration "${s}" — accepts <n>[ms|s|m|h] (e.g. "5m", "30s", "1h", "500ms")`)
  }
  const n = parseInt(m[1], 10)
  switch (m[2]) {
    case "ms":
      return n
    case "s":
      return n * 1000
    case "h":
      return n * 60 * 60 * 1000
    case "m":
    case undefined:
    case "":
      return n * 60 * 1000
    default:
      throw new Error(`parseThreshold: unreachable unit "${m[2]}"`)
  }
}

/** Read the env-or-default stale threshold (ms). */
export function getStaleThresholdMs(): number {
  return parseThreshold(process.env.RECALL_STALE_THRESHOLD ?? RECALL_STALE_THRESHOLD_DEFAULT)
}

export type RefreshResult =
  | { refreshed: false; reason: "fresh" | "no-meta" | "opt-out" }
  | { refreshed: true; staleMs: number; refreshMs: number }
  | { refreshed: false; reason: "error"; error: string; staleMs: number }
