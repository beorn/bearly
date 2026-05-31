// Connection-time replay cap for the stdio adapter's daemon-inbox drain.
//
// On connect/wakeup the adapter drains its pending queue and forwards each event
// to Claude Code as a <channel> envelope. A large stale backlog used to be
// forwarded wholesale (tribe.fetch limit:500 looped until empty), which flooded
// long-running agent context on connect (km @km/tribe/19442-turn-start-fetch-context-flood).
//
// This module holds the pure forwarding policy: which drained events to surface.
// It is deliberately side-effect-free (no daemon, no I/O) so it can be unit-tested
// directly — the adapter module itself constructs an MCP server at import time.
//
// The caller still DRAINS every fetched row (the cursor advances regardless), so
// events not surfaced here never re-arrive — they are simply not replayed.

/** Max events surfaced as <channel> envelopes per drain pass. */
export const MAX_REPLAY_EVENTS = 100

/** Events older than this (by their `ts`) are drained but not replayed. 1 day. */
export const MAX_REPLAY_AGE_MS = 24 * 60 * 60 * 1000

export type ReplayCandidate = { ts?: string }

export type ReplaySelection<T> = {
  /** Events to surface, in input order, after age + count caps. */
  forward: T[]
  /** How many were dropped for being older than the age cap. */
  skippedOld: number
  /** How many were dropped for exceeding the count cap. */
  capped: number
}

/**
 * Decide which drained events to forward to the agent.
 *
 * - Drops events whose `ts` is older than `maxAgeMs` before `now`.
 * - Caps the surfaced count at `maxEvents` (excess counted in `capped`).
 * - Fails OPEN on a missing/unparseable `ts`: such events are kept, not silently
 *   dropped (a malformed timestamp must never hide a message).
 */
export function selectReplayEvents<T extends ReplayCandidate>(
  events: readonly T[],
  opts: { now: number; maxEvents?: number; maxAgeMs?: number },
): ReplaySelection<T> {
  const maxEvents = opts.maxEvents ?? MAX_REPLAY_EVENTS
  const maxAgeMs = opts.maxAgeMs ?? MAX_REPLAY_AGE_MS
  const cutoff = opts.now - maxAgeMs
  const forward: T[] = []
  let skippedOld = 0
  let capped = 0
  for (const event of events) {
    const ts = event.ts ? Date.parse(event.ts) : Number.NaN
    if (Number.isFinite(ts) && ts < cutoff) {
      skippedOld++
      continue
    }
    if (forward.length >= maxEvents) {
      capped++
      continue
    }
    forward.push(event)
  }
  return { forward, skippedOld, capped }
}
