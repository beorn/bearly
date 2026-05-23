/**
 * `withIdleQuit` — zero-clients countdown (`@km/agent/15071`).
 *
 * The bead asked for `--max-idle-seconds <N>` with the semantic "shut down
 * after N seconds of zero active clients." Reality check: the existing
 * `--quit-timeout <N>` flag *already* provides exactly that semantic. These
 * tests pin the contract so a future refactor can't silently regress it:
 *
 *   - On startup with no clients, the countdown begins immediately and
 *     fires `triggerShutdown` after `quitTimeoutSec` seconds.
 *   - `markActive()` (called from `withDispatcher`'s accept handler) cancels
 *     the countdown.
 *   - `markIdle()` (called when the client registry empties on disconnect)
 *     restarts the countdown — *not* "permanently disables it after the
 *     first connect," which was the bead's incorrect premise.
 *   - `quitTimeoutSec < 0` disables the countdown entirely (test-fixture
 *     escape hatch). Test fixtures that historically passed `-1` should
 *     migrate to a positive value as a backstop against crashes (see the
 *     companion change in `tribe-durability.slow.test.ts` et al).
 *
 * Sibling test:
 * `with-idle-quit-socket-path-watch.test.ts` — exercises the disk-gone
 * backstop, which uses a separate deadline. Both backstops compose: either
 * may fire first depending on which signal trips.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { withIdleQuit, type IdleQuitOpts } from "../tools/lib/tribe/compose/with-idle-quit.ts"

interface FakeClock {
  now: () => number
  advance: (ms: number) => void
}

function createFakeClock(start = 1_000): FakeClock {
  let clock = start
  return {
    now: () => clock,
    advance(ms: number) {
      clock += ms
    },
  }
}

interface FakeScheduler {
  drain: () => void
}

function withFakeInterval(): FakeScheduler {
  const tickFns: Array<() => void> = []
  globalThis.setInterval = ((fn: () => void) => {
    tickFns.push(fn)
    return { unref: () => {} } as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval
  globalThis.clearInterval = (() => {}) as typeof clearInterval
  return {
    drain() {
      for (const fn of tickFns) fn()
    },
  }
}

interface FakeTribeOpts {
  quitTimeoutSec: number
  clientCount: number
}

function makeFakeTribe(opts: FakeTribeOpts) {
  return {
    scope: { defer(_fn: () => void) {}, _deferred: [] as Array<() => void> },
    config: {
      socketPath: "/tmp/tribe-fake.sock",
      inheritFd: null as number | null,
      quitTimeoutSec: opts.quitTimeoutSec,
    },
    registry: {
      clients: {
        size: opts.clientCount,
        [Symbol.iterator]() {
          return [].values()
        },
      } as any,
      socketToClient: new Map(),
    },
  }
}

describe("@km/agent/15071 withIdleQuit — zero-clients countdown", () => {
  // Same convention as the sibling test file: suppress log.warn fallback
  // so vitest's console gate doesn't fail the suite.
  let warnSpy: ReturnType<typeof vi.spyOn>
  let infoSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
    infoSpy.mockRestore()
    globalThis.setInterval = setInterval
    globalThis.clearInterval = clearInterval
  })

  test("startup with no clients begins countdown immediately", () => {
    const clock = createFakeClock()
    const scheduler = withFakeInterval()
    const triggerShutdown = vi.fn()
    const tribe = makeFakeTribe({ quitTimeoutSec: 5, clientCount: 0 })
    const opts: IdleQuitOpts = {
      triggerShutdown,
      now: clock.now,
      // Disable the socket-path backstop so we isolate the deadline path.
      socketPathGoneTimeoutMs: 0,
    }
    const result = withIdleQuit(opts)(tribe as never)

    // Initial deadline set ~5s out at startup (constructor called markIdle).
    const deadline = result.idleQuit.getDeadline()
    expect(deadline).not.toBeNull()
    expect(deadline! - clock.now()).toBe(5_000)

    // Advance just below the deadline → no fire.
    clock.advance(4_999)
    scheduler.drain()
    expect(triggerShutdown).not.toHaveBeenCalled()

    // Cross the deadline → fires.
    clock.advance(2)
    scheduler.drain()
    expect(triggerShutdown).toHaveBeenCalledTimes(1)
  })

  test("markActive cancels the countdown", () => {
    const clock = createFakeClock()
    const scheduler = withFakeInterval()
    const triggerShutdown = vi.fn()
    const tribe = makeFakeTribe({ quitTimeoutSec: 5, clientCount: 0 })
    const result = withIdleQuit({
      triggerShutdown,
      now: clock.now,
      socketPathGoneTimeoutMs: 0,
    })(tribe as never)

    // Client connects → markActive clears the deadline.
    result.idleQuit.markActive()
    expect(result.idleQuit.getDeadline()).toBeNull()

    // Time passes; without an active deadline, no fire.
    clock.advance(60_000)
    scheduler.drain()
    expect(triggerShutdown).not.toHaveBeenCalled()
  })

  test("markIdle after markActive restarts the countdown — NOT permanently disabled", () => {
    // This is the contract the bead's premise denied. The original bead
    // claimed: "once a client connects (even briefly), the timer is
    // permanently disabled." That is false. markIdle re-arms it on
    // every registry-empties transition.
    const clock = createFakeClock()
    const scheduler = withFakeInterval()
    const triggerShutdown = vi.fn()
    const tribe = makeFakeTribe({ quitTimeoutSec: 5, clientCount: 0 })
    const result = withIdleQuit({
      triggerShutdown,
      now: clock.now,
      socketPathGoneTimeoutMs: 0,
    })(tribe as never)

    // Mimic a connect-then-disconnect cycle.
    result.idleQuit.markActive() // client connected
    expect(result.idleQuit.getDeadline()).toBeNull()
    clock.advance(10_000) // long-running activity
    result.idleQuit.markIdle() // client disconnected
    const deadlineAfterDisconnect = result.idleQuit.getDeadline()
    expect(deadlineAfterDisconnect).not.toBeNull()
    expect(deadlineAfterDisconnect! - clock.now()).toBe(5_000)

    // Now run the countdown to completion.
    clock.advance(5_001)
    scheduler.drain()
    expect(triggerShutdown).toHaveBeenCalledTimes(1)
  })

  test("quitTimeoutSec === -1 disables the countdown entirely (test escape hatch)", () => {
    const clock = createFakeClock()
    const scheduler = withFakeInterval()
    const triggerShutdown = vi.fn()
    const tribe = makeFakeTribe({ quitTimeoutSec: -1, clientCount: 0 })
    const result = withIdleQuit({
      triggerShutdown,
      now: clock.now,
      socketPathGoneTimeoutMs: 0,
    })(tribe as never)

    // No deadline armed at startup despite zero clients.
    expect(result.idleQuit.getDeadline()).toBeNull()

    // markIdle is a no-op under -1.
    result.idleQuit.markIdle()
    expect(result.idleQuit.getDeadline()).toBeNull()

    clock.advance(120_000)
    scheduler.drain()
    expect(triggerShutdown).not.toHaveBeenCalled()
  })

  test("quitTimeoutSec === 0 fires immediately on idle", () => {
    const clock = createFakeClock()
    const scheduler = withFakeInterval()
    const triggerShutdown = vi.fn()
    const tribe = makeFakeTribe({ quitTimeoutSec: 0, clientCount: 0 })
    const result = withIdleQuit({
      triggerShutdown,
      now: clock.now,
      socketPathGoneTimeoutMs: 0,
    })(tribe as never)

    // Deadline is set to "now" — the very next tick fires.
    const deadline = result.idleQuit.getDeadline()
    expect(deadline).toBe(clock.now())

    scheduler.drain()
    expect(triggerShutdown).toHaveBeenCalledTimes(1)
  })

  test("a second markActive while already active is a no-op (idempotent)", () => {
    const clock = createFakeClock()
    const scheduler = withFakeInterval()
    const triggerShutdown = vi.fn()
    const tribe = makeFakeTribe({ quitTimeoutSec: 5, clientCount: 0 })
    const result = withIdleQuit({
      triggerShutdown,
      now: clock.now,
      socketPathGoneTimeoutMs: 0,
    })(tribe as never)

    result.idleQuit.markActive()
    expect(result.idleQuit.getDeadline()).toBeNull()
    result.idleQuit.markActive() // second call
    expect(result.idleQuit.getDeadline()).toBeNull()

    clock.advance(120_000)
    scheduler.drain()
    expect(triggerShutdown).not.toHaveBeenCalled()
  })

  test("markIdle called twice does not extend or reset an existing deadline", () => {
    // Once a deadline is set, a second markIdle should be a no-op — not
    // bump the deadline forward. This is what the source comment says
    // ("already counting down") and what the test enforces.
    const clock = createFakeClock()
    const scheduler = withFakeInterval()
    const triggerShutdown = vi.fn()
    const tribe = makeFakeTribe({ quitTimeoutSec: 5, clientCount: 0 })
    const result = withIdleQuit({
      triggerShutdown,
      now: clock.now,
      socketPathGoneTimeoutMs: 0,
    })(tribe as never)

    const deadline1 = result.idleQuit.getDeadline()
    clock.advance(3_000)
    result.idleQuit.markIdle() // second call — should NOT push deadline
    const deadline2 = result.idleQuit.getDeadline()
    expect(deadline2).toBe(deadline1) // unchanged

    // Fire at the original deadline (~2s remaining).
    clock.advance(2_001)
    scheduler.drain()
    expect(triggerShutdown).toHaveBeenCalledTimes(1)
  })
})
