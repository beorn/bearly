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
 * blocked on a synchronous child shows S and names the child. Linux only: without procfs it says so. Anything it
 * cannot read is said to be unreadable, never left out, so "children: none" means the kernel listed none. A child's
 * command line can block (reading it takes that child's memory lock), so the watchdog never calls this itself: its
 * sampler worker does, and the watchdog prints the last sample it finished.
 * It must reference nothing outside itself: the worker runs its source text.
 */
export function describeProcess(pid: number, proc: ProcReader, root = "/proc"): string {
  // <root>/<pid>/stat is "pid (comm) state ppid ..."; comm may hold spaces and parentheses, so split after the last ")".
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
  const main = statOf(`${root}/${pid}/task/${pid}/stat`)
  if (main === null) return `process facts unavailable (${root}/${pid}/task/${pid}/stat unreadable)`
  const wchanText = proc.read(`${root}/${pid}/task/${pid}/wchan`)
  const wchan = wchanText === null ? "unreadable" : wchanText.trim() || "0"
  const uptimeText = proc.read(`${root}/uptime`)
  const uptimeS = uptimeText === null ? null : Number(uptimeText.split(" ")[0])
  const unreadable: string[] = []
  const childrenOf = (of: number) => {
    const out: number[] = []
    const tasks = proc.list(`${root}/${of}/task`)
    if (tasks === null) {
      unreadable.push(`${of}'s task list`)
      return out
    }
    for (const task of tasks) {
      const listed = proc.read(`${root}/${of}/task/${task}/children`)
      if (listed === null) {
        unreadable.push(`${of}/task/${task}/children`)
        continue
      }
      for (const child of listed.split(" ")) if (child.trim() !== "") out.push(Number(child))
    }
    return out
  }
  // Every child and grandchild, capped so a fork storm cannot make the sample itself slow.
  const found: { pid: number }[] = []
  const collect = (of: number, depth: number) => {
    for (const child of childrenOf(of)) {
      if (found.length >= 64) return
      found.push({ pid: child })
      if (depth < 2) collect(child, depth + 1)
    }
  }
  collect(pid, 1)
  const shownCap = 6
  const lines = found.slice(0, shownCap).map(({ pid: child }) => {
    const stat = statOf(`${root}/${child}/stat`)
    if (stat === null) return `${child} unreadable (exited or no access)`
    const cmdline = proc.read(`${root}/${child}/cmdline`)
    const argv = cmdline === null ? null : cmdline.split("\0").join(" ").trim()
    const shown =
      argv === null
        ? "(command line unreadable)"
        : argv.length > 160
          ? `${argv.slice(0, 159)}…`
          : argv === ""
            ? "(no command line)"
            : argv
    const age = uptimeS === null ? "age unknown" : `${(uptimeS - stat.startS).toFixed(1)}s`
    return `${child} ${stat.state} ${age} "${shown}"`
  })
  const more =
    found.length >= 64
      ? ` (${found.length - shownCap} or more not shown)`
      : found.length > shownCap
        ? ` (+${found.length - shownCap} more)`
        : ""
  const listed = lines.length === 0 ? "none" : `${lines.join(", ")}${more}`
  const gaps = unreadable.length === 0 ? "" : `; unreadable: ${unreadable.join(", ")}`
  return `main thread ${main.state} wchan ${wchan} cpu ${main.cpuS.toFixed(1)}s; children: ${listed}${gaps}`
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

/**
 * The watchdog worker, as source: it runs via `eval`, so it loads nothing and starts fast when the machine is
 * struggling. It never reads procfs: a `{process}` line asks the sampler for a fresh sample, waits at most 250 ms,
 * and prints the last one the sampler finished, with its age when it is old and how long the sampler has been busy
 * when it is. The kill line asks nothing and waits for nothing, so a sampler stuck on a child's memory lock can never
 * hold back the kill.
 */
export const WATCHDOG_WORKER_SOURCE = `
const { writeSync } = require("node:fs")
const { workerData } = require("node:worker_threads")
${renderWatchdogLine.toString()}
const { stamps, slots, checkEveryMs, fields, tables, texts: textSlots, log, kill, sampler } = workerData
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
// The sampler's slots: control [requested, completed, writing, length], times [requestedAt, completedAt], text bytes.
const control = sampler === null ? null : new Int32Array(sampler.control)
const times = sampler === null ? null : new Float64Array(sampler.times)
let sample = null
// Copy the newest finished sample, unless the sampler is writing one or finished another during the copy.
const takeSample = () => {
  const done = Atomics.load(control, 1)
  if (done === 0 || (sample !== null && sample.seq === done) || Atomics.load(control, 2) === 1) return
  const length = Atomics.load(control, 3)
  const text = decoder.decode(new Uint8Array(sampler.text, 0, length).slice())
  const at = times[1]
  if (Atomics.load(control, 2) === 1 || Atomics.load(control, 1) !== done) return
  sample = { seq: done, text, at }
}
const seconds = (ms) => (ms / 1000).toFixed(1) + "s"
const processFacts = (ask) => {
  const requested = Atomics.load(control, 0)
  if (ask && requested === Atomics.load(control, 1)) {
    times[0] = Date.now()
    Atomics.store(control, 0, requested + 1)
    Atomics.notify(control, 0)
    Atomics.wait(control, 1, requested, 250)
  }
  takeSample()
  const now = Date.now()
  const busy = Atomics.load(control, 0) !== Atomics.load(control, 1) ? " (sampler busy " + seconds(now - times[0]) + ")" : ""
  if (sample === null) return "process facts not sampled yet" + busy
  const stale = now - sample.at > 1000 ? " (sampled " + seconds(now - sample.at) + " ago)" : ""
  return sample.text + stale + busy
}
const facts = (template, ask) => ({
  fields,
  values,
  tables,
  texts: readTexts(),
  ...(control !== null && template.includes("{process}") ? { process: processFacts(ask) } : {}),
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
    writeSync(2, renderWatchdogLine(kill.message, { elapsedMs: age, count, ...facts(kill.message, false) }))
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
      writeSync(2, renderWatchdogLine(log.message, { elapsedMs: age, count, ...facts(log.message, true) }))
      nextLineAt += log.repeatEveryMs
    }
  } else if (count > 0) {
    writeSync(2, renderWatchdogLine(log.recovered, { elapsedMs: last - stallStamp, count, ...facts(log.recovered, false) }))
    count = 0
    stallStamp = -1
  }
}
`

/**
 * The procfs sampler, as source: a second worker that sleeps until the watchdog asks, runs describeProcess, and
 * publishes the line (cut at a character boundary to its slot). A read that blocks holds only this worker.
 */
export const PROCFS_SAMPLER_SOURCE = `
const { readFileSync, readdirSync } = require("node:fs")
const { workerData } = require("node:worker_threads")
${describeProcess.toString()}
const control = new Int32Array(workerData.control)
const times = new Float64Array(workerData.times)
const bytes = new Uint8Array(workerData.text)
const encoder = new TextEncoder()
const reader = {
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
for (;;) {
  const done = Atomics.load(control, 1)
  Atomics.wait(control, 0, done)
  const requested = Atomics.load(control, 0)
  if (requested === done) continue
  let encoded = encoder.encode(describeProcess(process.pid, reader, workerData.root))
  if (encoded.length > bytes.length) {
    let end = bytes.length
    while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--
    encoded = encoded.subarray(0, end)
  }
  Atomics.store(control, 2, 1)
  bytes.set(encoded)
  Atomics.store(control, 3, encoded.length)
  times[1] = Date.now()
  Atomics.store(control, 2, 0)
  Atomics.store(control, 1, requested)
  Atomics.notify(control, 1)
}
`
