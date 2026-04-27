import { describe, expect, test } from "vitest"
import { createThrottle } from "../src/throttle.ts"

describe("throttle", () => {
  test("blocks before calls-per-hint floor reached", () => {
    const t = createThrottle({ callsPerHint: 5, secondsPerHint: 60, maxBackoff: 4 })
    expect(t.allow("s1", 1000)).toBe(false)
    for (let i = 0; i < 4; i++) t.recordToolCall("s1")
    expect(t.allow("s1", 1000)).toBe(false)
    t.recordToolCall("s1")
    // first allowed event has lastHintMs=0; allow() after the floor should be true
    expect(t.allow("s1", 1000)).toBe(true)
  })

  test("blocks when too soon after last hint (cooldown)", () => {
    const t = createThrottle({ callsPerHint: 1, secondsPerHint: 60, maxBackoff: 4 })
    t.recordToolCall("s1")
    expect(t.allow("s1", 1000)).toBe(true)
    t.recordHint("s1", 1000)
    // Need callsPerHint=1 more calls before allowed by call-count
    t.recordToolCall("s1")
    expect(t.allow("s1", 30 * 1000)).toBe(false) // 30s < 60s cooldown
    expect(t.allow("s1", 61 * 1000)).toBe(true)
  })

  test("backoff doubles cooldown after consecutive low scores", () => {
    const t = createThrottle({ callsPerHint: 1, secondsPerHint: 1, maxBackoff: 4 })
    t.recordToolCall("s1")
    t.recordHint("s1", 0)
    t.recordToolCall("s1")
    expect(t.allow("s1", 1500)).toBe(true)
    t.recordLowScore("s1") // backoff=2x
    expect(t.allow("s1", 1500)).toBe(false)
    expect(t.allow("s1", 2500)).toBe(true)
    t.recordLowScore("s1") // backoff=4x
    expect(t.allow("s1", 3500)).toBe(false)
  })

  test("high-score event resets backoff", () => {
    const t = createThrottle({ callsPerHint: 1, secondsPerHint: 1, maxBackoff: 4 })
    t.recordToolCall("s1")
    t.recordHint("s1", 0)
    t.recordToolCall("s1")
    t.recordLowScore("s1")
    t.recordLowScore("s1") // backoff=4x = 4000ms
    expect(t.allow("s1", 2000)).toBe(false)
    t.recordHighScore("s1") // reset
    expect(t.allow("s1", 2000)).toBe(true)
  })

  test("isolates per-session counters", () => {
    const t = createThrottle({ callsPerHint: 3, secondsPerHint: 0, maxBackoff: 1 })
    for (let i = 0; i < 3; i++) t.recordToolCall("a")
    expect(t.allow("a", 0)).toBe(true)
    expect(t.allow("b", 0)).toBe(false)
  })

  test("inspect reports current state", () => {
    const t = createThrottle({ callsPerHint: 5, secondsPerHint: 60, maxBackoff: 4 })
    t.recordToolCall("s1")
    t.recordToolCall("s1")
    const r = t.inspect("s1")
    expect(r.calls).toBe(2)
    expect(r.sinceLastHintMs).toBe(Infinity)
  })

  test("100 tool calls with default config produces ≤10 hints", () => {
    const t = createThrottle()
    let hints = 0
    let now = 0
    for (let i = 0; i < 100; i++) {
      t.recordToolCall("s1")
      now += 100 // 100ms between calls → 10s total
      if (t.allow("s1", now)) {
        hints += 1
        t.recordHint("s1", now)
      }
    }
    // With callsPerHint=10 + secondsPerHint=60, the call-count floor allows
    // 10 hints, but the 60s cooldown caps it lower.
    expect(hints).toBeLessThanOrEqual(10)
  })
})
