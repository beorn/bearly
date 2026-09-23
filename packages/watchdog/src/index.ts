/**
 * A watchdog that a spinning main thread cannot starve.
 *
 * The main thread stamps a SharedArrayBuffer to say it is alive. A worker
 * thread, which keeps running when the main thread spins, checks the stamp's age
 * with `Atomics.wait` and acts when it goes stale: it logs (repeating with a
 * count, then noting recovery), it kills, or it logs and then escalates to a
 * kill. A one-shot deadline is the same watchdog with a stamp that is never
 * refreshed and a kill action.
 *
 * Why not a timer: a synchronous spin on the main thread stops every timer,
 * socket callback and signal handler on that thread, so a main-thread watchdog
 * reports healthy exactly when its subject is dead. Measured 2026-08-26: a
 * worker watchdog fired at 808 ms against an 8 s spin; a main-thread timer with
 * the same budget never fired.
 *
 * The worker prints with `writeSync` to stderr, because a buffered write can be
 * lost to the kill that follows it, and kills with SIGKILL, because a signal
 * handler would be queued on the frozen loop. Its lines are built only from
 * what shared memory holds: the stamp's age, the stall count, and integer
 * fields the main thread publishes, with names only through static tables.
 */
import { writeSync } from "node:fs"
import { Worker } from "node:worker_threads"
import { WATCHDOG_WORKER_SOURCE } from "./worker-source.ts"

export interface WatchdogLogAction {
  /** A stamp older than this starts a stall, and the first line. */
  readonly afterMs: number
  /** While the stall lasts, a further line each time this much more has passed, with a running count. */
  readonly repeatEveryMs: number
  readonly message: string
  /** Printed once when the main thread stamps again after a logged stall; `{elapsed}` is the stall's length. */
  readonly recovered: string
}

export interface WatchdogKillAction {
  /** A stamp older than this prints the message and SIGKILLs the process. */
  readonly afterMs: number
  readonly message: string
}

export interface WatchdogOptions {
  /** Names this watchdog in its refusals. */
  readonly label: string
  /** How often the worker wakes to read the stamp. */
  readonly checkEveryMs: number
  /** Integer facts the main thread publishes with `set`, readable as `{name}` in a line. */
  readonly fields?: readonly string[]
  /** Names for a field's integer codes, readable as `{name:name}`; a negative code prints `none`, an index past the table `unknown(n)`. */
  readonly tables?: Readonly<Record<string, readonly string[]>>
  readonly log?: WatchdogLogAction
  readonly kill?: WatchdogKillAction
}

export interface Watchdog {
  /** The main thread is alive: reset the stamp's age to zero. */
  stamp(): void
  /** Publish an integer fact for the worker's lines. */
  set(field: string, value: number): void
  /** Stop the worker. */
  disarm(): void
}

/**
 * Arm a watchdog and return its handle. The worker is `unref`'d, so it never
 * keeps a finished process alive. Every bound must be a positive finite number
 * of ms, and at least one action is required: a bound read as "never" would
 * remove the watchdog exactly when someone believed they had set one.
 */
export function armWatchdog(options: WatchdogOptions): Watchdog {
  const { label } = options
  const positive = (name: string, value: number): void => {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`watchdog ${label}: ${name} must be a positive number of ms, got ${String(value)}`)
    }
  }
  positive("checkEveryMs", options.checkEveryMs)
  if (options.log === undefined && options.kill === undefined) {
    throw new Error(`watchdog ${label}: needs a log or a kill action`)
  }
  if (options.log !== undefined) {
    positive("log.afterMs", options.log.afterMs)
    positive("log.repeatEveryMs", options.log.repeatEveryMs)
  }
  if (options.kill !== undefined) positive("kill.afterMs", options.kill.afterMs)

  const fields = [...(options.fields ?? [])]
  const stamps = new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT)
  const stamp = new Float64Array(stamps)
  stamp[0] = Date.now()
  const slots = new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT * Math.max(1, fields.length))
  const values = new Float64Array(slots)
  const worker = new Worker(WATCHDOG_WORKER_SOURCE, {
    eval: true,
    workerData: {
      stamps,
      slots,
      checkEveryMs: options.checkEveryMs,
      fields,
      tables: options.tables ?? {},
      log: options.log ?? null,
      kill: options.kill ?? null,
    },
  })
  worker.unref()
  // A worker that dies leaves the process unwatched, which is the state this package exists to rule out:
  // say so on stderr. Only disarm() ends the watch quietly.
  let disarmed = false
  worker.on("error", (error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error)
    writeSync(2, `watchdog ${label}: its worker failed, so this process is no longer watched: ${reason}\n`)
  })
  worker.on("exit", (code: number) => {
    if (disarmed) return
    writeSync(2, `watchdog ${label}: its worker exited (code ${code}), so this process is no longer watched\n`)
  })
  return {
    stamp() {
      stamp[0] = Date.now()
    },
    set(field, value) {
      const index = fields.indexOf(field)
      if (index < 0) throw new Error(`watchdog ${label}: field "${field}" was not declared`)
      values[index] = value
    },
    disarm() {
      disarmed = true
      void worker.terminate()
    },
  }
}
