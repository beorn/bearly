import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { isAbsolute } from "node:path"

export interface ProcessCwdRow {
  readonly pid: number
  readonly cwd: string
}

/** @internal The macOS lsof run, as a seam so the parse is tested without a Mac. */
export interface LsofResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly error?: string
}

const DEFAULT_MAX_PROCESSES = 32_768
const CENSUS_TIMEOUT_MS = 2_000
const CENSUS_MAX_BUFFER = 8 * 1024 * 1024

function runLsof(uid: number): LsofResult {
  const lsof = ["/usr/sbin/lsof", "/usr/bin/lsof"].find(existsSync)
  if (lsof === undefined) return { status: null, stdout: "", stderr: "", error: "lsof is unavailable" }
  const result = spawnSync(lsof, ["-a", "-u", String(uid), "-d", "cwd", "-F0pn"], {
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
}

/**
 * @internal macOS has no /proc, so the cwd projection reads every same-uid cwd from lsof. Any lsof failure, an
 * unparsable row or an empty answer throws: there is no partial census.
 */
export function darwinProcessCwds(
  run: (uid: number) => LsofResult = runLsof,
  maxProcesses = DEFAULT_MAX_PROCESSES,
): ProcessCwdRow[] {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("macOS cwd census: the current uid is unavailable")
  const result = run(uid)
  const stderr = result.stderr.trim()
  if (result.error !== undefined || result.status !== 0 || stderr.length > 0) {
    throw new Error(`macOS cwd census: ${result.error ?? (stderr || `lsof exit ${String(result.status)}`)}`)
  }

  const rows = new Map<number, ProcessCwdRow>()
  let pid: number | undefined
  for (const rawField of result.stdout.split("\0")) {
    const field = rawField.startsWith("\n") ? rawField.slice(1) : rawField
    if (field.length === 0) continue
    if (field.startsWith("p")) {
      const parsed = Number(field.slice(1))
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error("macOS cwd census: lsof returned an invalid pid")
      }
      pid = parsed
      continue
    }
    if (!field.startsWith("n")) continue
    if (pid === undefined) throw new Error("macOS cwd census: lsof returned a cwd without a pid")
    const cwd = field.slice(1)
    if (!isAbsolute(cwd)) throw new Error(`macOS cwd census: lsof returned a non-absolute cwd for pid ${pid}`)
    rows.set(pid, { pid, cwd })
    if (rows.size > maxProcesses) throw new Error(`macOS cwd census: process count exceeds ${maxProcesses}`)
  }
  if (rows.size === 0) throw new Error("macOS cwd census: lsof returned no process cwds")
  return [...rows.values()]
}
