import { describe, expect, it, vi } from "vitest"
import { signal, effect } from "alien-signals"
import { createResource, type Resource } from "../src/index.js"

/** Helper: create a deferred promise for fine-grained control. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Helper: flush microtasks so promise callbacks run. */
async function flush() {
  await new Promise<void>((r) => queueMicrotask(r))
}

/** Helper: collect values emitted by a resource in an effect. */
function collectEffect<T>(fn: () => T): T[] {
  const values: T[] = []
  effect(() => {
    values.push(fn())
  })
  return values
}

describe("createResource", () => {
  it("fetches data and makes it available via resource()", async () => {
    const resource = createResource(async () => "hello")

    // Initially loading
    expect(resource()).toBe(undefined)
    expect(resource.loading()).toBe(true)
    expect(resource.error()).toBe(null)

    await flush()

    expect(resource()).toBe("hello")
    expect(resource.loading()).toBe(false)
    expect(resource.error()).toBe(null)

    resource.dispose()
  })

  it("tracks loading state during fetch", async () => {
    const d = deferred<string>()
    const resource = createResource(async () => d.promise)

    expect(resource.loading()).toBe(true)
    expect(resource()).toBe(undefined)

    d.resolve("loaded")
    await flush()

    expect(resource.loading()).toBe(false)
    expect(resource()).toBe("loaded")

    resource.dispose()
  })

  it("handles rejected promises and exposes error", async () => {
    const resource = createResource(async () => {
      throw new Error("fetch failed")
    })

    expect(resource.loading()).toBe(true)

    await flush()

    expect(resource.loading()).toBe(false)
    expect(resource.error()).toBeInstanceOf(Error)
    expect(resource.error()!.message).toBe("fetch failed")
    expect(resource()).toBe(undefined)

    resource.dispose()
  })

  it("converts non-Error rejects to Error", async () => {
    const resource = createResource(async () => {
      throw "string error" // eslint-disable-line no-throw-literal
    })

    await flush()

    expect(resource.error()).toBeInstanceOf(Error)
    expect(resource.error()!.message).toBe("string error")

    resource.dispose()
  })

  it("refetches when a dependency signal changes", async () => {
    const userId = signal("user-1")
    const fetchFn = vi.fn(async () => `data-for-${userId()}`)

    const resource = createResource(fetchFn)

    await flush()
    expect(resource()).toBe("data-for-user-1")
    expect(fetchFn).toHaveBeenCalledTimes(1)

    // Change dependency — triggers re-fetch
    userId("user-2")

    await flush()
    expect(resource()).toBe("data-for-user-2")
    expect(fetchFn).toHaveBeenCalledTimes(2)

    resource.dispose()
  })

  it("cancels in-flight fetch when dependency changes (AbortController)", async () => {
    const userId = signal("user-1")
    const abortSignals: AbortSignal[] = []
    const deferreds: ReturnType<typeof deferred<string>>[] = []

    const resource = createResource(async (abort) => {
      abortSignals.push(abort)
      const id = userId()
      const d = deferred<string>()
      deferreds.push(d)
      return d.promise
    })

    // First fetch is in-flight (not resolved yet)
    expect(abortSignals).toHaveLength(1)
    expect(abortSignals[0]!.aborted).toBe(false)

    // Change dep while first fetch is still in-flight — should abort it
    userId("user-2")

    expect(abortSignals).toHaveLength(2)
    expect(abortSignals[0]!.aborted).toBe(true)
    expect(abortSignals[1]!.aborted).toBe(false)

    // Resolve the second fetch
    deferreds[1]!.resolve("data-for-user-2")
    await flush()
    expect(resource()).toBe("data-for-user-2")

    resource.dispose()
  })

  it("manual refetch() triggers a new fetch", async () => {
    let callCount = 0
    const resource = createResource(async () => {
      callCount++
      return `call-${callCount}`
    })

    await flush()
    expect(resource()).toBe("call-1")

    resource.refetch()
    await flush()
    expect(resource()).toBe("call-2")

    resource.refetch()
    await flush()
    expect(resource()).toBe("call-3")

    resource.dispose()
  })

  it("optimistic mutate() sets data immediately", async () => {
    const d = deferred<string>()
    const resource = createResource(async () => d.promise)

    expect(resource()).toBe(undefined)

    // Optimistic update before fetch resolves
    resource.mutate("optimistic")
    expect(resource()).toBe("optimistic")

    // When fetch resolves, data is overwritten
    d.resolve("server")
    await flush()
    expect(resource()).toBe("server")

    resource.dispose()
  })

  it("only the latest fetch writes state (sequential fetches)", async () => {
    const deferreds: ReturnType<typeof deferred<string>>[] = []

    const resource = createResource(async () => {
      const d = deferred<string>()
      deferreds.push(d)
      return d.promise
    })

    // First fetch started
    await flush()
    expect(deferreds).toHaveLength(1)

    // Trigger second fetch
    resource.refetch()
    await flush()
    expect(deferreds).toHaveLength(2)

    // Resolve second fetch first
    deferreds[1]!.resolve("second")
    await flush()
    expect(resource()).toBe("second")

    // Resolve first fetch — should be ignored (stale)
    deferreds[0]!.resolve("first")
    await flush()
    expect(resource()).toBe("second") // Still "second", not "first"

    resource.dispose()
  })

  it("recovers from error on successful refetch", async () => {
    let shouldFail = true
    const resource = createResource(async () => {
      if (shouldFail) throw new Error("fail")
      return "success"
    })

    await flush()
    expect(resource.error()?.message).toBe("fail")
    expect(resource()).toBe(undefined)

    // Fix the condition and refetch
    shouldFail = false
    resource.refetch()
    await flush()

    expect(resource.error()).toBe(null)
    expect(resource()).toBe("success")

    resource.dispose()
  })

  it("supports initialValue option", async () => {
    const d = deferred<string>()
    const resource = createResource(async () => d.promise, {
      initialValue: "initial",
    })

    expect(resource()).toBe("initial")
    expect(resource.loading()).toBe(true)

    d.resolve("fetched")
    await flush()

    expect(resource()).toBe("fetched")
    expect(resource.loading()).toBe(false)

    resource.dispose()
  })

  it("dispose cancels in-flight fetch and stops tracking", async () => {
    const userId = signal("user-1")
    let abortSignal: AbortSignal | null = null
    const fetchFn = vi.fn(async (abort: AbortSignal) => {
      abortSignal = abort
      return `data-for-${userId()}`
    })

    const resource = createResource(fetchFn)

    await flush()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(resource()).toBe("data-for-user-1")

    // Start a new fetch, then dispose before it completes
    const d = deferred<string>()
    fetchFn.mockImplementation(async (abort: AbortSignal) => {
      abortSignal = abort
      return d.promise
    })

    resource.refetch()
    expect(abortSignal!.aborted).toBe(false)

    resource.dispose()
    expect(abortSignal!.aborted).toBe(true)

    // Changing dependency should NOT trigger another fetch
    userId("user-2")
    await flush()
    expect(fetchFn).toHaveBeenCalledTimes(2) // No additional calls
  })

  it("is reactive inside an effect", async () => {
    const resource = createResource(async () => "hello")

    const observed: (string | undefined)[] = []
    const disposeOuter = effect(() => {
      observed.push(resource())
    })

    // Initial: undefined (loading)
    expect(observed).toEqual([undefined])

    await flush()

    // After resolve: "hello"
    expect(observed).toEqual([undefined, "hello"])

    disposeOuter()
    resource.dispose()
  })

  it("loading signal is reactive inside an effect", async () => {
    const d = deferred<string>()
    const resource = createResource(async () => d.promise)

    const loadingStates: boolean[] = []
    const disposeOuter = effect(() => {
      loadingStates.push(resource.loading())
    })

    expect(loadingStates).toEqual([true])

    d.resolve("done")
    await flush()

    expect(loadingStates).toEqual([true, false])

    disposeOuter()
    resource.dispose()
  })
})
