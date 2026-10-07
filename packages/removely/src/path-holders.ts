/**
 * Path-holder census migrated from Yrd. The sources are observed independently;
 * a complete result describes one non-atomic proc view, never future producers,
 * inode identity, mount aliases or permission to perform a destructive action.
 *
 * A Linux census also answers by a DEADLINE, whatever its sources do: reading
 * `/proc/<pid>/cmdline` or `maps` waits on the target's mmap lock, measured once
 * at 23 minutes (hh 24248). A read that has not answered by then is a coverage
 * fact like a denial, `unanswered`, and no caller waits for it (hh 26947).
 */
import { execFile } from "node:child_process"
import { readFile, readdir, readlink, realpath, stat } from "node:fs/promises"
import { basename, dirname, resolve, sep } from "node:path"
import {
  parseProcessArgv,
  classifyProcessLink,
  classifyProcessSourceError,
  summarizeProcessFileDescriptors,
} from "@bearly/process-sources"
import { linuxBootTimeMs, procStatStartTicks, startTicksToMs } from "./pid-identity.ts"
import { darwinProcessCwds, type ProcessCwdRow } from "./process-census.ts"

/**
 * How long a Linux census waits for /proc before it answers with what it has. Measured normal: the whole census took
 * 33-45 ms over about 870 processes (2026-10-01, hh 26947); hh 24248 gave a whole `ps` 2 s.
 */
export const PATH_HOLDER_CENSUS_DEADLINE_MS = 2_000

export type PathHolderScope = "same-uid" | "all-visible"
export type PathHolderCensusOptions<S extends PathHolderScope = PathHolderScope> = Readonly<{
  scope: S
  /** Wall-clock ms from the census start, shared by every /proc read; default `PATH_HOLDER_CENSUS_DEADLINE_MS`. */
  deadlineMs?: number
}>
export type PathHolder = Readonly<{
  pid: number
  source: "cwd" | "exe" | "root" | "argv" | `fd/${string}`
  target: string
}>
export type SourceName = "cwd" | "exe" | "root" | "argv" | "maps" | "fd"
export type PathHolderUnavailableCoverage = Readonly<{
  /** The process proved gone (its directory absent, or another start time) after its source was missing or denied. */
  exited: number
  denied: number
  /** A source disappeared while process exit could not be established. */
  missing: number
  /** Evidence cannot be interpreted without guessing at its path. */
  ambiguous: number
  /** The read had not answered when the census deadline passed. */
  unanswered: number
}>
export type PathHolderSourceCoverage = Readonly<{
  readable: number
  /** Proven one-thread zombie or kernel-thread executable; never inferred from ENOENT or a denial alone. */
  notApplicable: number
  unavailable: PathHolderUnavailableCoverage
}>
export type PathHolderObservationIssue = Readonly<{
  source: "process" | SourceName
  resource: string
  reason: "denied" | "missing" | "ambiguous" | "unanswered"
  code?: string
}>
export type UnreadableProcess = Readonly<{
  pid: number
  /** Owner of /proc/<pid>; absent when that read itself failed. */
  uid?: number
  comm?: string
  ppid?: number
  state?: string
  startedAt?: string
  /** Actual permission-denied observations, kept separate from missing evidence. */
  denied: readonly ("process" | SourceName)[]
  /** Reads that had not answered by the census deadline; present only when there are some. */
  unanswered?: readonly ("process" | SourceName)[]
  issues: readonly PathHolderObservationIssue[]
  /** The command line, read for a denied entry whatever the caller asked, so {@link clearedByIdentity} can name it. */
  argv?: readonly string[]
}>
export type LinuxPathHolderCoverage<S extends PathHolderScope = PathHolderScope> = Readonly<{
  platform: "linux"
  scope: S
  procRoot: string
  complete: boolean
  processes: Readonly<{
    enumerated: number
    sameUid: number
    otherUid: number
    admitted: number
    inspected: number
    /** Known foreign-UID processes intentionally excluded by same-uid scope. */
    excluded: number
    zombie: number
    /**
     * Inspected processes with at least one source issue of each reason. They serialize before `sources`, so any
     * bounded prefix of the census still names why it is incomplete (hh 24638).
     */
    sourceDenied: number
    sourceUnanswered: number
    sourceMissing: number
    sourceAmbiguous: number
    unavailable: PathHolderUnavailableCoverage
  }>
  sources: Readonly<Record<SourceName, PathHolderSourceCoverage>>
  unreadable?: readonly UnreadableProcess[]
}>
export type DarwinPathHolderCoverage = Readonly<{
  platform: "darwin"
  mechanism: "lsof"
  /** Legacy successful lsof traversal, not proven UID or all-visible coverage. lsof has no argv source. */
  complete: true
}>
export type PathHolderCoverage<S extends PathHolderScope = PathHolderScope> =
  | LinuxPathHolderCoverage<S>
  | DarwinPathHolderCoverage
export type PathHolderCensus<S extends PathHolderScope = PathHolderScope> = Readonly<{
  holders: PathHolder[]
  coverage: PathHolderCoverage<S>
}>

/** Render the evidence without losing its source or target. */
export function pathHolderRefusal(holders: readonly PathHolder[]): string | undefined {
  const evidence = uniquePathHolders(holders)
  if (evidence.length === 0) return undefined
  return `path remains held by ${evidence.map(({ pid, source, target }) => `pid ${pid} via ${source} (${target})`).join("; ")}`
}

/**
 * Required resources are the target plus /proc on Linux or /usr/sbin/lsof for
 * the Darwin compatibility mechanism. Missing resources/unexpected I/O throw
 * with their location. Incomplete observations return named gaps, never empty
 * success. Scope is mandatory; all-visible currently requires Linux.
 */
export async function inspectPathHolderCensus<S extends PathHolderScope>(
  path: string,
  options: PathHolderCensusOptions<S>,
): Promise<PathHolderCensus<S>> {
  validateScope(options)
  const root = await canonicalPath(path)
  if (process.platform === "linux") return linuxCensusWithDeadline(root, "/proc", options)
  if (process.platform === "darwin" && options.scope === "same-uid") return darwinPathProcessHolderCensus(root)
  throw new Error(`unsupported path-holder scope '${options.scope}' on platform ${process.platform} for '${root}'`)
}

