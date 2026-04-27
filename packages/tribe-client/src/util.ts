/**
 * Deadline-bounded single-shot daemon call. Used by short-lived callers
 * (Claude Code hooks, CLI one-shots) that can't tolerate blocking.
 *
 * The caller supplies the per-client RPC body via `fn(client)`. On deadline
 * or socket error the function returns a discriminated outcome rather than
 * throwing — hooks want structured failure, not exception plumbing.
 */

import { connectToDaemon, type DaemonClient } from "./client.ts"

export type DaemonCallOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "timeout" }
  | { kind: "no-daemon" }
  | { kind: "error"; message: string }

export type WithDaemonCallOpts = {
  socketPath: string
  /** Hard deadline for the whole connect+call+close cycle. */
  deadlineMs: number
  /** Per-call timeout for the underlying client. Defaults to `deadlineMs`. */
  callTimeoutMs?: number
}

export async function withDaemonCall<T>(
  opts: WithDaemonCallOpts,
  fn: (client: DaemonClient) => Promise<T>,
): Promise<DaemonCallOutcome<T>> {
  const deadline = Date.now() + opts.deadlineMs
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  try {
    const racePromise = (async (): Promise<DaemonCallOutcome<T>> => {
      const client = await connectToDaemon(opts.socketPath, {
        callTimeoutMs: opts.callTimeoutMs ?? opts.deadlineMs,
      })
      try {
        return { kind: "ok", value: await fn(client) }
      } finally {
        client.close()
      }
    })()
    const timeout = new Promise<DaemonCallOutcome<T>>((resolve) => {
      timeoutHandle = setTimeout(() => resolve({ kind: "timeout" }), Math.max(50, deadline - Date.now()))
    })
    return await Promise.race([racePromise, timeout])
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ECONNREFUSED" || code === "ENOENT") return { kind: "no-daemon" }
    return { kind: "error", message: err instanceof Error ? err.message : String(err) }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}
