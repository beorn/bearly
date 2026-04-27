/**
 * Scope — structured-concurrency lifetime owner.
 *
 * A `Scope` is a subclass of TC39's `AsyncDisposableStack` that adds:
 *
 * - an `AbortSignal` that aborts on disposal (and links to a parent's signal)
 * - a `child(name?)` method that creates child scopes with cascade disposal
 * - an overridden `[Symbol.asyncDispose]()` that disposes children before the
 *   inherited user disposer stack
 *
 * All disposer-stack semantics (LIFO ordering, async-await cleanup, idempotent
 * dispose, `SuppressedError` on multi-throw, post-dispose `ReferenceError`)
 * come from `AsyncDisposableStack` directly.
 *
 * This mirrors `@silvery/scope` so tribe-daemon and silvery apps speak the same
 * lifecycle vocabulary without an inter-vendor private dependency.
 */

export class Scope extends AsyncDisposableStack {
  readonly signal: AbortSignal
  readonly name?: string
  readonly #children = new Set<Scope>()
  readonly #parent?: Scope

  constructor(parent?: Scope, name?: string) {
    super()
    this.name = name
    this.#parent = parent

    const controller = new AbortController()
    this.signal = controller.signal
    this.defer(() => controller.abort())

    if (parent) {
      if (parent.disposed) {
        throw new ReferenceError("Cannot create child of disposed scope")
      }
      if (parent.signal.aborted) {
        controller.abort()
      } else {
        const onAbort = (): void => controller.abort()
        parent.signal.addEventListener("abort", onAbort, { once: true })
        this.defer(() => parent.signal.removeEventListener("abort", onAbort))
      }
      parent.#children.add(this)
    }
  }

  /** Create a child scope. Child's signal aborts when this scope's signal does. */
  child(name?: string): Scope {
    return new Scope(this, name)
  }

  override async [Symbol.asyncDispose](): Promise<void> {
    if (this.disposed) return
    const errors: unknown[] = []

    const children = [...this.#children].reverse()
    this.#children.clear()
    for (const c of children) {
      try {
        await c[Symbol.asyncDispose]()
      } catch (e) {
        errors.push(e)
      }
    }

    try {
      await super[Symbol.asyncDispose]()
    } catch (e) {
      errors.push(e)
    }

    if (this.#parent) this.#parent.#children.delete(this)

    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw errors.reduce((acc, e) => new SuppressedError(e, acc, "Multiple disposers threw"))
    }
  }

  override move(): never {
    throw new TypeError(
      "Scope.move() is not supported — create a new scope and re-register resources explicitly",
    )
  }
}

export function createScope(name?: string): Scope {
  return new Scope(undefined, name)
}

/**
 * Lift any value with a cleanup function into a `Disposable` / `AsyncDisposable`
 * suitable for `scope.use(...)`. Both symbols are attached so either `using`
 * or `await using` works at the call site; the synchronous overload is
 * picked when the cleanup returns void, the async one when it returns a Promise.
 */
export function disposable<T extends object>(value: T, dispose: (v: T) => void): T & Disposable
export function disposable<T extends object>(
  value: T,
  dispose: (v: T) => Promise<void>,
): T & AsyncDisposable
export function disposable(
  value: object,
  dispose: (v: object) => void | Promise<void>,
): object {
  return Object.assign(value, {
    [Symbol.dispose](): void {
      void dispose(value)
    },
    [Symbol.asyncDispose](): Promise<void> {
      return Promise.resolve(dispose(value))
    },
  })
}
