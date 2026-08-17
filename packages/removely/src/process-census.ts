import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readlinkSync, statSync } from "node:fs"
import { isAbsolute } from "node:path"

export interface ProcessCwdRow {
  readonly pid: number
  readonly cwd: string
}

export type ProcessCwdCensus =
  | {
      readonly available: true
      readonly rows: readonly ProcessCwdRow[]
      readonly reason: string
    }
  | {
      readonly available: false
      readonly reason: string
    }

export interface ProcessCwdCensusCommandResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly error?: string
}

/** Explicit host seams keep the destructive-operation proof deterministic in tests. */
export interface ProcessCwdCensusDeps {
  readonly platform: NodeJS.Platform
  readonly uid: number
  readonly maxProcesses: number
  readonly listLinuxPids: () => readonly number[]
  readonly linuxPidUid: (pid: number) => number | undefined
  readonly linuxPidCwd: (pid: number) => string
  readonly runDarwinLsof: (uid: number) => ProcessCwdCensusCommandResult
}

const DEFAULT_MAX_PROCESSES = 32_768
const CENSUS_TIMEOUT_MS = 2_000
const CENSUS_MAX_BUFFER = 8 * 1024 * 1024

function unavailable(reason: string): ProcessCwdCensus {
  return { available: false, reason }
}

function errorCode(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code
  return error instanceof Error ? error.message : String(error)
}

function defaultDeps(): ProcessCwdCensusDeps | ProcessCwdCensus {
  const uid = process.getuid?.()
  if (uid === undefined) return unavailable("current uid is unavailable")

  return {
    platform: process.platform,
    uid,
    maxProcesses: DEFAULT_MAX_PROCESSES,
    listLinuxPids: () =>
      readdirSync("/proc")
        .filter((entry) => /^\d+$/u.test(entry))
        .map(Number)
        .sort((left, right) => left - right),
    linuxPidUid: (pid) => {
      try {
        return statSync(`/proc/${pid}`).uid
      } catch (error) {
        const code = errorCode(error)
        if (code === "ENOENT" || code === "ESRCH") return undefined
        throw error
      }
    },
    linuxPidCwd: (pid) => readlinkSync(`/proc/${pid}/cwd`),
    runDarwinLsof: (ownerUid) => {
      const lsof = ["/usr/sbin/lsof", "/usr/bin/lsof"].find(existsSync)
      if (lsof === undefined) return { status: null, stdout: "", stderr: "", error: "lsof is unavailable" }
      const result = spawnSync(lsof, ["-a", "-u", String(ownerUid), "-d", "cwd", "-F0pn"], {
        encoding: "utf8",
        timeout: CENSUS_TIMEOUT_MS,
        maxBuffer: CENSUS_MAX_BUFFER,
        stdio: ["ignore", "pipe", "pipe"],
      })
      return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        ...(result.error === undefined ? {} : { error: result.error.message }),
      }
    },
  }
}

function censusLinux(deps: ProcessCwdCensusDeps): ProcessCwdCensus {
  let processIds: readonly number[]
  try {
    processIds = deps.listLinuxPids()
  } catch (error) {
    return unavailable(`cannot enumerate /proc: ${errorCode(error)}`)
  }
  if (processIds.length > deps.maxProcesses) return unavailable(`process count exceeds ${deps.maxProcesses}`)

  const rows: ProcessCwdRow[] = []
  for (const pid of processIds) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return unavailable(`invalid process id ${String(pid)}`)
    let ownerUid: number | undefined
    try {
      ownerUid = deps.linuxPidUid(pid)
    } catch (error) {
      return unavailable(`cannot inspect /proc/${pid} owner: ${errorCode(error)}`)
    }
    if (ownerUid === undefined || ownerUid !== deps.uid) continue

    let cwd: string
    try {
      cwd = deps.linuxPidCwd(pid)
    } catch (error) {
      const code = errorCode(error)
      // EACCES: same-uid process whose /proc/<pid>/cwd we still cannot read (e.g. Yama
      // ptrace_scope blocking a non-ancestor from reading systemd --user's cwd symlink).
      // ENOENT/ESRCH: pid exited between the uid check above and this read (TOCTOU).
      // Neither means the census itself is untrustworthy — only that this one pid can't
      // be attributed to a cwd, so skip it rather than aborting every other row.
      if (code === "ENOENT" || code === "ESRCH" || code === "EACCES") continue
      return unavailable(`cannot read /proc/${pid}/cwd: ${errorCode(error)}`)
    }
    if (!isAbsolute(cwd)) return unavailable(`/proc/${pid}/cwd is not absolute`)
    rows.push({ pid, cwd })
  }
  return { available: true, rows, reason: "Linux /proc census" }
}

function censusDarwin(deps: ProcessCwdCensusDeps): ProcessCwdCensus {
  const result = deps.runDarwinLsof(deps.uid)
  const stderr = result.stderr.trim()
  if (result.error !== undefined || result.status !== 0 || stderr.length > 0) {
    return unavailable(result.error ?? (stderr || `lsof exit ${String(result.status)}`))
  }

  const rows = new Map<number, ProcessCwdRow>()
  let pid: number | undefined
  for (const rawField of result.stdout.split("\0")) {
    const field = rawField.startsWith("\n") ? rawField.slice(1) : rawField
    if (field.length === 0) continue
    if (field.startsWith("p")) {
      const parsed = Number(field.slice(1))
      if (!Number.isSafeInteger(parsed) || parsed <= 0) return unavailable("lsof returned an invalid process id")
      pid = parsed
      continue
    }
    if (!field.startsWith("n")) continue
    if (pid === undefined) return unavailable("lsof returned a CWD without a process id")
    const cwd = field.slice(1)
    if (!isAbsolute(cwd)) return unavailable(`lsof returned a non-absolute CWD for pid ${pid}`)
    rows.set(pid, { pid, cwd })
    if (rows.size > deps.maxProcesses) return unavailable(`process count exceeds ${deps.maxProcesses}`)
  }
  if (rows.size === 0) return unavailable("lsof returned no process CWDs")
  return { available: true, rows: [...rows.values()], reason: "macOS lsof census" }
}

/**
 * Bounded, uid-scoped census. A pid that vanishes or whose cwd is unreadable is skipped,
 * not attributed to any cwd — it cannot silently keep an unrelated path alive, but it also
 * cannot be proven to occupy one. Any other observation failure still invalidates the whole
 * result, since that signals the census mechanism itself is untrustworthy.
 */
export function censusProcessCwds(injected?: ProcessCwdCensusDeps): ProcessCwdCensus {
  const deps = injected ?? defaultDeps()
  if ("available" in deps) return deps
  if (!Number.isSafeInteger(deps.uid) || deps.uid < 0) return unavailable("current uid is invalid")
  if (!Number.isSafeInteger(deps.maxProcesses) || deps.maxProcesses <= 0) {
    return unavailable("process census bound is invalid")
  }
  if (deps.platform === "linux") return censusLinux(deps)
  if (deps.platform === "darwin") return censusDarwin(deps)
  return unavailable(`unsupported platform ${deps.platform}`)
}
