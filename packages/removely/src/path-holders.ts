/**
 * Path-holder census migrated from Yrd. The sources are observed independently;
 * a complete result describes one non-atomic proc view, never future producers,
 * inode identity, mount aliases or permission to perform a destructive action.
 */
import { execFile } from "node:child_process"
import { readFile, readdir, readlink, realpath, stat } from "node:fs/promises"
import { resolve, sep } from "node:path"
import { linuxBootTimeMs, procStatStartedAtMs } from "./pid-identity.ts"

export type PathHolderScope = "same-uid" | "all-visible"
export type PathHolderCensusOptions<S extends PathHolderScope = PathHolderScope> = Readonly<{ scope: S }>
export type PathHolder = Readonly<{ pid: number; source: "cwd" | "exe" | "root" | `fd/${string}`; target: string }>
type SourceName = "cwd" | "exe" | "root" | "maps" | "fd"
export type PathHolderUnavailableCoverage = Readonly<{
  /** The process directory was proven absent after its source disappeared. */
  exited: number
  denied: number
  /** A source disappeared while process exit could not be established. */
  missing: number
  /** Evidence cannot be interpreted without guessing at its path. */
  ambiguous: number
}>
export type PathHolderSourceCoverage = Readonly<{
  readable: number
  /** Proven zombie or kernel-thread executable; never inferred from ENOENT alone. */
  notApplicable: number
  unavailable: PathHolderUnavailableCoverage
}>
export type PathHolderObservationIssue = Readonly<{
  source: "process" | SourceName
  resource: string
  reason: "denied" | "missing" | "ambiguous"
  code?: string
}>
export type UnreadableProcess = Readonly<{
  pid: number
  comm?: string
  ppid?: number
  state?: string
  startedAt?: string
  /** Actual permission-denied observations, kept separate from missing evidence. */
  denied: readonly ("process" | SourceName)[]
  issues: readonly PathHolderObservationIssue[]
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
    unavailable: PathHolderUnavailableCoverage
  }>
  sources: Readonly<Record<SourceName, PathHolderSourceCoverage>>
  unreadable?: readonly UnreadableProcess[]
}>
export type DarwinPathHolderCoverage = Readonly<{
  platform: "darwin"
  mechanism: "lsof"
  /** Legacy successful lsof traversal, not proven UID or all-visible coverage. */
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
  if (process.platform === "linux") return linuxPathProcessHolderCensus(root, "/proc", options.scope)
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
  return linuxPathProcessHolderCensus(await canonicalPath(path), procRoot, options.scope)
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

type SourceAvailability = "readable" | "notApplicable" | "exited" | "denied" | "missing" | "ambiguous"
type ObservationIssue = Readonly<{ resource: string; reason: "denied" | "missing" | "ambiguous"; code?: string }>
type SourceObservation<T> = { availability: SourceAvailability; value: T; issues: ObservationIssue[] }
const SOURCES = ["cwd", "exe", "root", "maps", "fd"] as const

async function linuxPathProcessHolderCensus<S extends PathHolderScope>(
  root: string,
  procRoot: string,
  scope: S,
): Promise<PathHolderCensus<S>> {
  const entries = await readdir(procRoot, { withFileTypes: true }).catch((error: unknown) => {
    throw new Error(`Linux path-holder census requires readable proc root '${procRoot}': ${errorDetail(error)}`, {
      cause: error,
    })
  })
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error(`Linux process census requires the current uid for '${procRoot}'`)
  const bootedAtMs = linuxBootTimeMs(procRoot)
  const numericEntries = entries.filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
  const processCoverage = {
    enumerated: numericEntries.length,
    sameUid: 0,
    otherUid: 0,
    admitted: 0,
    inspected: 0,
    excluded: 0,
    zombie: 0,
    unavailable: emptyUnavailableCoverage(),
  }
  const sourceCoverage: Record<SourceName, MutableSourceCoverage> = {
    cwd: emptySourceCoverage(),
    exe: emptySourceCoverage(),
    root: emptySourceCoverage(),
    maps: emptySourceCoverage(),
    fd: emptySourceCoverage(),
  }
  const unreadable: UnreadableProcess[] = []
  const matches = await Promise.all(
    numericEntries.map(async (entry): Promise<PathHolder[]> => {
      const pid = Number(entry.name)
      const proc = `${procRoot}/${entry.name}`
      const metadata = await observeSource(proc, () => stat(proc), undefined)
      // A missing process DIRECTORY is exit evidence; a missing child is not.
      if (metadata.availability === "missing") {
        processCoverage.unavailable.exited += 1
        return []
      }
      const issues: PathHolderObservationIssue[] = metadata.issues.map((issue) => ({ source: "process", ...issue }))
      if (metadata.availability === "denied") processCoverage.unavailable.denied += 1
      const identity = await observeProcessIdentity(proc, bootedAtMs)
      if (metadata.value !== undefined) {
        if (metadata.value.uid === uid) processCoverage.sameUid += 1
        else {
          processCoverage.otherUid += 1
          if (scope === "same-uid") {
            processCoverage.excluded += 1
            return []
          }
        }
      } else if (scope === "same-uid") {
        unreadable.push({ pid, ...identity, denied: ["process"], issues })
        return []
      }
      processCoverage.admitted += 1
      if (identity.state === "Z") {
        processCoverage.zombie += 1
        if (issues.length > 0) unreadable.push({ pid, ...identity, denied: ["process"], issues })
        return []
      }
      processCoverage.inspected += 1
      const [cwd, executable, processRoot, mappedFiles, descriptors] = await Promise.all([
        observeProcessLink(`${proc}/cwd`, root),
        observeProcessLink(`${proc}/exe`, root),
        observeProcessLink(`${proc}/root`, root),
        observeProcessMaps(`${proc}/maps`, root),
        observeProcessDescriptors(`${proc}/fd`, root),
      ])
      const observed = { cwd, exe: executable, root: processRoot, maps: mappedFiles, fd: descriptors }
      if (SOURCES.some((source) => observed[source].issues.some((issue) => issue.reason === "missing"))) {
        const presence = await observeSource(proc, () => stat(proc), undefined)
        const afterIdentity =
          presence.availability === "readable" ? await observeProcessIdentity(proc, bootedAtMs) : undefined
        for (const source of SOURCES) {
          const observation = observed[source]
          if (!observation.issues.some((issue) => issue.reason === "missing")) continue
          const resolvedAvailability =
            presence.availability === "missing"
              ? "exited"
              : afterIdentity?.state === "Z" || (source === "exe" && afterIdentity?.kernelThread === true)
                ? "notApplicable"
                : undefined
          if (resolvedAvailability !== undefined) {
            // A vanished fd and a denied/ambiguous sibling are independent
            // observations. Exit proof clears the vanished source only.
            observation.issues = observation.issues.filter((issue) => issue.reason !== "missing")
            observation.availability = observation.issues[0]?.reason ?? resolvedAvailability
          }
        }
      }
      for (const source of SOURCES) {
        const observation = observed[source]
        recordSourceCoverage(sourceCoverage[source], observation)
        issues.push(...observation.issues.map((issue) => ({ source, ...issue })))
      }
      if (issues.length > 0) {
        unreadable.push({
          pid,
          ...identity,
          denied: [...new Set(issues.filter((issue) => issue.reason === "denied").map((issue) => issue.source))],
          issues,
        })
      }
      const holders: PathHolder[] = []
      for (const [source, value] of [
        ["cwd", cwd.value],
        ["exe", executable.value],
        ["root", processRoot.value],
      ] as const) {
        if (value !== undefined && pathWithin(root, value)) holders.push({ pid, source, target: value })
      }
      for (const mappedFile of mappedFiles.value) {
        if (pathWithin(root, mappedFile)) holders.push({ pid, source: "fd/maps", target: mappedFile })
      }
      for (const descriptor of descriptors.value) {
        if (pathWithin(root, descriptor.target)) {
          holders.push({ pid, source: `fd/${descriptor.name}`, target: descriptor.target })
        }
      }
      return holders
    }),
  )
  const complete =
    processCoverage.unavailable.denied === 0 &&
    Object.values(sourceCoverage).every(
      (coverage) => coverage.unavailable.denied + coverage.unavailable.missing + coverage.unavailable.ambiguous === 0,
    )
  return {
    holders: uniquePathHolders(matches.flat()),
    coverage: {
      platform: "linux",
      scope,
      procRoot,
      complete,
      processes: processCoverage,
      sources: sourceCoverage,
      ...(unreadable.length === 0 ? {} : { unreadable: unreadable.sort((a, b) => a.pid - b.pid) }),
    },
  }
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

type MutableSourceCoverage = {
  readable: number
  notApplicable: number
  unavailable: { exited: number; denied: number; missing: number; ambiguous: number }
}
function emptyUnavailableCoverage() {
  return { exited: 0, denied: 0, missing: 0, ambiguous: 0 }
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
  resource: string,
  read: () => Promise<T>,
  unavailableValue: T,
): Promise<SourceObservation<T>> {
  try {
    return { availability: "readable", value: await read(), issues: [] }
  } catch (error) {
    const code = errorCode(error)
    const availability =
      code === "ENOENT" || code === "ESRCH" ? "missing" : code === "EACCES" || code === "EPERM" ? "denied" : undefined
    if (availability === undefined) {
      throw new Error(`path-holder observation failed at '${resource}': ${errorDetail(error)}`, { cause: error })
    }
    return { availability, value: unavailableValue, issues: [{ resource, reason: availability, code }] }
  }
}
async function observeProcessLink(path: string, root: string): Promise<SourceObservation<string | undefined>> {
  const observed = await observeSource(path, () => readlink(path), undefined)
  if (
    observed.value !== undefined &&
    (ambiguousPathMayHold(root, observed.value) ||
      (!observed.value.startsWith("/") && !/^(?:socket|pipe):\[\d+\]$|^anon_inode:/u.test(observed.value)))
  ) {
    return { ...observed, availability: "ambiguous", issues: [{ resource: path, reason: "ambiguous" }] }
  }
  return observed
}
async function observeProcessMaps(path: string, root: string): Promise<SourceObservation<string[]>> {
  const observed = await observeSource(path, () => readFile(path, "utf8"), "")
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
        ((!target.startsWith("/") && !/^\[[^\]]+\]$/u.test(target)) || ambiguousPathMayHold(root, target)))
    ) {
      issues.push({ resource: path, reason: "ambiguous" })
    }
    if (target?.startsWith("/")) mappedFiles.push(target)
  }
  return { availability: issues.length === 0 ? "readable" : "ambiguous", value: mappedFiles, issues }
}
async function observeProcessDescriptors(
  path: string,
  root: string,
): Promise<SourceObservation<Array<Readonly<{ name: string; target: string }>>>> {
  const directory = await observeSource(path, () => readdir(path), [] as string[])
  if (directory.availability !== "readable") return { ...directory, value: [] }
  const links = await Promise.all(
    directory.value.map(async (name) => ({ name, observed: await observeProcessLink(`${path}/${name}`, root) })),
  )
  const issues = links.flatMap(({ observed }) => observed.issues)
  const availability =
    (["denied", "missing", "ambiguous"] as const).find((reason) =>
      links.some(({ observed }) => observed.availability === reason),
    ) ?? "readable"
  return {
    availability,
    issues,
    value: links.flatMap(({ name, observed }) =>
      observed.value === undefined ? [] : [{ name, target: observed.value }],
    ),
  }
}

