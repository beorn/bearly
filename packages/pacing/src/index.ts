/**
 * Pacing primitives: when to try again, and when a dependency is ready.
 *
 * Pure policy. Nothing here owns a clock, a timer, a socket or a process: the caller passes `now`, `sleep`, its probe
 * and, for tests, its random source. That keeps every reconnect and restart loop on one set of well-known patterns
 * (full jitter, decorrelated jitter, readiness gating) without moving anyone's I/O.
 */

/** A source of uniform numbers in [0, 1). Defaults to Math.random; tests pass a seeded one. */
export type RandomUnit = () => number

function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be a finite number, got ${value}`)
}

/**
 * Full jitter (AWS "exponential backoff and jitter"): uniform in [0, min(cap, base * 2 ** attempt)].
 * attempt 0 is the first retry. A caller that wants a plain spread over a window passes base = cap = window.
 */
export function fullJitter(base: number, cap: number, attempt: number, random: RandomUnit = Math.random): number {
  requireFinite("base", base)
  requireFinite("cap", cap)
  if (base < 0) throw new RangeError(`fullJitter base must be >= 0, got ${base}`)
  if (cap < base) throw new RangeError(`fullJitter cap (${cap}) must be >= base (${base})`)
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new RangeError(`fullJitter attempt must be a non-negative integer, got ${attempt}`)
  }
  // A zero base is a zero delay: 0 * 2 ** 1024 would be 0 * Infinity, which is NaN.
  const ceiling = base === 0 ? 0 : Math.min(cap, base * 2 ** attempt)
  return ceiling * random()
}

/**
 * Decorrelated jitter: uniform in [base, min(cap, previous * 3)], where previous is the last delay this returned
 * (base on the first call). Never below base, never above cap. The bounds come first and the per-call state last,
 * the same order as fullJitter.
 */
export function decorrelatedJitter(
  base: number,
  cap: number,
  previous: number,
  random: RandomUnit = Math.random,
): number {
  requireFinite("previous", previous)
  requireFinite("base", base)
  requireFinite("cap", cap)
  if (base <= 0) throw new RangeError(`decorrelatedJitter base must be > 0, got ${base}`)
  if (cap < base) throw new RangeError(`decorrelatedJitter cap (${cap}) must be >= base (${base})`)
  if (previous < base) throw new RangeError(`decorrelatedJitter previous (${previous}) must be >= base (${base})`)
  const ceiling = Math.min(cap, previous * 3)
  return base + (ceiling - base) * random()
}

export type ReadinessOutcome =
  | { readonly ready: true; readonly attempts: number; readonly waitedMs: number }
  | { readonly ready: false; readonly attempts: number; readonly waitedMs: number; readonly lastError?: unknown }

export interface ReadinessOptions {
  /** A duration: how long after the gate's first now() it keeps probing. */
  readonly timeoutMs: number
  readonly retryMs: number
  /** Default: retryMs * 8. */
  readonly maxRetryMs?: number
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly random?: RandomUnit
}

/**
 * Readiness gate: calls probe until it resolves true or timeoutMs has passed since the gate's first now().
 *
 * The probe must bound itself. The gate checks the timeout only between probes, so a probe that never settles holds
 * the gate past its timeout, forever. Give every probe its own timeout (a call timeout on the socket, an
 * AbortSignal.timeout on the fetch) that is shorter than timeoutMs.
 *
 * - The first probe runs at once, with no sleep.
 * - Between probes it sleeps by decorrelated jitter from retryMs up to maxRetryMs, clipped so it never sleeps past
 *   the timeout; the last probe therefore runs at or before the timeout, after that clipped sleep.
 * - ready: false is returned only after that final probe. A probe that throws counts as not ready, and the last
 *   error is returned with it.
 */
export async function awaitReady(probe: () => Promise<boolean>, opts: ReadinessOptions): Promise<ReadinessOutcome> {
  const { timeoutMs, retryMs, now, sleep, random = Math.random } = opts
  const maxRetryMs = opts.maxRetryMs ?? retryMs * 8
  requireFinite("timeoutMs", timeoutMs)
  requireFinite("retryMs", retryMs)
  requireFinite("maxRetryMs", maxRetryMs)
  if (timeoutMs < 0) throw new RangeError(`awaitReady timeoutMs must be >= 0, got ${timeoutMs}`)
  if (retryMs <= 0) throw new RangeError(`awaitReady retryMs must be > 0, got ${retryMs}`)
  if (maxRetryMs < retryMs)
    {throw new RangeError(`awaitReady maxRetryMs (${maxRetryMs}) must be >= retryMs (${retryMs})`)}

  const started = now()
  let attempts = 0
  let delay = retryMs
  let lastError: unknown
  let failed = false
  for (;;) {
    attempts++
    try {
      if (await probe()) return { ready: true, attempts, waitedMs: now() - started }
    } catch (error) {
      failed = true
      lastError = error
    }
    const remaining = timeoutMs - (now() - started)
    if (remaining <= 0) {
      const waitedMs = now() - started
      return failed ? { ready: false, attempts, waitedMs, lastError } : { ready: false, attempts, waitedMs }
    }
    delay = decorrelatedJitter(retryMs, maxRetryMs, delay, random)
    await sleep(Math.min(delay, remaining))
  }
}
