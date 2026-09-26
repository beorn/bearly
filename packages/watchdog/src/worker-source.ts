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
  /** The published texts, by name. */
  readonly texts?: Readonly<Record<string, string>>
  /** What `{process}` renders: {@link describeProcess}'s line, read when the template names it. */
  readonly process?: string
}

/** How `describeProcess` reads procfs; the worker passes node:fs, a test passes fixture text. */
export interface ProcReader {
  /** A file's text, or null when it cannot be read. */
  readonly read: (path: string) => string | null
  /** A directory's entry names, or null when it cannot be listed. */
  readonly list: (path: string) => readonly string[] | null
}

/**
 * One line of what the kernel says the process is doing, for a stall line (`{process}`): the main thread's scheduler
 * state (R running, S sleeping, D uninterruptible), its wait channel and its CPU seconds, then every child and
 * grandchild with its state, age and command line. A main thread that spins shows R and CPU rising line to line; one
 * blocked on a synchronous child shows S and names the child. Linux only: without procfs it says so.
 * It must reference nothing outside itself: the worker runs its source text.
 */
export function describeProcess(pid: number, proc: ProcReader): string {
  // /proc/<pid>/stat is "pid (comm) state ppid ..."; comm may hold spaces and parentheses, so split after the last ")".
  // Clock ticks are USER_HZ, 100 on every Linux the fleet runs.
  const statOf = (path: string) => {
    const text = proc.read(path)
    if (text === null) return null
    const rest = text.slice(text.lastIndexOf(")") + 2).split(" ")
    return {
      state: rest[0] ?? "?",
      cpuS: (Number(rest[11] ?? 0) + Number(rest[12] ?? 0)) / 100,
      startS: Number(rest[19] ?? 0) / 100,
    }
  }
  const main = statOf(`/proc/${pid}/task/${pid}/stat`)
  if (main === null) return "process facts unavailable (no /proc)"
  const wchan = (proc.read(`/proc/${pid}/task/${pid}/wchan`) ?? "?").trim() || "0"
  const uptimeS = Number((proc.read("/proc/uptime") ?? "0").split(" ")[0])
  const childrenOf = (of: number) => {
    const out: number[] = []
    for (const task of proc.list(`/proc/${of}/task`) ?? []) {
      for (const child of (proc.read(`/proc/${of}/task/${task}/children`) ?? "").split(" ")) {
        if (child.trim() !== "") out.push(Number(child))
      }
    }
    return out
  }
  const lines: string[] = []
  const describe = (child: number, depth: number) => {
    if (lines.length >= 6) return
    const stat = statOf(`/proc/${child}/stat`)
    if (stat === null) return
    const argv = (proc.read(`/proc/${child}/cmdline`) ?? "").split("\0").join(" ").trim()
    const shown = argv.length > 160 ? `${argv.slice(0, 159)}…` : argv === "" ? "(no command line)" : argv
    lines.push(`${child} ${stat.state} ${(uptimeS - stat.startS).toFixed(1)}s "${shown}"`)
    if (depth < 2) for (const grandchild of childrenOf(child)) describe(grandchild, depth + 1)
  }
  for (const child of childrenOf(pid)) describe(child, 1)
  const children = lines.length === 0 ? "none" : lines.join(", ")
  return `main thread ${main.state} wchan ${wchan} cpu ${main.cpuS.toFixed(1)}s; children: ${children}`
}

/**
 * Fill a line's placeholders: `{elapsed}` (ms), `{elapsedS}` (seconds, one
 * decimal), `{count}`, `{time}` (HH:MM:SS), `{field}` (its integer),
 * `{field:name}` (its table entry; "none" for a negative code) and `{field:ageS}`
 * (seconds since the epoch-ms time it holds, with its unit, or "none" for 0) and `{text:text}` (a published text, or
 * "none" when empty), and `{process}` ({@link describeProcess}). It must reference nothing outside itself: the worker runs its source text.
 */
export function renderWatchdogLine(template: string, input: WatchdogLineInput): string {
  return template.replace(/\{(\w+)(:name|:ageS|:text)?\}/gu, (whole: string, key: string, form: string | undefined) => {
    if (key === "elapsed") return String(Math.round(input.elapsedMs))
    if (key === "process" && form === undefined && input.process !== undefined) return input.process
    if (form === ":text") {
      const texts = input.texts ?? {}
      if (!Object.prototype.hasOwnProperty.call(texts, key)) return whole
      const text = texts[key] ?? ""
      return text === "" ? "none" : text
    }
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
const { readFileSync, readdirSync, writeSync } = require("node:fs")
const { workerData } = require("node:worker_threads")
${renderWatchdogLine.toString()}
${describeProcess.toString()}
const { stamps, slots, checkEveryMs, fields, tables, texts: textSlots, log, kill } = workerData
const stamp = new Float64Array(stamps)
const values = new Float64Array(slots)
const decoder = new TextDecoder()
// Read each published text as it stands now: the length first, then that many bytes, copied out of shared memory.
const readTexts = () => {
  const out = {}
  for (const { name, buffer } of textSlots) {
    const length = Atomics.load(new Int32Array(buffer, 0, 1), 0)
    out[name] = decoder.decode(new Uint8Array(buffer, 4, length).slice())
  }
  return out
}
const procReader = {
  read: (path) => {
    try {
      return readFileSync(path, "utf8")
    } catch {
      return null
    }
  },
  list: (path) => {
    try {
      return readdirSync(path)
    } catch {
      return null
    }
  },
}
// Read procfs only for a template that names {process}: a line that does not print it costs nothing.
const facts = (template) => ({
  fields,
  values,
  tables,
  texts: readTexts(),
  ...(template.includes("{process}") ? { process: describeProcess(process.pid, procReader) } : {}),
})
const sleeper = new Int32Array(new SharedArrayBuffer(4))
let stallStamp = -1
let count = 0
let nextLineAt = 0
for (;;) {
  Atomics.wait(sleeper, 0, 0, checkEveryMs)
  const last = stamp[0]
  const age = Date.now() - last
  if (kill && age >= kill.afterMs) {
    writeSync(2, renderWatchdogLine(kill.message, { elapsedMs: age, count, ...facts(kill.message) }))
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
      writeSync(2, renderWatchdogLine(log.message, { elapsedMs: age, count, ...facts(log.message) }))
      nextLineAt += log.repeatEveryMs
    }
  } else if (count > 0) {
    writeSync(2, renderWatchdogLine(log.recovered, { elapsedMs: last - stallStamp, count, ...facts(log.recovered) }))
    count = 0
    stallStamp = -1
  }
}
`