/** @internal Deterministic seam for the same collector against a synthetic proc tree. */
export async function inspectPathHolderCensusInProc<S extends PathHolderScope>(
  path: string,
  procRoot: string,
  options: PathHolderCensusOptions<S>,
): Promise<PathHolderCensus<S>> {
  validateScope(options)
  return linuxCensusWithDeadline(await canonicalPath(path), procRoot, options)
}

async function linuxCensusWithDeadline<S extends PathHolderScope>(
  root: string,
  procRoot: string,
  options: PathHolderCensusOptions<S>,
): Promise<PathHolderCensus<S>> {
  // A projection of the process census: every source read, and the one matching rule applied to each row.
  const collected = await withDeadline(options, (deadline) =>
    collectProcessRows(procRoot, options.scope, deadline, SOURCES),
  )
  const { coverage, holders } = summarizeRows(collected, SOURCES, root)
  return { holders: uniquePathHolders(holders), coverage: coverage as LinuxPathHolderCoverage<S> }
}

/**
 * One deadline shared by every /proc read of a census. `answer` settles with the read's value, or as unanswered once
 * the deadline has passed; a read given up on keeps running in the runtime, and its late value or error is dropped.
 * The timer never holds the process open.
 */
type CensusDeadline = Readonly<{
  answer<T>(read: Promise<T>): Promise<Readonly<{ answered: true; value: T }> | Readonly<{ answered: false }>>
  clear(): void
}>

function censusDeadline(ms: number): CensusDeadline {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new RangeError(`removely: path-holder census deadline must be a positive number of ms, got ${ms}`)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<Readonly<{ answered: false }>>((resolve) => {
    timer = setTimeout(() => resolve({ answered: false }), ms)
    timer.unref?.()
  })
  return {
    answer: <T>(read: Promise<T>) => {
      // The race below handles an answer in time; this keeps a late rejection of an abandoned read from surfacing.
      read.catch(() => {})
      return Promise.race([read.then((value) => ({ answered: true as const, value })), expired])
    },
    clear: () => clearTimeout(timer),
  }
}

function validateScope(options: PathHolderCensusOptions | undefined): void {
  if (options?.scope !== "same-uid" && options?.scope !== "all-visible") {
    throw new TypeError(
      `removely: path-holder census requires explicit scope 'same-uid' or 'all-visible'; received ${String(options?.scope)}`,
    )
  }
}

async function darwinPathProcessHolderCensus(
  root: string,
): Promise<Readonly<{ holders: PathHolder[]; coverage: DarwinPathHolderCoverage }>> {
  const { stdout, stderr, exitCode } = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve, reject) => {
      execFile(
        "/usr/sbin/lsof",
        ["+D", root, "-Fpfn"],
        { cwd: "/", encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error && (typeof error.code !== "number" || error.killed || error.signal)) {
            reject(
              new Error(`path-holder census requires /usr/sbin/lsof for '${root}': ${errorDetail(error)}`, {
                cause: error,
              }),
            )
            return
          }
          resolve({ stdout, stderr, exitCode: typeof error?.code === "number" ? error.code : 0 })
        },
      )
    },
  )
  // lsof uses 1 for an empty selection. Any diagnostic invalidates traversal.
  if ((exitCode !== 0 && exitCode !== 1) || stderr.trim() !== "") {
    throw new Error(`lsof exited ${exitCode} for '${root}': ${stderr.trim() || "no diagnostic"}`)
  }
  const holders: PathHolder[] = []
  let pid: number | undefined
  let source: PathHolder["source"] | undefined
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1))
      source = undefined
      continue
    }
    if (line.startsWith("f")) {
      source = darwinHolderSource(line.slice(1))
      continue
    }
    if (line.startsWith("n") && pid !== undefined && Number.isSafeInteger(pid) && pid > 1 && source !== undefined) {
      const target = line.slice(1)
      if (ambiguousPathMayHold(root, target)) {
        throw new Error(`ambiguous lsof path for '${root}': pid ${pid} via ${source} (${target})`)
      }
      if (pathWithin(root, target)) holders.push({ pid, source, target })
    }
  }
  return { holders: uniquePathHolders(holders), coverage: { platform: "darwin", mechanism: "lsof", complete: true } }
}

type SourceAvailability = "readable" | "notApplicable" | "exited" | "denied" | "missing" | "ambiguous" | "unanswered"
type IssueReason = PathHolderObservationIssue["reason"]
type ObservationIssue = Readonly<{ resource: string; reason: IssueReason; code?: string }>
type SourceObservation<T> = { availability: SourceAvailability; value: T; issues: ObservationIssue[] }
const SOURCES = ["cwd", "exe", "root", "argv", "maps", "fd"] as const

/** One process source as read, before any target path judges it. */
export type ProcessRowSource<T> = Readonly<{
  availability: SourceAvailability
  value: T
  issues: readonly PathHolderObservationIssue[]
}>
export type ProcessDescriptor = Readonly<{ name: string; target: string }>
export type ProcessRowSources = Readonly<{
  cwd?: ProcessRowSource<string | undefined>
  exe?: ProcessRowSource<string | undefined>
  root?: ProcessRowSource<string | undefined>
  argv?: ProcessRowSource<readonly string[]>
  maps?: ProcessRowSource<readonly string[]>
  fd?: ProcessRowSource<readonly ProcessDescriptor[]>
}>

export type ProcessSourceOptions = Readonly<{
  /** Alternate proc view, also used by the existing census; defaults to /proc. */
  procRoot?: string
  sources?: readonly ("argv" | "cwd")[]
  /** Production callers can admit and track the actual syscall in their existing I/O budget. */
  readFile?: (path: string) => Promise<string>
  readlink?: (path: string) => Promise<string>
}>

/**
 * Read selected sources of one PID without enumerating processes or claiming a stable identity.
 * The caller owns admission, deadlines and before/after birth fencing. Missing or denied sources remain named;
 * unexpected I/O fails loudly. These raw values are not redacted and must not reach unprotected logs or artifacts.
 */
