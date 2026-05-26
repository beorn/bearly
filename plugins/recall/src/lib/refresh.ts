/**
 * Stale-index auto-refresh — pure / deps-injected core.
 *
 * Split from search.ts (per @km/bearly/19244) so vitest unit tests can import
 * without dragging the search.ts transitive closure (`bun:sqlite`, indexer,
 * llm/agent → zod) into vitest's node runtime. search.ts wires productionDeps
 * (real getDb / getIndexMeta / Bun.spawn) when calling at runtime.
 *
 * See @km/bearly/19216-recall-freshness-shrink-threshold for the feature.
 */

import { getStaleThresholdMs, type RefreshResult } from "./staleness"

export type RefreshDeps = {
  /** Returns ISO 8601 timestamp of last index rebuild, or null if never indexed. Throws on DB errors. */
  getLastRebuild: () => string | null
  /** Returns current time in ms-since-epoch. */
  now: () => number
  /** Returns the stale threshold in ms. */
  getThresholdMs: () => number
  /** Spawns the refresh subprocess; returns exit code + optional stderr. */
  spawnCmd: (argv: string[]) => Promise<{ exitCode: number; stderr?: string }>
}

/**
 * Check if the FTS5 index is stale and, if so, run `bun recall index --incremental`
 * as a subprocess to refresh it before the search proceeds.
 *
 * Best-effort: on subprocess failure, returns { refreshed: false, reason: "error" }
 * with the error message — never throws, so a transient refresh problem doesn't
 * break search. Caller is responsible for printing a one-line note from the result.
 *
 * Honors RECALL_STALE_THRESHOLD env var (e.g. "5m", "1h", "30s") and the
 * `--no-refresh` opt-out flag (mapped to options.refresh === false by commander).
 */
export async function refreshIndexIfStaleWithDeps(
  options: { refresh?: boolean },
  deps: RefreshDeps,
): Promise<RefreshResult> {
  if (options.refresh === false) return { refreshed: false, reason: "opt-out" }

  let staleMs = 0
  try {
    const lastRebuild = deps.getLastRebuild()
    if (!lastRebuild) return { refreshed: false, reason: "no-meta" }
    staleMs = deps.now() - new Date(lastRebuild).getTime()
    if (staleMs <= deps.getThresholdMs()) return { refreshed: false, reason: "fresh" }
  } catch (e) {
    return { refreshed: false, reason: "error", error: e instanceof Error ? e.message : String(e), staleMs }
  }

  const start = deps.now()
  try {
    const result = await deps.spawnCmd(["bun", "recall", "index", "--incremental"])
    if (result.exitCode !== 0) {
      return {
        refreshed: false,
        reason: "error",
        error: `bun recall index --incremental exited ${result.exitCode}${result.stderr ? `: ${result.stderr.trim().split("\n")[0]}` : ""}`,
        staleMs,
      }
    }
    return { refreshed: true, staleMs, refreshMs: deps.now() - start }
  } catch (e) {
    return { refreshed: false, reason: "error", error: e instanceof Error ? e.message : String(e), staleMs }
  }
}

/** Default real-runtime deps for the threshold helper + Bun.spawn. The DB-bound
 * `getLastRebuild` impl must be supplied by the caller (search.ts wires it). */
export function makeRefreshDeps(getLastRebuild: () => string | null): RefreshDeps {
  return {
    getLastRebuild,
    now: () => Date.now(),
    getThresholdMs: getStaleThresholdMs,
    spawnCmd: async (argv) => {
      const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" })
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited
      return { exitCode, stderr }
    },
  }
}
