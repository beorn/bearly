/**
 * Optional integration with @bearly/recall for the "📚 Similar past queries"
 * hint surfaced before a default-mode dispatch.
 *
 * Why optional: standalone @bearly/llm consumers don't necessarily have
 * @bearly/recall installed. The previous hard import via a relative path
 * (`../../recall/src/history/db`) coupled @bearly/llm to the bearly monorepo
 * layout — fine for sibling-plugin development, broken for npm consumers.
 *
 * Resolution order (best-effort):
 *   1. The published npm package: `@bearly/recall/history/db`
 *   2. The sibling-source path: `../../recall/src/history/db` — only resolves
 *      when running inside the bearly monorepo, kept for monorepo dev ergonomics.
 *
 * Returns `null` if neither resolves; callers MUST handle null and fall back
 * to skipping the hint entirely (no crash, no warning — recall is purely
 * additive UX).
 */

export interface RecallApi {
  getDb: () => unknown
  closeDb: () => void
  findSimilarQueries: (
    db: unknown,
    query: string,
    opts: { limit?: number },
  ) => Array<{ timestamp: string | number; user_content?: string }>
}

let cached: RecallApi | null | undefined

/**
 * Lazy-load @bearly/recall's history/db module. Memoized — repeat calls are
 * free. Returns `null` when recall isn't installed; `cached` distinguishes
 * "not yet tried" (undefined) from "tried, missing" (null).
 *
 * The dynamic import string is computed via a variable so bundlers (tsdown)
 * don't try to statically resolve `@bearly/recall` at build time and bake a
 * hard dependency into the published artifact. The resulting code shape is
 * `await import(specifier)` — interpreted at runtime, fails gracefully when
 * the package isn't on disk.
 */
export async function loadRecall(): Promise<RecallApi | null> {
  if (cached !== undefined) return cached
  // Allow tests + standalone consumers to disable explicitly without relying
  // on the package being absent. BEARLY_LLM_NO_RECALL=1 short-circuits.
  if (process.env.BEARLY_LLM_NO_RECALL) {
    cached = null
    return cached
  }
  const candidates = [
    // 1. Published npm package — preferred for standalone usage.
    "@bearly/recall/history/db",
    // 2. Sibling-source path — resolves only inside the bearly monorepo.
    //    Kept so plugin-on-plugin dev doesn't need a publish round-trip.
    "../../../recall/src/history/db",
  ]
  for (const spec of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const mod = (await import(/* @vite-ignore */ spec)) as Partial<RecallApi>
      if (typeof mod.getDb === "function" && typeof mod.findSimilarQueries === "function") {
        cached = {
          getDb: mod.getDb,
          closeDb: typeof mod.closeDb === "function" ? mod.closeDb : () => {},
          findSimilarQueries: mod.findSimilarQueries,
        }
        return cached
      }
    } catch {
      // Try the next candidate.
    }
  }
  cached = null
  return cached
}

/** Reset the memoized resolver — used by tests to flip between
 * "recall present" / "recall absent" within a single suite. */
export function _resetRecallCache(): void {
  cached = undefined
}