export async function inspectProcessSources(
  pid: number,
  options: ProcessSourceOptions = {},
): Promise<Pick<ProcessRowSources, "argv" | "cwd">> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError(`removely: invalid process source pid '${pid}'`)
  const selected = options.sources ?? ["argv", "cwd"]
  for (const source of selected) {
    if (source !== "argv" && source !== "cwd") {
      throw new TypeError(`removely: unsupported process source '${String(source)}'`)
    }
  }
  const proc = `${options.procRoot ?? "/proc"}/${pid}`
  const [argv, cwd] = await Promise.all([
    selected.includes("argv") ? readProcessArgv(`${proc}/cmdline`, options.readFile) : undefined,
    selected.includes("cwd") ? observeProcessLink(undefined, `${proc}/cwd`, options.readlink) : undefined,
  ])
  return {
    ...(argv === undefined
      ? {}
      : { argv: { ...argv, issues: argv.issues.map((issue) => ({ source: "argv" as const, ...issue })) } }),
    ...(cwd === undefined
      ? {}
      : { cwd: { ...cwd, issues: cwd.issues.map((issue) => ({ source: "cwd" as const, ...issue })) } }),
  }
}
/**
 * One process of a census. `uid` is the owner of `/proc/<pid>`, the read every row already makes; status is not read
 * (a second read per pid that can stall), and for a same-uid process whose sources deny it gives the same uid as
 * status's `Uid:` (measured on four such processes, 2026-10-01, hh 26990). `startTicks` is field 22 of
 * `/proc/<pid>/stat` as the kernel gave it; a row is no protection against pid reuse, and a caller that signals a pid
 * from a row re-checks it first.
 */
export type ProcessRow = Readonly<{
  pid: number
  uid?: number
  comm?: string
  ppid?: number
  state?: string
  startTicks?: number
  startedAt?: string
  sources: ProcessRowSources
  /** Every issue of the row, its process-level read included. */
  issues: readonly PathHolderObservationIssue[]
}>
export type ProcessCensusOptions<S extends PathHolderScope = PathHolderScope> = PathHolderCensusOptions<S> &
  Readonly<{
    /** The sources read for each process; default all six. A cwd-only caller skips the fd and maps walks. */
    sources?: readonly SourceName[]
    /** Return each row's argv. Off by default: a command line can carry a secret. A denied row's argv is read
     * whatever this says, for its identity, and is returned on its unreadable entry. */
    includeArgv?: boolean
  }>
export type ProcessCensusCoverage<S extends PathHolderScope = PathHolderScope> = Omit<
  LinuxPathHolderCoverage<S>,
  "sources"
> &
  Readonly<{ sources: Readonly<Partial<Record<SourceName, PathHolderSourceCoverage>>> }>
export type ProcessCensus<S extends PathHolderScope = PathHolderScope> = Readonly<{
  rows: readonly ProcessRow[]
  coverage: ProcessCensusCoverage<S>
}>

/**
 * The Linux process census every holder question projects from: one row per admitted process, with the sources asked
 * for, read by one deadline. Linux only; a missing /proc throws with its location.
 */
export async function inspectProcessCensus<S extends PathHolderScope>(
  options: ProcessCensusOptions<S>,
): Promise<ProcessCensus<S>> {
  return inspectProcessCensusInProc("/proc", options)
}

/** @internal Deterministic seam for the same collector against a synthetic proc tree. */
export async function inspectProcessCensusInProc<S extends PathHolderScope>(
  procRoot: string,
  options: ProcessCensusOptions<S>,
): Promise<ProcessCensus<S>> {
  validateScope(options)
  const selected = selectedSources(options.sources)
  const collected = await withDeadline(options, (deadline) =>
    collectProcessRows(procRoot, options.scope, deadline, selected),
  )
  const summary = summarizeRows(collected, selected, undefined)
  return {
    rows: collected.rows.map((row) => publicRow(row, options.includeArgv === true)),
    coverage: summary.coverage as ProcessCensusCoverage<S>,
  }
}

function selectedSources(sources: readonly SourceName[] | undefined): readonly SourceName[] {
  if (sources === undefined) return SOURCES
  for (const source of sources) {
    if (!(SOURCES as readonly string[]).includes(source)) {
      throw new TypeError(`removely: unknown process census source '${String(source)}'`)
    }
  }
  return SOURCES.filter((source) => sources.includes(source))
}

async function withDeadline<T>(
  options: PathHolderCensusOptions,
  run: (deadline: CensusDeadline) => Promise<T>,
): Promise<T> {
  const deadline = censusDeadline(options.deadlineMs ?? PATH_HOLDER_CENSUS_DEADLINE_MS)
  try {
    return await run(deadline)
  } finally {
    deadline.clear()
  }
}

type RowKind = "inspected" | "zombie" | "unknownUid"
type MutableRow = {
  pid: number
  procPath: string
  kind: RowKind
  uid?: number
  identity: ProcessIdentity
  processIssues: PathHolderObservationIssue[]
  sources: Partial<Record<SourceName, SourceObservation<unknown>>>
  /** argv read for a denied row's identity when the caller did not ask for argv. */
  identityArgv?: string[]
}
type CollectedRows = Readonly<{
  procRoot: string
  scope: PathHolderScope
  rows: MutableRow[]
  enumerated: number
  sameUid: number
  otherUid: number
  excluded: number
  exited: number
  processDenied: number
  processUnanswered: number
}>

