/**
 * Managed timers — all timers tied to an AbortSignal for automatic cleanup.
 *
 * Prevents timer leaks: on abort(), all timers are cleared and unref'd.
 * Every setTimeout/setInterval in tribe code should use this instead of globals.
 */

export type ManagedTimers = {
  setTimeout(fn: () => void, ms: number): ReturnType<typeof globalThis.setTimeout>
  setInterval(fn: () => void, ms: number): ReturnType<typeof globalThis.setInterval>
  clearTimeout(t: ReturnType<typeof globalThis.setTimeout>): void
  clearInterval(t: ReturnType<typeof globalThis.setInterval>): void
  /** Delay that auto-cancels on abort (for async loops) */
  delay(ms: number): Promise<void>
}

/** Create a timer manager bound to an AbortSignal. All timers auto-cleanup on abort. */
export function createTimers(signal: AbortSignal): ManagedTimers {
  const timeouts = new Set<ReturnType<typeof globalThis.setTimeout>>()
  const intervals = new Set<ReturnType<typeof globalThis.setInterval>>()

  signal.addEventListener(
    "abort",
    () => {
      for (const t of timeouts) globalThis.clearTimeout(t)
      for (const t of intervals) globalThis.clearInterval(t)
      timeouts.clear()
      intervals.clear()
    },
    { once: true },
  )

  return {
    setTimeout(fn: () => void, ms: number) {
      if (signal.aborted) return null as unknown as ReturnType<typeof globalThis.setTimeout>
      const t = globalThis.setTimeout(() => {
        timeouts.delete(t)
        if (!signal.aborted) fn()
      }, ms)
      ;(t as { unref?: () => void }).unref?.()
      timeouts.add(t)
      return t
    },

    setInterval(fn: () => void, ms: number) {
      if (signal.aborted) return null as unknown as ReturnType<typeof globalThis.setInterval>
      const t = globalThis.setInterval(() => {
        if (signal.aborted) {
          globalThis.clearInterval(t)
          intervals.delete(t)
          return
        }
        fn()
      }, ms)
      ;(t as { unref?: () => void }).unref?.()
      intervals.add(t)
      return t
    },

    clearTimeout(t: ReturnType<typeof globalThis.setTimeout>) {
      globalThis.clearTimeout(t)
      timeouts.delete(t)
    },

    clearInterval(t: ReturnType<typeof globalThis.setInterval>) {
      globalThis.clearInterval(t)
      intervals.delete(t)
    },

    delay(ms: number): Promise<void> {
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason)
          return
        }
        const t = globalThis.setTimeout(resolve, ms)
        ;(t as { unref?: () => void }).unref?.()
        timeouts.add(t)
        signal.addEventListener(
          "abort",
          () => {
            globalThis.clearTimeout(t)
            timeouts.delete(t)
            reject(signal.reason)
          },
          { once: true },
        )
      })
    },
  }
}
