/**
 * The worker's source and the line renderer it embeds. Internal: the package
 * entry (index.ts) does not re-export this module, so its public surface is
 * `armWatchdog` and its types. The package's own tests import it by path.
 */
export interface WatchdogLineInput {
  readonly elapsedMs: number
  readonly count: number
  readonly fields: readonly string[]
  readonly values: ArrayLike<number>
  readonly tables: Readonly<Record<string, readonly string[]>>
}

/**
 * Fill a line's placeholders: `{elapsed}` (ms), `{elapsedS}` (seconds, one
 * decimal), `{count}`, `{time}` (HH:MM:SS), `{field}` (its integer),
 * `{field:name}` (its table entry; "none" for a negative code) and `{field:ageS}`
 * (seconds since the epoch-ms time it holds, with its unit, or "none" for 0). It must reference nothing outside itself:
 * the worker runs its source text.
 */
export function renderWatchdogLine(template: string, input: WatchdogLineInput): string {
  return template.replace(/\{(\w+)(:name|:ageS)?\}/gu, (whole: string, key: string, form: string | undefined) => {
    if (key === "elapsed") return String(Math.round(input.elapsedMs))
    if (key === "elapsedS") return (input.elapsedMs / 1000).toFixed(1)
    if (key === "count") return String(input.count)
    if (key === "time") return new Date().toTimeString().slice(0, 8)
    const index = input.fields.indexOf(key)
    if (index < 0) return whole
    const value = Math.trunc(input.values[index] ?? 0)
    if (form === ":ageS") return value > 0 ? `${((Date.now() - value) / 1000).toFixed(1)}s` : "none"
    if (form === undefined) return String(value)
    const table = input.tables[key]
    if (value < 0) return "none"
    const name = table !== undefined && value < table.length ? table[value] : undefined
    return name ?? `unknown(${value})`
  })
}

/** The worker, as source: it runs via `eval`, so it loads nothing and starts fast when the machine is struggling. */
export const WATCHDOG_WORKER_SOURCE = `
const { writeSync } = require("node:fs")
const { workerData } = require("node:worker_threads")
${renderWatchdogLine.toString()}
const { stamps, slots, checkEveryMs, fields, tables, log, kill } = workerData
const stamp = new Float64Array(stamps)
const values = new Float64Array(slots)
const sleeper = new Int32Array(new SharedArrayBuffer(4))
let stallStamp = -1
let count = 0
let nextLineAt = 0
for (;;) {
  Atomics.wait(sleeper, 0, 0, checkEveryMs)
  const last = stamp[0]
  const age = Date.now() - last
  if (kill && age >= kill.afterMs) {
    writeSync(2, renderWatchdogLine(kill.message, { elapsedMs: age, count, fields, values, tables }))
    process.kill(process.pid, "SIGKILL")
  }
  if (!log) continue
  if (age >= log.afterMs) {
    if (last !== stallStamp) {
      stallStamp = last
      count = 0
      nextLineAt = log.afterMs
    }
    if (age >= nextLineAt) {
      count += 1
      writeSync(2, renderWatchdogLine(log.message, { elapsedMs: age, count, fields, values, tables }))
      nextLineAt += log.repeatEveryMs
    }
  } else if (count > 0) {
    writeSync(2, renderWatchdogLine(log.recovered, { elapsedMs: last - stallStamp, count, fields, values, tables }))
    count = 0
    stallStamp = -1
  }
}
`