async function collectProcessRows(
  procRoot: string,
  scope: PathHolderScope,
  deadline: CensusDeadline,
  selected: readonly SourceName[],
): Promise<CollectedRows> {
  const listing = await deadline.answer(readdir(procRoot, { withFileTypes: true })).catch((error: unknown) => {
    throw new Error(`Linux path-holder census requires readable proc root '${procRoot}': ${errorDetail(error)}`, {
      cause: error,
    })
  })
  // Without the process list there is no census to report coverage for.
  if (!listing.answered) {
    throw new Error(`Linux path-holder census: proc root '${procRoot}' did not list within the census deadline`)
  }
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error(`Linux process census requires the current uid for '${procRoot}'`)
  const bootedAtMs = linuxBootTimeMs(procRoot)
  const numericEntries = listing.value.filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
  const counts = { sameUid: 0, otherUid: 0, excluded: 0, exited: 0, processDenied: 0, processUnanswered: 0 }
  const rows = await Promise.all(
    numericEntries.map(async (entry): Promise<MutableRow | undefined> => {
      const pid = Number(entry.name)
      const proc = `${procRoot}/${entry.name}`
      const metadata = await observeSource(deadline, proc, () => stat(proc), undefined)
      // A missing process DIRECTORY is exit evidence; a missing child is not.
      if (metadata.availability === "missing") {
        counts.exited += 1
        return undefined
      }
      const processIssues: PathHolderObservationIssue[] = metadata.issues.map((issue) => ({
        source: "process",
        ...issue,
      }))
      if (metadata.availability === "denied") counts.processDenied += 1
      if (metadata.availability === "unanswered") counts.processUnanswered += 1
      const identity = await observeProcessIdentity(deadline, proc, bootedAtMs)
      const ownerUid = metadata.value?.uid
      if (ownerUid !== undefined) {
        if (ownerUid === uid) counts.sameUid += 1
        else {
          counts.otherUid += 1
          if (scope === "same-uid") {
            counts.excluded += 1
            return undefined
          }
        }
      } else if (scope === "same-uid") {
        const row: MutableRow = { pid, procPath: proc, kind: "unknownUid", identity, processIssues, sources: {} }
        await readIdentityArgv(deadline, proc, row)
        return row
      }
      const base = {
        pid,
        procPath: proc,
        ...(ownerUid === undefined ? {} : { uid: ownerUid }),
        identity,
        processIssues,
      }
      if (heldNothingAsZombie(identity)) return { ...base, kind: "zombie", sources: {} }
      const sources = await observeSources(deadline, proc, selected)
      await resolveUnreadSources(deadline, proc, identity, bootedAtMs, sources)
      const row: MutableRow = { ...base, kind: "inspected", sources }
      const denied = Object.values(sources).some((observation) =>
        observation.issues.some((issue) => issue.reason === "denied"),
      )
      if ((denied || processIssues.length > 0) && sources.argv === undefined) {
        await readIdentityArgv(deadline, proc, row)
      }
      return row
    }),
  )
  return {
    procRoot,
    scope,
    rows: rows.filter((row): row is MutableRow => row !== undefined),
    enumerated: numericEntries.length,
    ...counts,
  }
}

/**
 * A zombie holds nothing, but only a zombie with one thread is one (@cto 6eef7d1e): a thread-group leader that exited
 * while another thread lives also reads Z, and the live thread's cwd, fd and maps are still there. A thread count that
 * was not read proves nothing.
 */
function heldNothingAsZombie(identity: ProcessIdentity): boolean {
  return identity.state === "Z" && identity.threads === 1
}

/** A source whose read gave no reading: nothing a retry could take away. */
function gaveNoReading(observation: SourceObservation<unknown>): boolean {
  const { value } = observation
  return Array.isArray(value) ? value.length === 0 : value === undefined
}

/**
 * The one exit proof (hh 26990, @cto 2e553d4c and 6eef7d1e), entered for a source that went missing or was denied.
 * What it clears is the absence of a reading, never a reading: a holder, a value or an ambiguous target stands.
 * - The process directory answering ENOENT to a stat proves exit. A denied or unanswered re-stat proves nothing.
 * - A start time read both times and different proves the first process exited.
 * - A zombie with one thread holds nothing; an executable a kernel thread lacks is not applicable.
 * - Otherwise a denied source that gave no reading is read once more, as a retry for a process that denied its /proc
 *   entries for a moment. A second read that does not answer by the census deadline changes nothing.
 * Every read here races the same census deadline; the process-level issue is untouched.
 */
async function resolveUnreadSources(
  deadline: CensusDeadline,
  proc: string,
  identity: ProcessIdentity,
  bootedAtMs: number | undefined,
  sources: Partial<Record<SourceName, SourceObservation<unknown>>>,
  allowRetry = true,
): Promise<void> {
  const unread = (reason: "missing" | "denied") =>
    (Object.keys(sources) as SourceName[]).filter((source) =>
      sources[source]?.issues.some((issue) => issue.reason === reason),
    )
  const missing = unread("missing")
  const denied = unread("denied")
  if (missing.length === 0 && denied.length === 0) return
  const presence = await observeSource(deadline, proc, () => stat(proc), undefined)
  const after =
    presence.availability === "readable" ? await observeProcessIdentity(deadline, proc, bootedAtMs) : undefined
  const exited =
    presence.availability === "missing" ||
    (identity.startTicks !== undefined && after?.startTicks !== undefined && after.startTicks !== identity.startTicks)
  const resolve = (source: SourceName, reason: "missing" | "denied", resolved: "exited" | "notApplicable") => {
    const observation = sources[source]
    if (observation === undefined) return
    observation.issues = observation.issues.filter((issue) => issue.reason !== reason)
    observation.availability = observation.issues[0]?.reason ?? resolved
  }
  for (const [reason, names] of [
    ["missing", missing],
    ["denied", denied],
  ] as const) {
    for (const source of names) {
      if (exited) resolve(source, reason, "exited")
      else if (after !== undefined && heldNothingAsZombie(after)) resolve(source, reason, "notApplicable")
      else if (reason === "missing" && source === "exe" && after?.kernelThread === true) {
        resolve(source, reason, "notApplicable")
      }
    }
  }
  if (exited || presence.availability !== "readable" || (after !== undefined && heldNothingAsZombie(after))) return
  if (!allowRetry) return
  const retry = denied.filter((source) => {
    const observation = sources[source]
    return observation !== undefined && gaveNoReading(observation)
  })
  if (retry.length === 0) return
  const again = await observeSources(deadline, proc, retry)
  for (const source of retry) {
    const second = again[source]
    if (second !== undefined && second.availability !== "unanswered") sources[source] = second
  }
  // The process can disappear during the retry itself. Reuse the same proof,
  // without another retry, before retaining its final unreadable observation.
  await resolveUnreadSources(deadline, proc, identity, bootedAtMs, sources, false)
}

