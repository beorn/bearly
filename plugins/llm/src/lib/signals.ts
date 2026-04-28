/**
 * SIGINT/SIGTERM handling primitives — sole owner of `process.on/once`
 * for signal coordination. Other modules call withSignalAbort() and
 * never touch the signal handlers directly.
 */

/**
 * Bind SIGINT/SIGTERM to an AbortController for the duration of `fn`.
 *
 * Distinguishes the two signals in the abort reason — Ctrl-C fires
 * "ctrl-c" (the user actually wanted to stop), SIGTERM fires "sigterm"
 * (sent by a wrapper, parent process, or `timeout` command — NOT a
 * user interrupt). Surfaces correctly in error envelopes so the user
 * isn't told "user-interrupt" when they didn't interrupt anything.
 *
 * Handlers are removed in `finally` so later signals fall back to the
 * default (kill the process). `process.once` — we don't want to fire
 * abort twice if the user hammers Ctrl-C; the second press terminates
 * normally.
 *
 * Used by the expensive dispatch paths (askAndFinish, runDeep, runDebate,
 * runProDual, runRecover, runAwait) so a long Pro call or 50m poll stops
 * cleanly instead of leaking server-side work / wasting the user's time.
 */
export async function withSignalAbort<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController()
  const onSigint = () => ac.abort("ctrl-c")
  const onSigterm = () => ac.abort("sigterm")
  process.once("SIGINT", onSigint)
  process.once("SIGTERM", onSigterm)
  try {
    return await fn(ac.signal)
  } finally {
    process.off("SIGINT", onSigint)
    process.off("SIGTERM", onSigterm)
  }
}
