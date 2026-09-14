/**
 * Linux `/proc/[pid]/stat` boot-time and process-start-time parsing.
 *
 * The one parser of `/proc/[pid]/stat` field 22; `path-holders.ts`'s
 * path-holder census is the sole remaining caller, using it to attribute a
 * held path to the process that has held it since before the census began.
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
 * Wall-clock ms at which the process behind this `/proc/[pid]/stat` line
 * started: field 22, in clock ticks since boot, against the boot time. The one
 * parser of that field; the path-holder census reads it through here too.
 *
 * `comm` is field 2, is parenthesized, and may itself contain spaces AND
 * parentheses — so the split point is the LAST `)`, never the first, and never a
 * whitespace split of the whole line.
 */
export function procStatStartedAtMs(stat: string, bootedAtMs: number | undefined): number | undefined {
  if (bootedAtMs === undefined) return undefined
  const close = stat.lastIndexOf(")")
  if (close < 0) return undefined
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/u)
  // fields[0] is `state`, which is field 3; field 22 is therefore index 19.
  const ticks = Number(fields[19])
  return Number.isFinite(ticks) && ticks >= 0 ? bootedAtMs + (ticks / LINUX_USER_HZ) * 1_000 : undefined
}