/**
 * The sources of one process. cmdline and maps both wait on the target's mmap lock, and a read that never settles
 * pins one thread of the runtime's I/O pool until the kernel lets go (ag hab-sysmon, measured on a 32-thread pool). So
 * maps is read after argv and never once argv has not answered: one stuck process pins one thread, not two. The links
 * and the fd walk do not take that lock and start beside it.
 */
async function observeSources(
  deadline: CensusDeadline,
  proc: string,
  selected: readonly SourceName[],
): Promise<Partial<Record<SourceName, SourceObservation<unknown>>>> {
  const want = (source: SourceName) => selected.includes(source)
  const lockedPair = async () => {
    const argv = want("argv") ? await observeProcessArgv(deadline, `${proc}/cmdline`) : undefined
    const maps = !want("maps")
      ? undefined
      : argv?.availability === "unanswered"
        ? unansweredObservation<string[]>(`${proc}/maps`, [])
        : await observeProcessMaps(deadline, `${proc}/maps`)
    return { argv, maps }
  }
  const [cwd, exe, root, fd, locked] = await Promise.all([
    want("cwd") ? observeProcessCwd(deadline, proc) : undefined,
    want("exe") ? observeProcessLink(deadline, `${proc}/exe`) : undefined,
    want("root") ? observeProcessLink(deadline, `${proc}/root`) : undefined,
    want("fd") ? observeProcessDescriptors(deadline, `${proc}/fd`) : undefined,
    lockedPair(),
  ])
  const observed: Partial<Record<SourceName, SourceObservation<unknown>>> = {}
  for (const [source, observation] of [
    ["cwd", cwd],
    ["exe", exe],
    ["root", root],
    ["argv", locked.argv],
    ["maps", locked.maps],
    ["fd", fd],
  ] as const) {
    if (observation !== undefined) observed[source] = observation
  }
  return observed
}

/** A denied row is identified by its command line, read whatever the caller asked for (hh 26990, @cto adce5a62). */
async function readIdentityArgv(deadline: CensusDeadline, proc: string, row: MutableRow): Promise<void> {
  const argv = await observeProcessArgv(deadline, `${proc}/cmdline`)
  if (argv.availability === "readable") row.identityArgv = argv.value
}

function unansweredObservation<T>(resource: string, value: T): SourceObservation<T> {
  return { availability: "unanswered", value, issues: [{ resource, reason: "unanswered" }] }
}

/**
 * A target path's judgement of a row: the root-dependent ambiguity of each path the row read (an escaped or
 * `(deleted)` name that may lie under the root). The row's own issues stand; this adds the target's.
 */
function rootIssues(row: MutableRow, root: string): Partial<Record<SourceName, ObservationIssue[]>> {
  const issues: Partial<Record<SourceName, ObservationIssue[]>> = {}
  const add = (source: SourceName, resource: string) => (issues[source] ??= []).push({ resource, reason: "ambiguous" })
  for (const source of ["cwd", "exe", "root"] as const) {
    const value = row.sources[source]?.value
    if (typeof value === "string" && ambiguousPathMayHold(root, value)) add(source, `${row.procPath}/${source}`)
  }
  for (const target of (row.sources.maps?.value as string[] | undefined) ?? []) {
    if (ambiguousPathMayHold(root, target)) add("maps", `${row.procPath}/maps`)
  }
  for (const descriptor of (row.sources.fd?.value as ProcessDescriptor[] | undefined) ?? []) {
    if (ambiguousPathMayHold(root, descriptor.target)) add("fd", `${row.procPath}/fd/${descriptor.name}`)
  }
  return issues
}

/**
 * Coverage of a census, and the holders of `root` when a path asks. One derivation for every projection: the row
 * census, the path census and the cwd projection agree because they count the same rows.
 */
function summarizeRows(
  collected: CollectedRows,
  selected: readonly SourceName[],
  root: string | undefined,
): Readonly<{ coverage: ProcessCensusCoverage; holders: PathHolder[] }> {
  const processCoverage = {
    enumerated: collected.enumerated,
    sameUid: collected.sameUid,
    otherUid: collected.otherUid,
    admitted: 0,
    inspected: 0,
    excluded: collected.excluded,
    zombie: 0,
    sourceDenied: 0,
    sourceUnanswered: 0,
    sourceMissing: 0,
    sourceAmbiguous: 0,
    unavailable: {
      ...emptyUnavailableCoverage(),
      exited: collected.exited,
      denied: collected.processDenied,
      unanswered: collected.processUnanswered,
    },
  }
  const sourceCoverage: Partial<Record<SourceName, MutableSourceCoverage>> = Object.fromEntries(
    selected.map((source) => [source, emptySourceCoverage()]),
  )
  const unreadable: UnreadableProcess[] = []
  const holders: PathHolder[] = []
  for (const row of collected.rows) {
    if (row.kind === "unknownUid") {
      unreadable.push(unreadableProcess(row, row.processIssues))
      continue
    }
    processCoverage.admitted += 1
    if (row.kind === "zombie") {
      processCoverage.zombie += 1
      if (row.processIssues.length > 0) unreadable.push(unreadableProcess(row, row.processIssues))
      continue
    }
    processCoverage.inspected += 1
    const added = root === undefined ? {} : rootIssues(row, root)
    const issues = [...row.processIssues]
    const reasons = new Set<IssueReason>()
    for (const source of selected) {
      const observation = row.sources[source]
      if (observation === undefined) continue
      const extra = added[source] ?? []
      const effective =
        extra.length === 0
          ? observation
          : {
              ...observation,
              // An observation with no issue of its own (readable, exited, not applicable) takes the target's.
              availability: observation.issues.length === 0 ? ("ambiguous" as const) : observation.availability,
              issues: [...observation.issues, ...extra],
            }
      const coverage = sourceCoverage[source]
      if (coverage !== undefined) recordSourceCoverage(coverage, effective)
      issues.push(...effective.issues.map((issue) => ({ source, ...issue })))
      for (const issue of effective.issues) reasons.add(issue.reason)
    }
    for (const reason of reasons) processCoverage[SOURCE_REASON_COUNTER[reason]] += 1
    if (issues.length > 0) unreadable.push(unreadableProcess(row, issues))
    if (root !== undefined) holders.push(...rowHolders(row, root))
  }
  // One derivation from the head counters. A head counter is zero exactly when no source records that reason, so this
  // agrees with scanning the per-source table on zero against non-zero; the counts differ, since the head counts
  // processes and the table counts each source.
  const complete =
    processCoverage.unavailable.denied === 0 &&
    processCoverage.unavailable.unanswered === 0 &&
    processCoverage.sourceDenied === 0 &&
    processCoverage.sourceUnanswered === 0 &&
    processCoverage.sourceMissing === 0 &&
    processCoverage.sourceAmbiguous === 0
  return {
    holders,
    coverage: {
      platform: "linux",
      scope: collected.scope,
      procRoot: collected.procRoot,
      complete,
      processes: processCoverage,
      sources: sourceCoverage,
      ...(unreadable.length === 0 ? {} : { unreadable: unreadable.sort((a, b) => a.pid - b.pid) }),
    },
  }
}

