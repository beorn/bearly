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
 * The worker's lines reach stderr through loggily's line sink (`loggily/sink`):
 * a writer thread owns the one blocking write, so a stderr whose reader has
 * stalled parks neither the watchdog nor the main thread. Measured 2026-10-16
 * under Bun 1.4.3: a worker's `writeSync(2)` blocks for good once ~10 KB sits
 * unread on a pty, and the km daemon's watchdog warned once and then went quiet
 * with the daemon (km 25947). A kill waits at most SINK_DRAIN_BEFORE_KILL_MS for
 * its line to reach the kernel and then SIGKILLs regardless, because a signal
 * handler would be queued on the frozen loop; a line past the sink's byte bound
 * is dropped and counted, and the next line written says so. Its lines are
 * built only from what shared memory holds: the stamp's age, the stall count,
 * integer fields the main thread publishes, with names only through static
 * tables, and short texts it publishes into fixed byte slots (what it was doing
 * when it stopped).
 */
import { writeSync } from "node:fs"
import { Worker } from "node:worker_threads"
import { openLineSink } from "loggily/sink"
import { PROCFS_SAMPLER_SOURCE, WATCHDOG_WORKER_SOURCE } from "./worker-source.ts"

/** How long a kill waits for the sink to get its line to the kernel before the SIGKILL goes ahead anyway. */
const SINK_DRAIN_BEFORE_KILL_MS = 1_000

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
  /**
   * Short texts the main thread publishes with `setText`, readable as `{name:text}`, each with its slot's size in
   * UTF-8 bytes; a longer value is cut at a character boundary, and an empty one prints `none`.
   */
  readonly texts?: Readonly<Record<string, number>>
  readonly log?: WatchdogLogAction
  readonly kill?: WatchdogKillAction
  /**
   * Where procfs is mounted, for `{process}` lines; `/proc` by default. A line naming `{process}` starts a second
   * worker that reads it, because a child's command line can block the reader: the watchdog prints that worker's
   * last finished sample and never reads procfs itself.
   */
  readonly procRoot?: string
  /**
   * Files whose locks a `{process}` line names: each lock /proc/locks holds on them, with its holder's pid, type,
   * byte range and command line. A thread asleep on a file lock has no child to blame; this names the process that
   * holds it. A file that does not exist is said to be absent.
   */
  readonly lockFiles?: readonly string[]
}

export interface Watchdog {
  /** The main thread is alive: reset the stamp's age to zero. */
  stamp(): void
  /** Publish an integer fact for the worker's lines. */
  set(field: string, value: number): void
  /** Publish a text for the worker's lines, cut to its slot at a character boundary. */
  setText(name: string, value: string): void
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

  const texts = Object.entries(options.texts ?? {}).map(([name, bytes]) => {
    if (!Number.isInteger(bytes) || bytes <= 0) {
      throw new Error(
        `watchdog ${label}: text "${name}" must hold a positive whole number of bytes, got ${String(bytes)}`,
      )
    }
    // Four bytes of length, then the UTF-8 bytes: the worker reads the length with Atomics and decodes that many.
    return { name, bytes, buffer: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT + bytes) }
  })
  const fields = [...(options.fields ?? [])]
  const stamps = new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT)
  const stamp = new Float64Array(stamps)
  stamp[0] = Date.now()
  const slots = new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT * Math.max(1, fields.length))
  const values = new Float64Array(slots)
  const wantsProcess = [options.log?.message, options.log?.recovered, options.kill?.message].some(
    // A template that is not a string is the worker's to report when it renders it, not a throw here.
    (template: unknown) => typeof template === "string" && template.includes("{process}"),
  )
  // Control [requested, completed, version (odd while the sampler writes), length], times [requestedAt, completedAt], and the line's bytes.
  const sampling = wantsProcess
    ? {
        control: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4),
        times: new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT * 2),
        text: new SharedArrayBuffer(4096),
      }
    : null
  const sampler =
    sampling === null
      ? null
      : new Worker(PROCFS_SAMPLER_SOURCE, {
          eval: true,
          workerData: { ...sampling, root: options.procRoot ?? "/proc", lockFiles: options.lockFiles ?? [] },
        })
  sampler?.unref()
  // The worker's lines go through a line sink whose writer thread owns the blocking write to stderr: the worker gets
  // a producer port (transferred) and the sink's shared control, and posts lines without ever waiting on the reader.
  const sink = openLineSink({ fd: 2 })
  const producer = sink.producer()
  const worker = new Worker(WATCHDOG_WORKER_SOURCE, {
    eval: true,
    workerData: {
      stamps,
      slots,
      checkEveryMs: options.checkEveryMs,
      fields,
      tables: options.tables ?? {},
      texts: texts.map(({ name, buffer }) => ({ name, buffer })),
      log: options.log ?? null,
      kill: options.kill ?? null,
      sampler: sampling,
      sinkPort: producer.port,
      sinkControl: producer.control,
      drainBeforeKillMs: SINK_DRAIN_BEFORE_KILL_MS,
    },
    transferList: [producer.port],
  })
  worker.unref()
  // A worker that dies leaves the process unwatched, which is the state this package exists to rule out:
  // say so on stderr. Only disarm() ends the watch quietly. These notices are written directly, not through the
  // sink: the process may be on its way out, and the sink's writer, unref'd, would not get to them. A direct write
  // parks the main thread only when stderr is already blocked, on the failure path of the failure path.
  let disarmed = false
  worker.on("error", (error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error)
    writeSync(2, `watchdog ${label}: its worker failed, so this process is no longer watched: ${reason}\n`)
  })
  worker.on("exit", (code: number) => {
    if (disarmed) return
    writeSync(2, `watchdog ${label}: its worker exited (code ${code}), so this process is no longer watched\n`)
  })
  // A dead sampler leaves the watch intact; its lines then print its last sample and how long it has been busy.
  sampler?.on("error", (error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error)
    writeSync(2, `watchdog ${label}: its procfs sampler failed, so {process} stops updating: ${reason}\n`)
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
    setText(name, value) {
      const slot = texts.find((text) => text.name === name)
      if (slot === undefined) throw new Error(`watchdog ${label}: text "${name}" was not declared`)
      let bytes = new TextEncoder().encode(value)
      if (bytes.length > slot.bytes) {
        let end = slot.bytes
        // Back off to the start of a character: a UTF-8 continuation byte is 10xxxxxx.
        while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
        bytes = bytes.subarray(0, end)
      }
      new Uint8Array(slot.buffer, Int32Array.BYTES_PER_ELEMENT, slot.bytes).set(bytes)
      Atomics.store(new Int32Array(slot.buffer, 0, 1), 0, bytes.length)
    },
    disarm() {
      disarmed = true
      void worker.terminate()
      void sampler?.terminate()
      // Drain what the worker posted, within the sink's own bound on the wait, then stop its writer.
      void sink.close()
    },
  }
}
