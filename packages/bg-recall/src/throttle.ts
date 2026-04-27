/**
 * Per-session throttle — caps hint emissions to prevent storms.
 *
 * Two limits, both enforced:
 *  - max 1 hint per N tool calls (default: 10)
 *  - max 1 hint per M seconds (default: 60s)
 *
 * Plus exponential backoff: each consecutive low-relevance trigger doubles the
 * cooldown (capped at 4× base) so a hot loop of bad recall doesn't burn budget
 * even if a fluke high-score hit slips in.
 *
 * State is per-session and ephemeral — a daemon restart resets all counters.
 */

export type ThrottleConfig = {
  /** Min tool calls between hints. Default 10. */
  callsPerHint: number
  /** Min seconds between hints. Default 60. */
  secondsPerHint: number
  /** Max backoff multiplier (e.g. 4 = up to 4× base cooldown). Default 4. */
  maxBackoff: number
}

export const DEFAULT_THROTTLE: ThrottleConfig = {
  callsPerHint: 10,
  secondsPerHint: 60,
  maxBackoff: 4,
}

type SessionState = {
  callsSinceLastHint: number
  lastHintMs: number
  /** Distinct from `lastHintMs===0` so callers can recordHint(sid, 0) in tests. */
  hasFired: boolean
  consecutiveLowScore: number
}

export type Throttle = {
  /** Returns true if a hint MAY fire for this session right now. */
  allow(sessionId: string, now?: number): boolean
  /** Mark a hint as having fired — resets counters. */
  recordHint(sessionId: string, now?: number): void
  /** Mark a tool call as observed (advances the calls counter). */
  recordToolCall(sessionId: string): void
  /** Tell the throttle a candidate scored below threshold — bumps backoff. */
  recordLowScore(sessionId: string): void
  /** A high-scoring hit landed — clear the backoff. */
  recordHighScore(sessionId: string): void
  /** Inspect a session's current throttle state — for status/debugging. */
  inspect(sessionId: string): { calls: number; sinceLastHintMs: number; backoffMs: number }
}

export function createThrottle(config: ThrottleConfig = DEFAULT_THROTTLE): Throttle {
  const state = new Map<string, SessionState>()

  function ensure(sessionId: string): SessionState {
    let s = state.get(sessionId)
    if (!s) {
      s = { callsSinceLastHint: 0, lastHintMs: 0, hasFired: false, consecutiveLowScore: 0 }
      state.set(sessionId, s)
    }
    return s
  }

  function backoffMs(s: SessionState): number {
    const factor = Math.min(config.maxBackoff, 2 ** s.consecutiveLowScore)
    return config.secondsPerHint * 1000 * factor
  }

  return {
    allow(sessionId, now = Date.now()) {
      const s = ensure(sessionId)
      // First-call: still need to satisfy calls-per-hint floor before firing.
      if (s.callsSinceLastHint < config.callsPerHint) return false
      // No cooldown applies before the first hint has ever fired.
      if (!s.hasFired) return true
      const elapsed = now - s.lastHintMs
      if (elapsed < backoffMs(s)) return false
      return true
    },
    recordHint(sessionId, now = Date.now()) {
      const s = ensure(sessionId)
      s.callsSinceLastHint = 0
      s.lastHintMs = now
      s.hasFired = true
      // Hint fired — clear backoff (a fired hint = the threshold logic
      // accepted it, so the session isn't in a bad-recall loop).
      s.consecutiveLowScore = 0
    },
    recordToolCall(sessionId) {
      const s = ensure(sessionId)
      s.callsSinceLastHint += 1
    },
    recordLowScore(sessionId) {
      const s = ensure(sessionId)
      s.consecutiveLowScore += 1
    },
    recordHighScore(sessionId) {
      const s = ensure(sessionId)
      s.consecutiveLowScore = 0
    },
    inspect(sessionId) {
      const s = ensure(sessionId)
      return {
        calls: s.callsSinceLastHint,
        sinceLastHintMs: !s.hasFired ? Infinity : Date.now() - s.lastHintMs,
        backoffMs: backoffMs(s),
      }
    },
  }
}
