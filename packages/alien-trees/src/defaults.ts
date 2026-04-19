/**
 * Default strategy resolution.
 *
 * The DSL captures descriptor shape (dir + type). The engine picks a strategy
 * based on that shape — this module is the single classifier, so one grep
 * shows what defaults exist.
 *
 * Current policy:
 *
 *   dir='down' + type='some'     → sparse   (O(1) read, O(depth) write)
 *   dir='down' + type='count'    → sparse   (same index as some)
 *   dir='down' + type='reduce'   → walk     (needs actual values)
 *   dir='up'   + any type        → walk     (ancestors are already O(depth))
 *
 * Strategies are an internal implementation detail — users don't pick, the
 * engine does. Matches alien-projections / alien-resources: one API, one
 * obvious way. If the defaults turn out wrong for a real workload, the fix
 * goes here (update the classifier), not as a public plugin surface.
 */

import type { Descriptor } from "./types.js"
import type { Strategy } from "./strategy.js"
import { sparse } from "./strategies/sparse.js"
import { walk } from "./strategies/walk.js"

export function resolveDefaultStrategy(desc: Descriptor): Strategy {
  if (desc.dir === "down" && (desc.type === "some" || desc.type === "count")) return sparse
  return walk
}
