/**
 * Chief derivation — pure helpers, no daemon state.
 *
 * Extracted from `tools/tribe-daemon.ts` so unit tests can exercise the
 * derivation logic without importing the daemon entry point (which has
 * top-level side effects: socket probe, DB open, plugin init, etc.).
 */

/** Minimal shape the derivation reads. Tests pass partial fixtures. */
export type ChiefCandidate = {
  name: string
  role: string
  registeredAt: number
  ctx: { sessionId: string }
}

/**
 * Chief eligibility by role. Only "chief" and "member" sessions participate
 * in the chief pool; "daemon", "watch", and "pending" never hold chief.
 *
 * This replaced the former name-prefix magic (`name.startsWith("watch-") …`)
 * in @bearly/tribe 0.10.1 — see km-tribe.polish-sweep item 2. Callers no
 * longer need to synthesize a `name` to get the right answer; only the role
 * tag is consulted.
 */
export function isChiefEligible(c: { role: string }): boolean {
  return c.role === "chief" || c.role === "member"
}

/**
 * Return the ctx.sessionId of the current chief, or null if nobody is eligible.
 *
 * Precedence:
 *   1. `claim` (if its session is still connected and eligible)
 *   2. longest-connected eligible client (smallest registeredAt)
 *      — ties broken by name alphabetical for reproducibility
 */
export function deriveChiefId<C extends ChiefCandidate>(candidates: Iterable<C>, claim: string | null): string | null {
  const list = Array.from(candidates).filter(isChiefEligible)
  if (claim !== null) {
    const claimer = list.find((c) => c.ctx.sessionId === claim)
    if (claimer) return claimer.ctx.sessionId
    // claim stale (session disconnected) — fall through to derivation
  }
  if (list.length === 0) return null
  const sorted = [...list].sort((a, b) => {
    if (a.registeredAt !== b.registeredAt) return a.registeredAt - b.registeredAt
    return a.name.localeCompare(b.name)
  })
  return sorted[0]!.ctx.sessionId
}

export function deriveChiefInfo<C extends ChiefCandidate>(
  candidates: Iterable<C>,
  claim: string | null,
): { id: string; name: string; claimed: boolean } | null {
  const id = deriveChiefId(candidates, claim)
  if (!id) return null
  const list = Array.from(candidates)
  const client = list.find((c) => c.ctx.sessionId === id)
  if (!client) return null
  return { id, name: client.name, claimed: claim === id }
}
