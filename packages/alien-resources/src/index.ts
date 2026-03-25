/**
 * alien-resources — Async signal bridge for alien-signals.
 *
 * Wraps async fetchers into reactive signals with loading/error states
 * and automatic cancellation. When signals read inside the fetcher change,
 * the resource automatically re-fetches (cancelling any in-flight request).
 *
 * @example
 * ```ts
 * import { signal, effect } from "alien-signals"
 * import { createResource } from "alien-resources"
 *
 * const userId = signal("user-1")
 * const profile = createResource(async (abortSignal) => {
 *   const res = await fetch(`/api/users/${userId()}`, { signal: abortSignal })
 *   return res.json()
 * })
 *
 * effect(() => {
 *   if (profile.loading()) console.log("Loading...")
 *   else if (profile.error()) console.log("Error:", profile.error())
 *   else console.log("Data:", profile())
 * })
 * ```
 */

import { signal, effect } from "alien-signals"

/** Options for createResource. */
export interface ResourceOptions<T> {
  /** Initial data value (default: undefined). */
  initialValue?: T
}

/** A fetcher receives an AbortSignal for cancellation support. */
export type ResourceFetcher<T> = (abort: AbortSignal) => Promise<T>

/** Readable signal — call to get value. */
export interface ReadSignal<T> {
  (): T
}

/** Resource signal — callable for data, with loading/error/refetch/mutate. */
export interface Resource<T> {
  /** Read the current data (undefined while loading, unless initialValue was provided). */
  (): T | undefined

  /** Whether a fetch is currently in progress. */
  loading: ReadSignal<boolean>

  /** The error from the last fetch, or null if successful. */
  error: ReadSignal<Error | null>

  /** Manually trigger a re-fetch. */
  refetch(): void

  /** Optimistically set data. Reset on next fetch completion. */
  mutate(value: T): void

  /** Dispose the resource — stops tracking and cancels in-flight fetches. */
  dispose(): void
}

/**
 * Create a reactive resource that tracks an async fetcher.
 *
 * The fetcher runs inside an effect tracking context — any alien-signals
 * signals read during its synchronous preamble (before the first `await`)
 * become dependencies. When those dependencies change, the fetcher re-runs
 * automatically, cancelling any in-flight request via AbortController.
 *
 * @param fetcher - Async function that produces data. Receives an AbortSignal.
 * @param options - Optional configuration (initialValue).
 * @returns A Resource signal.
 */
export function createResource<T>(fetcher: ResourceFetcher<T>, options?: ResourceOptions<T>): Resource<T> {
  const _data = signal<T | undefined>(options?.initialValue)
  const _loading = signal(false)
  const _error = signal<Error | null>(null)

  // Monotonic fetch ID — only the latest fetch writes state.
  let fetchId = 0
  let abortController: AbortController | null = null

  // Bump to force effect re-run on manual refetch().
  const _refetchTrigger = signal(0)

  function startFetch() {
    // Cancel any in-flight request.
    if (abortController) {
      abortController.abort()
      abortController = null
    }

    const id = ++fetchId
    const controller = new AbortController()
    abortController = controller

    _loading(true)
    _error(null)

    void fetcher(controller.signal).then(
      (result) => {
        // Only apply if this is still the latest fetch.
        if (id !== fetchId) return
        _data(result)
        _loading(false)
        abortController = null
        return
      },
      (err) => {
        // Ignore superseded requests.
        if (id !== fetchId) return
        // Ignore aborts we initiated.
        if (err instanceof DOMException && err.name === "AbortError") return
        _error(err instanceof Error ? err : new Error(String(err)))
        _loading(false)
        abortController = null
        return
      },
    )
  }

  // The effect tracks signal reads in the fetcher's synchronous preamble
  // (before the first await). When those deps change, the effect re-runs,
  // which calls startFetch() again (aborting the previous in-flight request).
  const disposeEffect = effect(() => {
    // Read the refetch trigger so manual refetch() causes re-run.
    _refetchTrigger()
    startFetch()
  })

  // Build the resource callable — reads propagate tracking to the caller.
  const resource = (() => _data()) as Resource<T>

  resource.loading = (() => _loading()) as ReadSignal<boolean>
  resource.error = (() => _error()) as ReadSignal<Error | null>

  resource.refetch = () => {
    _refetchTrigger(_refetchTrigger() + 1)
  }

  resource.mutate = (value: T) => {
    _data(value)
  }

  resource.dispose = () => {
    disposeEffect()
    if (abortController) {
      abortController.abort()
      abortController = null
    }
  }

  return resource
}