/** The one matching rule: a row holds `root` through a link, an argv element, a mapped file or a descriptor under it. */
function rowHolders(row: MutableRow, root: string): PathHolder[] {
  const holders: PathHolder[] = []
  const pid = row.pid
  for (const source of ["cwd", "exe", "root"] as const) {
    const value = row.sources[source]?.value
    if (typeof value === "string" && pathWithin(root, value)) holders.push({ pid, source, target: value })
  }
  // Judged per element: only an element that is itself a path under the root holds it. Script text such as
  // `sh -c 'cd <path>'` or a `--flag=<path>` that mentions the path pins nothing (hh 26947).
  for (const element of (row.sources.argv?.value as string[] | undefined) ?? []) {
    if (element.startsWith("/") && pathWithin(root, element)) holders.push({ pid, source: "argv", target: element })
  }
  for (const mappedFile of (row.sources.maps?.value as string[] | undefined) ?? []) {
    if (pathWithin(root, mappedFile)) holders.push({ pid, source: "fd/maps", target: mappedFile })
  }
  for (const descriptor of (row.sources.fd?.value as ProcessDescriptor[] | undefined) ?? []) {
    if (pathWithin(root, descriptor.target)) {
      holders.push({ pid, source: `fd/${descriptor.name}`, target: descriptor.target })
    }
  }
  return holders
}

function publicRow(row: MutableRow, includeArgv: boolean): ProcessRow {
  const sources: Record<string, ProcessRowSource<unknown>> = {}
  const issues: PathHolderObservationIssue[] = [...row.processIssues]
  for (const [source, observation] of Object.entries(row.sources) as Array<[SourceName, SourceObservation<unknown>]>) {
    const sourced = observation.issues.map((issue) => ({ source, ...issue }))
    issues.push(...sourced)
    sources[source] = {
      availability: observation.availability,
      value: source === "argv" && !includeArgv ? [] : observation.value,
      issues: sourced,
    }
  }
  const { comm, ppid, state, startTicks, startedAt } = row.identity
  return {
    pid: row.pid,
    ...(row.uid === undefined ? {} : { uid: row.uid }),
    ...(comm === undefined ? {} : { comm }),
    ...(ppid === undefined ? {} : { ppid }),
    ...(state === undefined ? {} : { state }),
    ...(startTicks === undefined ? {} : { startTicks }),
    ...(startedAt === undefined ? {} : { startedAt }),
    sources: sources as ProcessRowSources,
    issues,
  }
}

/**
 * Every same-uid process's working directory, from the process census's cwd source. `complete` is false while any
 * process could not be read; its entry is in `unreadable`, and a caller clears it with {@link clearedByIdentity} or
 * refuses. On macOS the rows come from lsof and the census is complete or throws.
 */
export type ProcessCwdProjection = Readonly<{
  rows: readonly ProcessCwdRow[]
  complete: boolean
  unreadable: readonly UnreadableProcess[]
  mechanism: "proc" | "lsof"
}>

export async function inspectProcessCwds(
  options: Readonly<{ deadlineMs?: number }> = {},
): Promise<ProcessCwdProjection> {
  if (process.platform === "linux") return inspectProcessCwdsInProc("/proc", options)
  if (process.platform === "darwin") {
    return { rows: darwinProcessCwds(), complete: true, unreadable: [], mechanism: "lsof" }
  }
  throw new Error(`process cwd census is unsupported on platform ${process.platform}`)
}

/** @internal Deterministic seam for the same projection against a synthetic proc tree. */
export async function inspectProcessCwdsInProc(
  procRoot: string,
  options: Readonly<{ deadlineMs?: number }> = {},
): Promise<ProcessCwdProjection> {
  const census = await inspectProcessCensusInProc(procRoot, {
    scope: "same-uid",
    sources: ["cwd"],
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
  })
  const rows = census.rows.flatMap((row): ProcessCwdRow[] => {
    const cwd = row.sources.cwd
    return cwd?.availability === "readable" && cwd.value !== undefined ? [{ pid: row.pid, cwd: cwd.value }] : []
  })
  return { rows, complete: census.coverage.complete, unreadable: census.coverage.unreadable ?? [], mechanism: "proc" }
}

/**
 * The one predicate for a denied same-uid process (hh 26990 line 60, @cto adce5a62 and c1e73bcd). Four identities
 * leave their context non-dumpable, so their sources deny the census for their whole life while their name and command
 * line stay readable. Each is carried as the predicates it replaces matched it, never narrowed:
 * - `systemd` with `--user` anywhere in its argv: the PAM-spawned user session manager;
 * - `(sd-pam)`, by name or as its whole argv: the session manager's PAM sibling;
 * - `sshd-session`, by name: this user's ssh connection after its privilege transitions (2026-08-26, 73 leaked roots);
 * - `ssh-agent`, by name: non-dumpable for its whole life, it kept every nightly sweep blind on 2026-09-24 (25342).
 * Each clears an entry recorded as "denied, cleared by identity". An entry of another uid, without a uid, or with any
 * issue other than a denial is a refusal. Returns the identity that cleared it, or undefined.
 */
