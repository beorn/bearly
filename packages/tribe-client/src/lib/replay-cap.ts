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

/**
 * How long after a (re)connect the legacy `channel` content-push burst is bounded.
 * The flood (km 19442) is a connect-time replay storm, so the window only needs to
 * cover the burst — steady-state live traffic arrives later and passes freely.
 */
export const CONNECT_REPLAY_WINDOW_MS = 5_000

export type ConnectReplayGate = {
  /** Reset the window — call on every (re)connect. */
  reset(now: number): void
  /** Decide whether a `channel`-pushed event should be forwarded right now. */
  admit(now: number): boolean
  /** Events dropped within the current window (for a summary log). */
  readonly dropped: number
}

/**
 * Bound the legacy `channel` content-push burst a pre-`wakeup` daemon dumps
 * right after (re)connect (km 19442).
 *
 * In the wakeup-only delivery model the daemon never pushes content — it sends
 * `wakeup` nudges and the client drains via the (already capped) `selectReplayEvents`
 * path. This gate is the compat backstop for the OTHER path: a stale/old daemon
 * that still pushes message bodies as `channel` notifications. Within `windowMs`
 * of a (re)connect it forwards at most `maxEvents` and drops the rest — the dropped
 * rows stay durable in the daemon journal and remain fetchable via `tribe.fetch`.
 *
 * Outside the window — steady state — it forwards freely so a live actionable DM
 * is NEVER withheld. The gate only fires on the connect-burst it is named for.
 */
export function createConnectReplayGate(opts?: { maxEvents?: number; windowMs?: number }): ConnectReplayGate {
  const maxEvents = opts?.maxEvents ?? MAX_REPLAY_EVENTS
  const windowMs = opts?.windowMs ?? CONNECT_REPLAY_WINDOW_MS
  let connectAt = Number.NEGATIVE_INFINITY
  let forwarded = 0
  let droppedInWindow = 0
  return {
    reset(now: number): void {
      connectAt = now
      forwarded = 0
      droppedInWindow = 0
    },
    admit(now: number): boolean {
      // Steady state (outside the connect window, or before the first connect):
      // never withhold a live message.
      if (now - connectAt >= windowMs) return true
      if (forwarded >= maxEvents) {
        droppedInWindow++
        return false
      }
      forwarded++
      return true
    },
    get dropped(): number {
      return droppedInWindow
    },
  }
}
