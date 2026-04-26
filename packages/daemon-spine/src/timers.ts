/**
 * Managed timers — all timers tied to an AbortSignal for automatic cleanup.
 *
 * Prevents timer leaks: on abort(), all timers are cleared and unref'd.
 * Internal helper used by the spine client; not part of the public surface.
 */

export type ManagedTimers = {
  setTimeout(fn: () => void, ms: number): ReturnType<typeof globalThis.setTimeout>
  setInterval(fn: () => void, ms: number): ReturnType<typeof globalThis.setInterval>
  clearTimeout(t: ReturnType<typeof globalThis.setTimeout>): void
  clearInterval(t: ReturnType<typeof globalThis.setInterval>): void
  delay(ms: number): Promise<void>
}

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
    setTimeout(fn, ms) {
      if (signal.aborted) return null as unknown as ReturnType<typeof globalThis.setTimeout>
      const t = globalThis.setTimeout(() => {
        timeouts.delete(t)
        if (!signal.aborted) fn()
      }, ms)
      ;(t as { unref?: () => void }).unref?.()
      timeouts.add(t)
      return t
    },

    setInterval(fn, ms) {
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

    clearTimeout(t) {
      globalThis.clearTimeout(t)
      timeouts.delete(t)
    },

    clearInterval(t) {
      globalThis.clearInterval(t)
      intervals.delete(t)
    },

    delay(ms) {
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