export function clearedByIdentity(
  entry: UnreadableProcess,
  identity: Readonly<{ uid: number }> = currentIdentity(),
): string | undefined {
  if (entry.uid !== identity.uid) return undefined
  if (entry.issues.length === 0 || entry.issues.some((issue) => issue.reason !== "denied")) return undefined
  const argv = entry.argv ?? []
  const [first] = argv
  if (first !== undefined && basename(first) === "systemd" && argv.includes("--user")) return "systemd --user"
  if (entry.comm === "(sd-pam)" || (argv.length === 1 && first === "(sd-pam)")) return "(sd-pam)"
  if (entry.comm === "sshd-session") return "sshd-session"
  if (entry.comm === "ssh-agent") return "ssh-agent"
  return undefined
}

function currentIdentity(): Readonly<{ uid: number }> {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("removely: clearedByIdentity needs the current uid")
  return { uid }
}

async function canonicalPath(path: string): Promise<string> {
  if (typeof path !== "string" || path.trim() === "") {
    throw new TypeError("removely: path-holder census requires a non-empty path")
  }
  return realpath(resolve(path)).catch((error: unknown) => {
    throw new Error(`path-holder census requires resolvable target '${path}': ${errorDetail(error)}`, { cause: error })
  })
}

function pathWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

// /proc maps escapes newlines without distinguishing literal octal text, and
// its deleted suffix collides with a literal filename. Discard ambiguity only
// when EVERY interpretation is lexically outside this requested root. This
// proves no mount alias or inode identity, just the same proc path contract.
function ambiguousPathMayHold(root: string, target: string): boolean {
  const deleted = target.endsWith(" (deleted)")
  const interpretations = deleted ? [target, target.slice(0, -" (deleted)".length)] : [target]
  return interpretations.some((candidate) => {
    const escape = /\\[0-7]{3}|[\n\r\0]/u.exec(candidate)
    if (escape !== null) {
      // Do not guess decoded bytes or mixed encodings: the unchanged prefix
      // must already diverge from the root before the first ambiguity.
      const prefix = candidate.slice(0, escape.index)
      return pathWithin(root, prefix) || root.startsWith(prefix)
    }
    return deleted && pathWithin(root, candidate)
  })
}

function uniquePathHolders(values: readonly PathHolder[]): PathHolder[] {
  const unique = new Map<string, PathHolder>()
  for (const holder of values) unique.set(`${holder.pid}\0${holder.source}\0${holder.target}`, holder)
  return [...unique.values()].sort(
    (left, right) =>
      left.pid - right.pid || left.source.localeCompare(right.source) || left.target.localeCompare(right.target),
  )
}

function darwinHolderSource(field: string): PathHolder["source"] {
  if (field === "cwd") return "cwd"
  if (field === "txt") return "exe"
  if (field === "rtd") return "root"
  return `fd/${field}`
}

const SOURCE_REASON_COUNTER = {
  denied: "sourceDenied",
  unanswered: "sourceUnanswered",
  missing: "sourceMissing",
  ambiguous: "sourceAmbiguous",
} as const satisfies Record<IssueReason, string>

function unreadableProcess(row: MutableRow, issues: PathHolderObservationIssue[]): UnreadableProcess {
  const sourcesWith = (reason: IssueReason) => [
    ...new Set(issues.filter((issue) => issue.reason === reason).map((issue) => issue.source)),
  ]
  const unanswered = sourcesWith("unanswered")
  const { comm, ppid, state, startedAt } = row.identity
  const argv =
    row.identityArgv ??
    (row.sources.argv?.availability === "readable" ? (row.sources.argv.value as string[]) : undefined)
  return {
    pid: row.pid,
    ...(row.uid === undefined ? {} : { uid: row.uid }),
    ...(comm === undefined ? {} : { comm }),
    ...(ppid === undefined ? {} : { ppid }),
    ...(state === undefined ? {} : { state }),
    ...(startedAt === undefined ? {} : { startedAt }),
    denied: sourcesWith("denied"),
    ...(unanswered.length === 0 ? {} : { unanswered }),
    issues,
    ...(argv === undefined ? {} : { argv }),
  }
}

