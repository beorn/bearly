/**
 * Linux `/proc/[pid]/stat` boot-time and process-start-time parsing.
 *
 * The one parser of `/proc/[pid]/stat` field 22 in this package: the
 * path-holder census reads each row's start through `procStatStartTicks`, both
 * as the ticks it compares and, through `startTicksToMs`, as the wall-clock time
 * it names.
 */

import { readFileSync } from "node:fs"

/**
 * Linux fixes USER_HZ at 100 for `/proc/[pid]/stat` regardless of CONFIG_HZ; it
 * is ABI, which is why procps hardcodes it too.
 */
const LINUX_USER_HZ = 100

/**
 * Boot time in wall-clock ms, from `btime` in `/proc/stat`; undefined when the
 * proc root carries none. One value per host, so a census reads it once.
 */
export function linuxBootTimeMs(procRoot: string): number | undefined {
  let raw: string
  try {
    raw = readFileSync(`${procRoot}/stat`, "utf8")
  } catch {
    // silent-fallback-allow: without btime there is no start time, which the
    // classifier reports as an unproven identity rather than as liveness.
    return undefined
  }
  const line = raw.split("\n").find((candidate) => candidate.startsWith("btime "))
  if (line === undefined) return undefined
  const seconds = Number(line.slice("btime ".length).trim())
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : undefined
}

/**
 * Field 22 of a `/proc/[pid]/stat` line: the clock tick since boot at which the
 * process started, as the kernel wrote it; undefined when the line has no such
 * field.
 *
 * `comm` is field 2, is parenthesized, and may itself contain spaces AND
 * parentheses — so the split point is the LAST `)`, never the first, and never a
 * whitespace split of the whole line.
 */
export function procStatStartTicks(stat: string): number | undefined {
  const close = stat.lastIndexOf(")")
  if (close < 0) return undefined
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/u)
  // fields[0] is `state`, which is field 3; field 22 is therefore index 19.
  const field = fields[19]
  const ticks = Number(field)
  return field !== undefined && Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : undefined
}

/** Wall-clock ms for a start tick against the boot time; undefined without either. */
export function startTicksToMs(ticks: number | undefined, bootedAtMs: number | undefined): number | undefined {
  return ticks === undefined || bootedAtMs === undefined ? undefined : bootedAtMs + (ticks / LINUX_USER_HZ) * 1_000
}