/** Optional display metadata never proves exit; only process-directory absence does. */
async function observeProcessIdentity(
  proc: string,
  bootedAtMs: number | undefined,
): Promise<{ comm?: string; ppid?: number; state?: string; startedAt?: string; kernelThread?: true }> {
  try {
    const contents = await readFile(`${proc}/stat`, "utf8")
    const open = contents.indexOf("(")
    const close = contents.lastIndexOf(")")
    if (open === -1 || close === -1 || close < open) return {}
    const comm = contents.slice(open + 1, close)
    // `pid (comm) state ppid …` — state is the first field after comm, so it
    // costs nothing beyond the read already made for identity; the start time
    // is field 22 of the same line, parsed where pid-identity parses it.
    const rest = contents
      .slice(close + 1)
      .trim()
      .split(/\s+/u)
    const state = rest[0]
    const ppid = Number(rest[1])
    const startedAtMs = procStatStartedAtMs(contents, bootedAtMs)
    return {
      comm,
      ...(Number.isSafeInteger(Number(rest[6])) && (Number(rest[6]) & 0x00200000) !== 0
        ? { kernelThread: true as const }
        : {}),
      ...(state === undefined || state === "" ? {} : { state }),
      ...(Number.isSafeInteger(ppid) ? { ppid } : {}),
      ...(startedAtMs === undefined ? {} : { startedAt: new Date(startedAtMs).toISOString() }),
    }
  } catch {
    // silent-fallback-allow: identity is optional decoration; pid, denied sources, and incomplete coverage remain in the refusal.
    return {}
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined
}
function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
