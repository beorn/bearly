/**
 * Pacing primitives: pure delay and readiness policy, with no clock, timer or I/O inside.
 *
 * Each function has one witness for its contract, plus properties over seeded randoms: a delay never exceeds
 * its cap, and the gate never sleeps past its timeout.
 */

import { describe, expect, test } from "vitest"
import { awaitReady, decorrelatedJitter, fullJitter, type RandomUnit } from "../src/index.ts"

/** Deterministic uniform numbers in [0, 1): a mulberry32 stream. */
function seeded(seed: number): RandomUnit {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe("fullJitter", () => {
  test("is uniform in [0, min(cap, base * 2 ** attempt)]", () => {
    expect(fullJitter(100, 10_000, 0, () => 0)).toBe(0)
    expect(fullJitter(100, 10_000, 0, () => 0.5)).toBe(50)
    expect(fullJitter(100, 10_000, 3, () => 0.5)).toBe(400)
    expect(fullJitter(100, 1_000, 10, () => 0.5)).toBe(500)
  })

  test("a window spread is base = cap = window", () => {
    const random = seeded(1)
    for (let i = 0; i < 1_000; i++) {
      const delay = fullJitter(60_000, 60_000, 0, random)
      expect(delay).toBeGreaterThanOrEqual(0)
      expect(delay).toBeLessThan(60_000)
    }
  })

  test("never exceeds its cap, at any attempt", () => {
    const random = seeded(2)
    for (let attempt = 0; attempt < 64; attempt++) {
      expect(fullJitter(250, 30_000, attempt, random)).toBeLessThanOrEqual(30_000)
    }
  })

  test("refuses bounds that name no delay", () => {
    expect(() => fullJitter(-1, 10, 0)).toThrow(RangeError)
    expect(() => fullJitter(10, 5, 0)).toThrow(RangeError)
    expect(() => fullJitter(10, 20, -1)).toThrow(RangeError)
    expect(() => fullJitter(10, 20, 1.5)).toThrow(RangeError)
    expect(() => fullJitter(Number.NaN, 20, 0)).toThrow(RangeError)
    expect(() => fullJitter(10, Number.POSITIVE_INFINITY, 0)).toThrow(RangeError)
  })

  test("a zero base is a zero delay at every attempt, never NaN from 0 * 2 ** 1024", () => {
    for (const attempt of [0, 1_023, 1_024, 5_000]) expect(fullJitter(0, 1_000, attempt, () => 0.5)).toBe(0)
  })
})

describe("decorrelatedJitter", () => {
  test("is uniform in [base, min(cap, previous * 3)]", () => {
    expect(decorrelatedJitter(100, 10_000, 100, () => 0)).toBe(100)
    expect(decorrelatedJitter(100, 10_000, 100, () => 0.5)).toBe(200)
    expect(decorrelatedJitter(100, 10_000, 1_000, () => 0.5)).toBe(1_550)
    expect(decorrelatedJitter(100, 10_000, 9_000, () => 0.5)).toBe(5_050)
  })

  test("a chain never leaves [base, cap]", () => {
    const random = seeded(3)
    let delay = 500
    for (let i = 0; i < 1_000; i++) {
      delay = decorrelatedJitter(500, 30_000, delay, random)
      expect(delay).toBeGreaterThanOrEqual(500)
      expect(delay).toBeLessThanOrEqual(30_000)
    }
  })

  test("refuses bounds that name no delay", () => {
    expect(() => decorrelatedJitter(0, 10, 100)).toThrow(RangeError)
    expect(() => decorrelatedJitter(50, 10, 100)).toThrow(RangeError)
    expect(() => decorrelatedJitter(50, 100, 10)).toThrow(RangeError)
    expect(() => decorrelatedJitter(Number.NaN, 10, 10)).toThrow(/base must be a finite number/u)
    expect(() => decorrelatedJitter(5, Number.POSITIVE_INFINITY, 5)).toThrow(/cap must be a finite number/u)
    expect(() => decorrelatedJitter(5, 10, Number.NaN)).toThrow(/previous must be a finite number/u)
  })
})

describe("awaitReady", () => {
  /** A fake clock the gate drives through its injected sleep. */
  function clock() {
    let now = 0
    const sleeps: number[] = []
    return {
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms)
        now += ms
      },
      sleeps,
    }
  }

  test("returns ready on the first probe that answers true, counting its attempts", async () => {
    const time = clock()
    let calls = 0
    const outcome = await awaitReady(async () => ++calls >= 3, {
      timeoutMs: 10_000,
      retryMs: 100,
      now: time.now,
      sleep: time.sleep,
      random: () => 0,
    })
    expect(outcome).toEqual({ ready: true, attempts: 3, waitedMs: 200 })
  })

  test("a probe that throws is not ready, and the last error is returned after the final probe at the timeout", async () => {
    const time = clock()
    const outcome = await awaitReady(
      async () => {
        throw new Error(`refused at ${time.now()}`)
      },
      { timeoutMs: 1_000, retryMs: 100, now: time.now, sleep: time.sleep, random: seeded(4) },
    )
    expect(outcome.ready).toBe(false)
    expect(outcome.waitedMs).toBe(1_000)
    expect(outcome.ready === false && (outcome.lastError as Error).message).toBe(`refused at ${time.now()}`)
  })

  test("the first probe runs at once, and it never sleeps past its timeout", async () => {
    for (let seed = 0; seed < 50; seed++) {
      const time = clock()
      await awaitReady(async () => false, {
        timeoutMs: 2_345,
        retryMs: 100,
        maxRetryMs: 5_000,
        now: time.now,
        sleep: time.sleep,
        random: seeded(seed),
      })
      expect(time.now()).toBe(2_345)
      expect(time.sleeps.reduce((a, b) => a + b, 0)).toBe(2_345)
    }
    const time = clock()
    await awaitReady(async () => true, { timeoutMs: 1_000, retryMs: 100, now: time.now, sleep: time.sleep })
    expect(time.sleeps).toEqual([])
  })

  test.each([
    ["timeoutMs", { timeoutMs: -1 }, /timeoutMs must be >= 0/u],
    ["timeoutMs", { timeoutMs: Number.NaN }, /timeoutMs must be a finite number/u],
    ["retryMs", { retryMs: 0 }, /retryMs must be > 0/u],
    ["retryMs", { retryMs: Number.NaN }, /retryMs must be a finite number/u],
    ["maxRetryMs", { maxRetryMs: 50 }, /maxRetryMs \(50\) must be >= retryMs \(100\)/u],
    ["maxRetryMs", { maxRetryMs: Number.POSITIVE_INFINITY }, /maxRetryMs must be a finite number/u],
  ])("refuses a %s that names no delay before the first probe: %o", async (_name, bad, message) => {
    const time = clock()
    let probes = 0
    const gate = awaitReady(
      async () => {
        probes++
        return true
      },
      { timeoutMs: 1_000, retryMs: 100, now: time.now, sleep: time.sleep, ...bad },
    )
    await expect(gate).rejects.toThrow(RangeError)
    await expect(gate).rejects.toThrow(message)
    expect(probes).toBe(0)
  })
})