type MutableSourceCoverage = {
  readable: number
  notApplicable: number
  unavailable: { exited: number; denied: number; missing: number; ambiguous: number; unanswered: number }
}
function emptyUnavailableCoverage() {
  return { exited: 0, denied: 0, missing: 0, ambiguous: 0, unanswered: 0 }
}
function emptySourceCoverage(): MutableSourceCoverage {
  return { readable: 0, notApplicable: 0, unavailable: emptyUnavailableCoverage() }
}
function recordSourceCoverage(coverage: MutableSourceCoverage, observation: SourceObservation<unknown>): void {
  const { availability, issues } = observation
  if (availability === "readable" || availability === "notApplicable") coverage[availability] += 1
  else if (availability === "exited") coverage.unavailable.exited += 1
  else {
    // Counts are processes per source/reason, not individual descriptors. One
    // fd table may contain several independent kinds of missing evidence.
    for (const reason of new Set(issues.map((issue) => issue.reason))) coverage.unavailable[reason] += 1
  }
}
async function observeSource<T>(
  deadline: CensusDeadline | undefined,
  resource: string,
  read: () => Promise<T>,
  unavailableValue: T,
): Promise<SourceObservation<T>> {
  try {
    const answer =
      deadline === undefined ? { answered: true as const, value: await read() } : await deadline.answer(read())
    if (!answer.answered) {
      return { availability: "unanswered", value: unavailableValue, issues: [{ resource, reason: "unanswered" }] }
    }
    return { availability: "readable", value: answer.value, issues: [] }
  } catch (error) {
    const failure = classifyProcessSourceError(error)
    const code = failure.code
    const availability = failure.reason === "vanished" ? "missing" : failure.reason === "denied" ? "denied" : undefined
    if (availability === undefined) {
      throw new Error(`path-holder observation failed at '${resource}': ${failure.detail}`, { cause: error })
    }
    return {
      availability,
      value: unavailableValue,
      issues: [{ resource, reason: availability, ...(code === undefined ? {} : { code }) }],
    }
  }
}
async function observeProcessLink(
  deadline: CensusDeadline | undefined,
  path: string,
  read: (path: string) => Promise<string> = (path) => readlink(path),
): Promise<SourceObservation<string | undefined>> {
  const observed = await observeSource(deadline, path, () => read(path), undefined)
  // A link that names no path, other than a socket, pipe or anonymous inode, is ambiguous whatever the target; a path
  // that may lie under one root is judged by that root's projection.
  if (observed.value !== undefined && classifyProcessLink(observed.value) === "malformed") {
    return { ...observed, availability: "ambiguous", issues: [{ resource: path, reason: "ambiguous" }] }
  }
  return observed
}
async function observeProcessArgv(deadline: CensusDeadline, path: string): Promise<SourceObservation<string[]>> {
  const proc = dirname(path)
  const answer = await deadline.answer(
    inspectProcessSources(Number(basename(proc)), {
      procRoot: dirname(proc),
      sources: ["argv"],
    }),
  )
  if (!answer.answered) return unansweredObservation(path, [])
  const argv = answer.value.argv
  if (argv === undefined) throw new Error(`removely: requested argv source missing from result for '${proc}'`)
  return { ...argv, value: [...argv.value], issues: [...argv.issues] }
}
async function observeProcessCwd(
  deadline: CensusDeadline,
  proc: string,
): Promise<SourceObservation<string | undefined>> {
  const answer = await deadline.answer(
    inspectProcessSources(Number(basename(proc)), {
      procRoot: dirname(proc),
      sources: ["cwd"],
    }),
  )
  if (!answer.answered) return unansweredObservation(`${proc}/cwd`, undefined)
  const cwd = answer.value.cwd
  if (cwd === undefined) throw new Error(`removely: requested cwd source missing from result for '${proc}'`)
  return { ...cwd, issues: [...cwd.issues] }
}
async function readProcessArgv(
  path: string,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<SourceObservation<string[]>> {
  const observed = await observeSource(undefined, path, () => read(path), "")
  if (observed.availability !== "readable") return { ...observed, value: [] }
  return { ...observed, value: [...parseProcessArgv(observed.value)] }
}
async function observeProcessMaps(deadline: CensusDeadline, path: string): Promise<SourceObservation<string[]>> {
  const observed = await observeSource(deadline, path, () => readFile(path, "utf8"), "")
  if (observed.availability !== "readable") return { ...observed, value: [] }
  const mappedFiles: string[] = []
  const issues: ObservationIssue[] = []
  for (const line of observed.value.split("\n")) {
    if (line === "") continue
    const match = /^[0-9a-f]+-[0-9a-f]+\s+[rwxps-]{4}\s+[0-9a-f]+\s+[0-9a-f]+:[0-9a-f]+\s+\d+(?:\s+(.*))?$/u.exec(line)
    const target = match?.[1]
    if (
      match === null ||
      (target !== undefined &&
        target !== "" &&
        // An anonymous inode names no path, as in the link reader above.
        !target.startsWith("/") &&
        !/^\[[^\]]+\]$|^anon_inode:/u.test(target))
    ) {
      issues.push({ resource: path, reason: "ambiguous" })
    }
    if (target?.startsWith("/")) mappedFiles.push(target)
  }
  return { availability: issues.length === 0 ? "readable" : "ambiguous", value: mappedFiles, issues }
}
async function observeProcessDescriptors(
  deadline: CensusDeadline,
  path: string,
): Promise<SourceObservation<Array<Readonly<{ name: string; target: string }>>>> {
  const directory = await observeSource(deadline, path, () => readdir(path), [] as string[])
  if (directory.availability !== "readable") return { ...directory, value: [] }
  const links = await Promise.all(
    directory.value.map(async (name) => ({
      name,
      observed: await observeProcessLink(deadline, `${path}/${name}`),
    })),
  )
  const issues = links.flatMap(({ observed }) => observed.issues)
  const availability =
    (["denied", "unanswered", "missing", "ambiguous"] as const).find((reason) =>
      links.some(({ observed }) => observed.availability === reason),
    ) ?? "readable"
  return {
    availability,
    issues,
    value: summarizeProcessFileDescriptors(
      links.map(({ name, observed }) => ({ name, target: observed.value })),
    ).targets.map(({ name, target }) => ({ name, target })),
  }
}

/** Optional display metadata never proves exit; only process-directory absence does. */
type ProcessIdentity = {
  comm?: string
  ppid?: number
  state?: string
  startTicks?: number
  startedAt?: string
  kernelThread?: true
  /** Field 20, num_threads: a zombie leader whose other threads live still says more than one. */
  threads?: number
}
async function observeProcessIdentity(
  deadline: CensusDeadline,
  proc: string,
  bootedAtMs: number | undefined,
): Promise<ProcessIdentity> {
  try {
    const answer = await deadline.answer(readFile(`${proc}/stat`, "utf8"))
    // Identity is decoration: an unanswered stat read leaves the pid and its sources' own gaps named without it.
    if (!answer.answered) return {}
    const contents = answer.value
    const open = contents.indexOf("(")
    const close = contents.lastIndexOf(")")
    if (open === -1 || close === -1 || close < open) return {}
    const comm = contents.slice(open + 1, close)
    // `pid (comm) state ppid …` — state is the first field after comm, so it
    // costs nothing beyond the read already made for identity; the start time
    // is field 22 of the same line, parsed once, by pid-identity.
    const rest = contents
      .slice(close + 1)
      .trim()
      .split(/\s+/u)
    const state = rest[0]
    const ppid = Number(rest[1])
    const startTicks = procStatStartTicks(contents)
    // Field 20, num_threads: the 18th field after comm.
    const threads = Number(rest[17])
    const startedAtMs = startTicksToMs(startTicks, bootedAtMs)
    return {
      comm,
      ...(Number.isSafeInteger(Number(rest[6])) && (Number(rest[6]) & 0x00200000) !== 0
        ? { kernelThread: true as const }
        : {}),
      ...(state === undefined || state === "" ? {} : { state }),
      ...(Number.isSafeInteger(ppid) ? { ppid } : {}),
      ...(startTicks === undefined ? {} : { startTicks }),
      ...(rest[17] !== undefined && Number.isSafeInteger(threads) ? { threads } : {}),
      ...(startedAtMs === undefined ? {} : { startedAt: new Date(startedAtMs).toISOString() }),
    }
  } catch {
    // silent-fallback-allow: identity is optional decoration; pid, denied sources, and incomplete coverage remain in the refusal.
    return {}
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
