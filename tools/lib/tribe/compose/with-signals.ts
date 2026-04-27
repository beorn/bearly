/**
 * withSignals — install SIGINT / SIGTERM / SIGHUP handlers and route them to
 * the daemon's lifecycle.
 *
 * - SIGINT  → onShutdown()
 * - SIGTERM → onShutdown()
 * - SIGHUP  → onReload() — withHotReload (Phase 7) supplies the re-exec logic
 *
 * Cleanup: each `process.on(...)` is paired with `process.off(...)` registered
 * on the root scope, so test harnesses (and successive daemons in the same
 * process during integration tests) don't leak listeners.
 */

import type { BaseTribe } from "./base.ts"

export interface SignalHooks {
  onShutdown(reason: "SIGINT" | "SIGTERM"): void
  onReload(): void
}

export interface WithSignals {
  /** Re-exposed for tests; the actual hooks were applied at construction time. */
  readonly signals: { installed: ReadonlyArray<NodeJS.Signals> }
}

export function withSignals<T extends BaseTribe>(hooks: SignalHooks): (t: T) => T & WithSignals {
  return (t) => {
    const onSigint = (): void => hooks.onShutdown("SIGINT")
    const onSigterm = (): void => hooks.onShutdown("SIGTERM")
    const onSighup = (): void => hooks.onReload()

    process.on("SIGINT", onSigint)
    process.on("SIGTERM", onSigterm)
    process.on("SIGHUP", onSighup)

    t.scope.defer(() => {
      process.off("SIGINT", onSigint)
      process.off("SIGTERM", onSigterm)
      process.off("SIGHUP", onSighup)
    })

    return {
      ...t,
      signals: { installed: ["SIGINT", "SIGTERM", "SIGHUP"] as const },
    }
  }
}
