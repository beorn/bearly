/**
 * Tribe plugin: Health Monitor — samples machine health metrics and broadcasts
 * alerts when CPU load, memory pressure, or process counts exceed thresholds.
 *
 * Config via env vars:
 *   HEALTH_POLL_INTERVAL  — seconds between samples (default: 10)
 *   HEALTH_CPU_WARNING    — load avg multiplier for warning (default: 0.8)
 *   HEALTH_CPU_CRITICAL   — load avg multiplier for critical (default: 1.5)
 *   HEALTH_MEM_WARNING    — memory % for warning (default: 85)
 *   HEALTH_MEM_CRITICAL   — memory % for critical (default: 95)
 *   HEALTH_PROC_WARNING   — bun/node process count for warning (default: 50)
 *   HEALTH_DISK_WARNING   — disk usage % for warning (default: 85)
 *   HEALTH_DISK_CRITICAL   — disk usage % for critical (default: 95)
 *   HEALTH_WORKTREE_WARNING — open worktree count for warning (default: 5)
 *   HEALTH_GH_RATELIMIT_WARNING — GitHub API remaining % for warning (default: 20)
 *   HEALTH_FD_WARNING      — fd usage % for warning (default: 70)
 *   HEALTH_DISK_IO_WARNING — combined read+write MB/s for warning (default: 500)
 *   HEALTH_REAPER_ENABLED     — enable process reaper (default: "1")
 *   HEALTH_REAPER_CPU_THRESHOLD — CPU % threshold for suspect (default: 80)
 *   HEALTH_REAPER_AGE_MINUTES  — minimum process age in minutes (default: 30)
 *   HEALTH_REAPER_GRACE_SAMPLES — samples to wait after asking before kill (default: 6)
 */

import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { cpus, totalmem, freemem, loadavg } from "node:os"
import { createLogger } from "loggily"
import { createTimers } from "./timers.ts"
import type { TribePluginApi, TribeClientApi } from "./plugin-api.ts"

const log = createLogger("tribe:health")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthMetrics {
  cpu: {
    loadAvg1m: number
    loadAvg5m: number
    coreCount: number
    topProcesses: Array<{ pid: number; cpu: number; mem: number; command: string }>
  }
  memory: {
    totalMB: number
    usedMB: number
    availableMB: number
    pressurePercent: number
    swapUsedMB: number
  }
  disk?: {
    totalGB: number
    usedGB: number
    availableGB: number
    usagePercent: number
  }
  diskIo?: {
    readWriteMBps: number
  }
  fdCount?: {
    total: number
    perSession: Array<{ name: string; count: number }>
    limit: number
  }
  ghRateLimit?: {
    remaining: number
    limit: number
    resetAt: number // Unix timestamp
    usagePercent: number
  }
  bunProcesses: number
  worktrees: number
  timestamp: number
}

export interface HealthAlert {
  type:
    | "cpu"
    | "memory"
    | "process-count"
    | "git-lock"
    | "disk"
    | "disk-io"
    | "worktree"
    | "fd-count"
    | "gh-rate-limit"
    | "reaper"
  severity: "warning" | "critical"
  message: string
  metrics: Partial<HealthMetrics>
  topOffenders: Array<{ pid: number; cpu: number; mem: number; command: string }>
}

export interface ReaperSuspect {
  firstSeen: number
  samples: number
  asked: boolean
  command: string
  cpu: number
  etime: string
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export interface HealthThresholds {
  cpuWarningMultiplier: number
  cpuCriticalMultiplier: number
  memWarningPercent: number
  memCriticalPercent: number
  processCountWarning: number
  diskWarningPercent: number
  diskCriticalPercent: number
  worktreeWarning: number
  fdWarningPercent: number
  /** Alert when combined read+write exceeds this MB/s sustained */
  diskIoWarningMBps: number
  /** Alert when GitHub API remaining % drops below this (default: 20) */
  ghRateLimitWarning: number
  /** How many consecutive samples above threshold before alerting */
  sustainedSamples: number
  /** Reaper: enabled (default: true) */
  reaperEnabled: boolean
  /** Reaper: CPU % threshold for suspect detection (default: 80) */
  reaperCpuThreshold: number
  /** Reaper: minimum process age in minutes before suspect (default: 30) */
  reaperAgeMinutes: number
  /** Reaper: samples to wait after asking before killing (default: 6, i.e. 60s at 10s interval) */
  reaperGraceSamples: number
}

export function defaultThresholds(): HealthThresholds {
  return {
    cpuWarningMultiplier: parseFloat(process.env.HEALTH_CPU_WARNING ?? "0.8"),
    cpuCriticalMultiplier: parseFloat(process.env.HEALTH_CPU_CRITICAL ?? "1.5"),
    memWarningPercent: parseInt(process.env.HEALTH_MEM_WARNING ?? "85", 10),
    memCriticalPercent: parseInt(process.env.HEALTH_MEM_CRITICAL ?? "95", 10),
    processCountWarning: parseInt(process.env.HEALTH_PROC_WARNING ?? "50", 10),
    diskWarningPercent: parseInt(process.env.HEALTH_DISK_WARNING ?? "85", 10),
    diskCriticalPercent: parseInt(process.env.HEALTH_DISK_CRITICAL ?? "95", 10),
    worktreeWarning: parseInt(process.env.HEALTH_WORKTREE_WARNING ?? "5", 10),
    fdWarningPercent: parseInt(process.env.HEALTH_FD_WARNING ?? "70", 10),
    diskIoWarningMBps: parseInt(process.env.HEALTH_DISK_IO_WARNING ?? "500", 10),
    ghRateLimitWarning: parseInt(process.env.HEALTH_GH_RATELIMIT_WARNING ?? "20", 10),
    // At 10s interval, 3 samples = 30s sustained
    sustainedSamples: 3,
    reaperEnabled: process.env.HEALTH_REAPER_ENABLED !== "0",
    reaperCpuThreshold: parseInt(process.env.HEALTH_REAPER_CPU_THRESHOLD ?? "80", 10),
    reaperAgeMinutes: parseInt(process.env.HEALTH_REAPER_AGE_MINUTES ?? "30", 10),
    reaperGraceSamples: parseInt(process.env.HEALTH_REAPER_GRACE_SAMPLES ?? "6", 10),
  }
}

// ---------------------------------------------------------------------------
// Metrics collection
// ---------------------------------------------------------------------------

/** Collect OS-level metrics (no child process needed). */
export function collectOsMetrics(): Omit<HealthMetrics, "bunProcesses" | "worktrees" | "disk" | "cpu"> & {
  cpu: Omit<HealthMetrics["cpu"], "topProcesses">
} {
  const [load1, load5] = loadavg()
  const totalBytes = totalmem()
  const freeBytes = freemem()
  const totalMB = Math.round(totalBytes / 1024 / 1024)
  const availableMB = Math.round(freeBytes / 1024 / 1024)
  const usedMB = totalMB - availableMB
  const pressurePercent = Math.round((usedMB / totalMB) * 100)

  return {
    cpu: {
      loadAvg1m: Math.round(load1! * 100) / 100,
      loadAvg5m: Math.round(load5! * 100) / 100,
      coreCount: cpus().length,
    },
    memory: {
      totalMB,
      usedMB,
      availableMB,
      pressurePercent,
      swapUsedMB: 0, // Populated by collectSwapUsage on macOS
    },
    timestamp: Date.now(),
  }
}

/** Parse macOS `sysctl vm.swapusage` output. */
export function parseSwapUsage(output: string): number {
  // Format: "vm.swapusage: total = 2048.00M  used = 123.45M  free = 1924.55M"
  const match = output.match(/used\s*=\s*([\d.]+)M/)
  return match ? parseFloat(match[1]!) : 0
}

/**
 * Parse macOS `vm_stat` output into a count of pages by category, plus page size.
 *
 * On macOS, Node's os.freemem() returns ONLY pages from the "free" pool — it does
 * not count "inactive" or "speculative" pages even though those are reclaimable
 * on demand. So a healthy system with 10 GB free + 50 GB inactive is reported as
 * "96% used" by os.freemem()-based math, triggering false "memory critical"
 * alarms. The fix is to parse vm_stat directly and compute pressure from the
 * pages that are actually in use — matching what Activity Monitor reports as
 * "Memory Used" (app memory + wired + compressed) and treating inactive +
 * speculative as reclaimable. See km-tribe.reliability-sweep-0415.
 *
 * Typical output header:
 *   Mach Virtual Memory Statistics: (page size of 16384 bytes)
 *   Pages free:                               641676.
 *   Pages active:                            3502447.
 *   Pages inactive:                          3101917.
 *   Pages speculative:                        461909.
 *   Pages wired down:                        1234567.
 *   Pages occupied by compressor:             234567.
 *   ...
 */
export function parseVmStat(output: string): {
  pageSizeBytes: number
  free: number
  active: number
  inactive: number
  speculative: number
  wired: number
  compressed: number
} {
  const pageSizeMatch = output.match(/page size of (\d+) bytes/)
  const pageSizeBytes = pageSizeMatch ? parseInt(pageSizeMatch[1]!, 10) : 16384

  const readPages = (label: string): number => {
    const re = new RegExp(`${label}:\\s*(\\d+)\\.?`)
    const m = output.match(re)
    return m ? parseInt(m[1]!, 10) : 0
  }

  return {
    pageSizeBytes,
    free: readPages("Pages free"),
    active: readPages("Pages active"),
    inactive: readPages("Pages inactive"),
    speculative: readPages("Pages speculative"),
    wired: readPages("Pages wired down"),
    compressed: readPages("Pages occupied by compressor"),
  }
}

/** Parse `ps aux` output to extract top processes. */
export function parseProcessList(psOutput: string): Array<{ pid: number; cpu: number; mem: number; command: string }> {
  const lines = psOutput.trim().split("\n")
  // Skip header
  const results: Array<{ pid: number; cpu: number; mem: number; command: string }> = []
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i]!.trim().split(/\s+/)
    // ps aux columns: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND...
    if (parts.length < 11) continue
    const pid = parseInt(parts[1]!, 10)
    const cpu = parseFloat(parts[2]!)
    const mem = parseFloat(parts[3]!)
    const command = parts.slice(10).join(" ")
    if (!isNaN(pid) && !isNaN(cpu) && !isNaN(mem)) {
      results.push({ pid, cpu, mem, command })
    }
  }
  return results
}

/** Build a PID → parent PID map from `ps -eo pid,ppid` output */
export function buildPidToParent(psOutput: string): Map<number, number> {
  const map = new Map<number, number>()
  for (const line of psOutput.trim().split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 2) {
      const pid = parseInt(parts[0]!, 10)
      const ppid = parseInt(parts[1]!, 10)
      if (!isNaN(pid) && !isNaN(ppid)) map.set(pid, ppid)
    }
  }
  return map
}

/**
 * Attribute a process to a tribe session by walking the PPID chain.
 * Session PIDs are stdio-adapter PIDs — their parent is the Claude Code process.
 * High-CPU processes are siblings (other children of the same Claude Code parent).
 */
export function attributeToSession(
  pid: number,
  pidToParent: Map<number, number>,
  sessions: Array<{ name: string; pid: number }>,
): string | null {
  // Build session parent PID map: Claude Code PID → session name
  const sessionParentToName = new Map<number, string>()
  for (const s of sessions) {
    const parentPid = pidToParent.get(s.pid)
    if (parentPid !== undefined) {
      sessionParentToName.set(parentPid, s.name)
    }
    // Also match the session PID itself
    sessionParentToName.set(s.pid, s.name)
  }

  // Walk up the PPID chain from the target process
  let current = pid
  const visited = new Set<number>()
  while (current > 1 && !visited.has(current)) {
    visited.add(current)
    const parent = pidToParent.get(current)
    if (parent === undefined) break

    // Check if the parent is a known Claude Code process
    const sessionName = sessionParentToName.get(parent)
    if (sessionName) return sessionName

    current = parent
  }

  return null
}

/** Count bun/node processes from a parsed process list. */
export function countBunNodeProcesses(processes: Array<{ command: string }>): number {
  return processes.filter((p) => /\b(bun|node)\b/.test(p.command)).length
}

/** Get top N CPU consumers from a parsed process list. */
export function topCpuConsumers(
  processes: Array<{ pid: number; cpu: number; mem: number; command: string }>,
  n = 5,
): Array<{ pid: number; cpu: number; mem: number; command: string }> {
  return [...processes]
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, n)
    .map((p) => ({
      pid: p.pid,
      cpu: p.cpu,
      mem: p.mem,
      command: p.command.slice(0, 80),
    }))
}

/** Parse `df -g .` output to extract disk usage (macOS format). */
export function parseDfOutput(
  output: string,
): { totalGB: number; usedGB: number; availableGB: number; usagePercent: number } | null {
  const lines = output.trim().split("\n")
  // Skip header; parse first data line
  // Columns: Filesystem 1G-blocks Used Available Capacity Mounted_on
  if (lines.length < 2) return null
  const parts = lines[1]!.trim().split(/\s+/)
  if (parts.length < 5) return null
  const totalGB = parseInt(parts[1]!, 10)
  const usedGB = parseInt(parts[2]!, 10)
  const availableGB = parseInt(parts[3]!, 10)
  const capacityMatch = parts[4]!.match(/(\d+)%/)
  const usagePercent = capacityMatch ? parseInt(capacityMatch[1]!, 10) : 0
  if (isNaN(totalGB) || isNaN(usedGB) || isNaN(availableGB)) return null
  return { totalGB, usedGB, availableGB, usagePercent }
}

/** Parse `git worktree list` output to count worktrees. */
export function parseWorktreeList(output: string): number {
  const trimmed = output.trim()
  if (trimmed === "") return 0
  return trimmed.split("\n").length
}

// ---------------------------------------------------------------------------
// GitHub API rate limit
// ---------------------------------------------------------------------------

/** Parse `gh api rate_limit` JSON output. */
export function parseGhRateLimit(jsonOutput: string): { remaining: number; limit: number; resetAt: number } | null {
  try {
    const data = JSON.parse(jsonOutput) as Record<string, unknown>
    const resources = data?.resources as Record<string, unknown> | undefined
    const core = resources?.core as Record<string, unknown> | undefined
    if (
      core &&
      typeof core.remaining === "number" &&
      typeof core.limit === "number" &&
      typeof core.reset === "number"
    ) {
      return { remaining: core.remaining, limit: core.limit, resetAt: core.reset }
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// File descriptor monitoring
// ---------------------------------------------------------------------------

/** Parse the system file descriptor limit from `ulimit -n` output. */
export function parseUlimitOutput(output: string): number {
  const n = parseInt(output.trim(), 10)
  return isNaN(n) ? 0 : n
}

/** Compute fd usage info from a total count and ulimit. */
export function parseFdInfo(
  lsofCount: number,
  ulimitN: number,
): { total: number; limit: number; usagePercent: number } {
  const limit = ulimitN > 0 ? ulimitN : 1 // Avoid division by zero
  return {
    total: lsofCount,
    limit,
    usagePercent: Math.round((lsofCount / limit) * 100),
  }
}

// ---------------------------------------------------------------------------
// Disk I/O monitoring
// ---------------------------------------------------------------------------

/** Parse macOS `iostat -d -c 2 -w 1` output to extract current disk throughput */
export function parseIostatOutput(output: string): { readWriteMBps: number } | null {
  const lines = output.trim().split("\n")
  // iostat -d -c 2 -w 1 output:
  //               disk0
  //     KB/t  tps  MB/s
  //    52.57   95  4.88    <- historical average (ignore)
  //    64.00  150  9.38    <- current sample (use this)
  //
  // We want the LAST data line (second sample = current rate).
  // Data lines have numeric values; skip headers.
  let lastMBps: number | null = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    // Match lines that look like data: numbers separated by whitespace
    const parts = trimmed.split(/\s+/)
    if (parts.length < 3) continue
    const mbps = parseFloat(parts[parts.length - 1]!)
    if (isNaN(mbps)) continue
    // Verify it's a data line by checking the first column is also numeric
    const first = parseFloat(parts[0]!)
    if (isNaN(first)) continue
    lastMBps = mbps
  }
  if (lastMBps === null) return null
  return { readWriteMBps: lastMBps }
}

// ---------------------------------------------------------------------------
// Git lock detection
// ---------------------------------------------------------------------------

export interface GitLockInfo {
  /** Absolute path to the lock file */
  path: string
  /** Short label: "main" for .git/index.lock, submodule name for modules lock */
  label: string
  /** PID and command of the process holding the lock (null if stale/unknown) */
  holder: { pid: number; command: string } | null
}

/** Parse lsof output to extract PID and command of file holder */
export function parseLsofOutput(output: string): { pid: number; command: string } | null {
  const lines = output.trim().split("\n")
  // Skip header line; parse first data line
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i]!.trim().split(/\s+/)
    // lsof columns: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
    if (parts.length < 2) continue
    const command = parts[0]!
    const pid = parseInt(parts[1]!, 10)
    if (!isNaN(pid)) return { pid, command }
  }
  return null
}

/**
 * Find all git lock files: main repo + submodules.
 * Checks .git/index.lock and .git/modules/{name}/index.lock.
 */
export function findGitLockPaths(gitDir: string): Array<{ path: string; label: string }> {
  const locks: Array<{ path: string; label: string }> = []

  // Main repo lock
  const mainLock = `${gitDir}/index.lock`
  if (existsSync(mainLock)) {
    locks.push({ path: mainLock, label: "main" })
  }

  // Submodule locks: .git/modules/*/index.lock
  const modulesDir = `${gitDir}/modules`
  if (existsSync(modulesDir)) {
    try {
      const entries = readdirSync(modulesDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const subLock = `${modulesDir}/${entry.name}/index.lock`
        if (existsSync(subLock)) {
          locks.push({ path: subLock, label: entry.name })
        }
      }
    } catch {
      // Can't read modules dir — skip
    }
  }

  return locks
}

/**
 * Check if .git/index.lock exists and identify who holds it.
 * Returns null if no lock, or { pid, command } of the lock holder.
 */
export async function detectGitLock(gitDir: string): Promise<{ pid: number; command: string } | null> {
  const lockPath = `${gitDir}/index.lock`
  if (!existsSync(lockPath)) return null

  try {
    const proc = Bun.spawn(["lsof", lockPath], { stdout: "pipe", stderr: "ignore" })
    const output = await new Response(proc.stdout).text()
    return parseLsofOutput(output)
  } catch {
    // lsof failed — lock exists but we can't determine holder (stale lock)
    return null
  }
}

/**
 * Detect all git locks (main repo + submodules) and identify holders via lsof.
 * Returns an array of lock info objects with path, label, and holder details.
 */
export async function detectGitLocks(gitDir: string): Promise<GitLockInfo[]> {
  const lockPaths = findGitLockPaths(gitDir)
  if (lockPaths.length === 0) return []

  const results: GitLockInfo[] = []
  for (const { path, label } of lockPaths) {
    let holder: { pid: number; command: string } | null = null
    try {
      const proc = Bun.spawn(["lsof", path], { stdout: "pipe", stderr: "ignore" })
      const output = await new Response(proc.stdout).text()
      holder = parseLsofOutput(output)
    } catch {
      // lsof failed — lock exists but we can't determine holder
    }
    results.push({ path, label, holder })
  }
  return results
}

/**
 * Threshold in ms before alerting about a git lock with a live holder.
 *
 * Holderless locks never reach this threshold — they're reaped silently
 * after LOCK_REAP_AGE_MS (see below). This threshold applies only to locks
 * with an attributable holder via lsof: a slow git op, a hook running
 * lint/format/tsc, or a genuinely stuck process.
 *
 * 15s = 1.5x the default 10s poll interval, so the lock must genuinely
 * span more than one poll cycle before warning. Attribution (the holder's
 * session name when known) further filters noise.
 */
export const LOCK_ALERT_THRESHOLD_MS = 15_000

/** Threshold in ms for escalating a lock to a stale warning */
export const LOCK_STALE_THRESHOLD_MS = 30_000

/**
 * Minimum age in ms before auto-reaping a holderless lock.
 *
 * Git acquires `.git/index.lock` via `open(O_CREAT|O_EXCL)` and an active
 * holder is always visible via `lsof`. A lock with no holder is stale by
 * definition — there's no process to atomically rename it into place.
 *
 * The TOCTOU race between O_EXCL succeeding and the kernel registering the
 * FD visibly to lsof is sub-millisecond. A 1s guard closes it with zero
 * practical cost; real git ops complete in milliseconds.
 */
export const LOCK_REAP_AGE_MS = 1_000

/**
 * Attempt to reap a stale lock if it has no holder and has aged past the
 * race-guard threshold. Returns true if the lock was removed.
 *
 * Uses file mtime (when the lock was created) for age, not poll-based
 * "first-seen" — a fresh lock gets the full 1s grace regardless of when
 * the daemon noticed it.
 */
export function reapStaleLock(lock: GitLockInfo, nowMs: number = Date.now()): boolean {
  if (lock.holder) return false
  let fileMtimeMs: number
  try {
    fileMtimeMs = statSync(lock.path).mtimeMs
  } catch {
    // Already gone — treat as reaped.
    return true
  }
  if (nowMs - fileMtimeMs < LOCK_REAP_AGE_MS) return false
  try {
    unlinkSync(lock.path)
    return true
  } catch {
    // Race: another process reaped it, or we lack permissions.
    return false
  }
}

// ---------------------------------------------------------------------------
// Alert evaluation
// ---------------------------------------------------------------------------

export interface AlertState {
  cpuAboveCritical: number
  cpuAboveWarning: number
  memAboveCritical: number
  memAboveWarning: number
  diskAboveCritical: number
  diskAboveWarning: number
  /** Consecutive high disk I/O readings */
  ioAboveWarning: number
  /** Track which alerts have been fired to avoid repeating */
  firedAlerts: Set<string>
  /** Per-alert last-fire timestamps (used by rate-limited alerts like chief:expired) */
  firedAt: Map<string, number>
  /** Track if we've already alerted about a git lock (dedup) */
  gitLockDetected: boolean
  /** Track when each lock was first seen — key is lock path, value is timestamp */
  lockFirstSeen: Map<string, number>
  /** Track which locks have had their stale warning sent */
  lockStaleWarned: Set<string>
  /** Reaper: tracked suspect PIDs with detection state */
  reaperSuspects: Map<number, ReaperSuspect>
}

export function createAlertState(): AlertState {
  return {
    cpuAboveCritical: 0,
    cpuAboveWarning: 0,
    memAboveCritical: 0,
    memAboveWarning: 0,
    diskAboveCritical: 0,
    diskAboveWarning: 0,
    ioAboveWarning: 0,
    firedAlerts: new Set(),
    firedAt: new Map(),
    gitLockDetected: false,
    lockFirstSeen: new Map(),
    lockStaleWarned: new Set(),
    reaperSuspects: new Map(),
  }
}

/**
 * Format a git lock message for tribe broadcast.
 * Returns short plain-text messages suitable for tribe protocol.
 */
export function formatLockMessage(lock: GitLockInfo, sessionName: string | null, durationSec: number): string {
  const holder = formatLockHolder(lock, sessionName)
  const lockTarget = lock.label === "main" ? ".git/index.lock" : `.git/modules/${lock.label}/index.lock`
  return `git lock: ${lockTarget} held by ${holder} for ${durationSec}s`
}

/**
 * Format a stale lock warning message (>30s).
 */
export function formatStaleLockMessage(lock: GitLockInfo, sessionName: string | null, durationSec: number): string {
  const holder = formatLockHolder(lock, sessionName)
  const lockTarget = lock.label === "main" ? ".git/index.lock" : `.git/modules/${lock.label}/index.lock`
  return `git lock WARNING: ${lockTarget} held >${Math.floor(durationSec)}s by ${holder} -- may be stale`
}

/**
 * Format the lock holder — prefer "<session> (PID <pid>)" when both are known,
 * since the session name is what a human remembers but the PID is still the
 * useful handle for `kill`/`ps`. Fall back to one or the other, or "unknown".
 */
function formatLockHolder(lock: GitLockInfo, sessionName: string | null): string {
  const pid = lock.holder?.pid
  if (sessionName && pid !== undefined) return `${sessionName} (PID ${pid})`
  if (sessionName) return sessionName
  if (pid !== undefined) return `PID ${pid}`
  return "unknown"
}

/**
 * Evaluate metrics against thresholds and return any new alerts.
 * Mutates `state` to track sustained conditions.
 */
export function evaluateAlerts(metrics: HealthMetrics, thresholds: HealthThresholds, state: AlertState): HealthAlert[] {
  const alerts: HealthAlert[] = []
  const cores = metrics.cpu.coreCount
  const load = metrics.cpu.loadAvg1m

  // --- CPU ---
  const cpuCriticalThreshold = cores * thresholds.cpuCriticalMultiplier
  const cpuWarningThreshold = cores * thresholds.cpuWarningMultiplier

  if (load > cpuCriticalThreshold) {
    state.cpuAboveCritical++
    state.cpuAboveWarning++
  } else if (load > cpuWarningThreshold) {
    state.cpuAboveCritical = 0
    state.cpuAboveWarning++
  } else {
    state.cpuAboveCritical = 0
    state.cpuAboveWarning = 0
    state.firedAlerts.delete("cpu:critical")
    state.firedAlerts.delete("cpu:warning")
  }

  if (state.cpuAboveCritical >= thresholds.sustainedSamples && !state.firedAlerts.has("cpu:critical")) {
    state.firedAlerts.add("cpu:critical")
    state.firedAlerts.delete("cpu:warning") // Supersedes warning
    alerts.push({
      type: "cpu",
      severity: "critical",
      message: `CPU critical: load ${load} exceeds ${cpuCriticalThreshold.toFixed(1)} (${cores} cores x ${thresholds.cpuCriticalMultiplier}) for ${thresholds.sustainedSamples * 10}s`,
      metrics: { cpu: metrics.cpu },
      topOffenders: metrics.cpu.topProcesses.slice(0, 5),
    })
  } else if (
    state.cpuAboveWarning >= thresholds.sustainedSamples &&
    !state.firedAlerts.has("cpu:warning") &&
    !state.firedAlerts.has("cpu:critical")
  ) {
    state.firedAlerts.add("cpu:warning")
    alerts.push({
      type: "cpu",
      severity: "warning",
      message: `CPU warning: load ${load} exceeds ${cpuWarningThreshold.toFixed(1)} (${cores} cores x ${thresholds.cpuWarningMultiplier}) for ${thresholds.sustainedSamples * 10}s`,
      metrics: { cpu: metrics.cpu },
      topOffenders: metrics.cpu.topProcesses.slice(0, 5),
    })
  }

  // --- Memory ---
  const memPressure = metrics.memory.pressurePercent

  if (memPressure > thresholds.memCriticalPercent) {
    state.memAboveCritical++
    state.memAboveWarning++
  } else if (memPressure > thresholds.memWarningPercent) {
    state.memAboveCritical = 0
    state.memAboveWarning++
  } else {
    state.memAboveCritical = 0
    state.memAboveWarning = 0
    state.firedAlerts.delete("memory:critical")
    state.firedAlerts.delete("memory:warning")
  }

  if (state.memAboveCritical >= 1 && !state.firedAlerts.has("memory:critical")) {
    state.firedAlerts.add("memory:critical")
    state.firedAlerts.delete("memory:warning")
    alerts.push({
      type: "memory",
      severity: "critical",
      message: `Memory critical: ${memPressure}% used (${metrics.memory.usedMB}MB / ${metrics.memory.totalMB}MB), swap: ${metrics.memory.swapUsedMB}MB`,
      metrics: { memory: metrics.memory },
      topOffenders: metrics.cpu.topProcesses.slice(0, 5),
    })
  } else if (
    state.memAboveWarning >= 1 &&
    !state.firedAlerts.has("memory:warning") &&
    !state.firedAlerts.has("memory:critical")
  ) {
    state.firedAlerts.add("memory:warning")
    alerts.push({
      type: "memory",
      severity: "warning",
      message: `Memory warning: ${memPressure}% used (${metrics.memory.usedMB}MB / ${metrics.memory.totalMB}MB)`,
      metrics: { memory: metrics.memory },
      topOffenders: metrics.cpu.topProcesses.slice(0, 5),
    })
  }

  // --- Process count ---
  if (metrics.bunProcesses > thresholds.processCountWarning) {
    if (!state.firedAlerts.has("process-count:warning")) {
      state.firedAlerts.add("process-count:warning")
      alerts.push({
        type: "process-count",
        severity: "warning",
        message: `Process count warning: ${metrics.bunProcesses} bun/node processes (threshold: ${thresholds.processCountWarning})`,
        metrics: { bunProcesses: metrics.bunProcesses },
        topOffenders: metrics.cpu.topProcesses.slice(0, 5),
      })
    }
  } else {
    state.firedAlerts.delete("process-count:warning")
  }

  // --- Disk ---
  if (metrics.disk) {
    const diskUsage = metrics.disk.usagePercent
    if (diskUsage > thresholds.diskCriticalPercent) {
      if (!state.firedAlerts.has("disk:critical")) {
        state.firedAlerts.add("disk:critical")
        state.firedAlerts.delete("disk:warning") // Supersedes warning
        alerts.push({
          type: "disk",
          severity: "critical",
          message: `Disk critical: ${diskUsage}% used (${metrics.disk.usedGB}GB / ${metrics.disk.totalGB}GB, ${metrics.disk.availableGB}GB available)`,
          metrics: { disk: metrics.disk },
          topOffenders: [],
        })
      }
    } else if (diskUsage > thresholds.diskWarningPercent) {
      if (!state.firedAlerts.has("disk:warning") && !state.firedAlerts.has("disk:critical")) {
        state.firedAlerts.add("disk:warning")
        alerts.push({
          type: "disk",
          severity: "warning",
          message: `Disk warning: ${diskUsage}% used (${metrics.disk.usedGB}GB / ${metrics.disk.totalGB}GB, ${metrics.disk.availableGB}GB available)`,
          metrics: { disk: metrics.disk },
          topOffenders: [],
        })
      }
    } else {
      state.firedAlerts.delete("disk:critical")
      state.firedAlerts.delete("disk:warning")
    }
  }

  // --- Worktrees ---
  if (metrics.worktrees > thresholds.worktreeWarning) {
    if (!state.firedAlerts.has("worktree:warning")) {
      state.firedAlerts.add("worktree:warning")
      alerts.push({
        type: "worktree",
        severity: "warning",
        message: `Worktree count warning: ${metrics.worktrees} open worktrees (threshold: ${thresholds.worktreeWarning}). Run 'bun worktree clean' to remove stale ones.`,
        metrics: {},
        topOffenders: [],
      })
    }
  } else {
    state.firedAlerts.delete("worktree:warning")
  }

  // --- File descriptors ---
  if (metrics.fdCount) {
    const usagePercent = (metrics.fdCount.total / metrics.fdCount.limit) * 100
    if (usagePercent > thresholds.fdWarningPercent) {
      if (!state.firedAlerts.has("fd-count:warning")) {
        state.firedAlerts.add("fd-count:warning")
        alerts.push({
          type: "fd-count",
          severity: "warning",
          message: `FD count warning: ${metrics.fdCount.total} open fds (${Math.round(usagePercent)}% of ${metrics.fdCount.limit} limit)`,
          metrics: {},
          topOffenders: [],
        })
      }
    } else {
      state.firedAlerts.delete("fd-count:warning")
    }
  }

  return alerts
}

// ---------------------------------------------------------------------------
// Process reaper — auto-kill stuck bun/node processes
// ---------------------------------------------------------------------------

/**
 * Parse `ps` etime field to minutes.
 * Formats: "MM:SS", "HH:MM:SS", "D-HH:MM:SS", or just seconds.
 */
export function parseEtime(etime: string): number {
  const trimmed = etime.trim()
  if (!trimmed) return 0

  // Format: D-HH:MM:SS
  const dayMatch = trimmed.match(/^(\d+)-(\d+):(\d+):(\d+)$/)
  if (dayMatch) {
    const days = parseInt(dayMatch[1]!, 10)
    const hours = parseInt(dayMatch[2]!, 10)
    const mins = parseInt(dayMatch[3]!, 10)
    return days * 24 * 60 + hours * 60 + mins
  }

  // Format: HH:MM:SS
  const hmsMatch = trimmed.match(/^(\d+):(\d+):(\d+)$/)
  if (hmsMatch) {
    const hours = parseInt(hmsMatch[1]!, 10)
    const mins = parseInt(hmsMatch[2]!, 10)
    return hours * 60 + mins
  }

  // Format: MM:SS
  const msMatch = trimmed.match(/^(\d+):(\d+)$/)
  if (msMatch) {
    return parseInt(msMatch[1]!, 10)
  }

  return 0
}

/**
 * Check for stuck bun/node processes and manage the reaper lifecycle:
 * 1. Detect suspects (>cpuThreshold% CPU, >ageMinutes old, bun/node)
 * 2. Track for 3 consecutive samples before asking
 * 3. Ask sessions to claim ownership (broadcast query)
 * 4. Kill unclaimed after graceSamples more samples
 */
export async function checkReaper(
  topProcesses: Array<{ pid: number; cpu: number; command: string }>,
  pidToParent: Map<number, number>,
  sessions: Array<{ name: string; pid: number; role: string }>,
  thresholds: HealthThresholds,
  state: AlertState,
  api: TribeClientApi,
): Promise<void> {
  if (!thresholds.reaperEnabled) return

  const now = Date.now()
  const seenPids = new Set<number>()

  // Find high-CPU bun/node processes
  const highCpuProcs = topProcesses.filter(
    (p) => p.cpu > thresholds.reaperCpuThreshold && /\b(bun|node)\b/.test(p.command),
  )

  for (const proc of highCpuProcs) {
    seenPids.add(proc.pid)

    // Skip processes owned by active sessions
    const owner = attributeToSession(proc.pid, pidToParent, sessions)
    if (owner) continue

    // Check process age via ps -p <pid> -o etime=
    let etime = ""
    let ageMinutes = 0
    try {
      const etimeProc = Bun.spawn(["ps", "-p", String(proc.pid), "-o", "etime="], {
        stdout: "pipe",
        stderr: "ignore",
      })
      etime = (await new Response(etimeProc.stdout).text()).trim()
      ageMinutes = parseEtime(etime)
    } catch {
      continue // Can't determine age — skip
    }

    if (ageMinutes < thresholds.reaperAgeMinutes) continue

    // Track or update suspect
    const existing = state.reaperSuspects.get(proc.pid)
    if (existing) {
      existing.samples++
      existing.cpu = proc.cpu
      existing.etime = etime
    } else {
      state.reaperSuspects.set(proc.pid, {
        firstSeen: now,
        samples: 1,
        asked: false,
        command: proc.command.slice(0, 80),
        cpu: proc.cpu,
        etime,
      })
    }
  }

  // Prune suspects no longer in the high-CPU list
  for (const [pid] of state.reaperSuspects) {
    if (!seenPids.has(pid)) {
      state.reaperSuspects.delete(pid)
    }
  }

  // Process suspects through the lifecycle
  for (const [pid, suspect] of state.reaperSuspects) {
    // After 3 samples: ask sessions to claim
    if (suspect.samples >= 3 && !suspect.asked) {
      suspect.asked = true
      const msg = `health:reaper: PID ${pid} (${suspect.command}) at ${suspect.cpu}% CPU for ${suspect.etime}. Is this yours? Reply within 60s or it will be killed.`
      log.info?.(`reaper: asking about PID ${pid}`)
      api.broadcast(msg, "health:reaper:query", undefined, {
        delivery: "push",
        pluginKind: "health:reaper:query",
      })
    }

    // After 3 + graceSamples: check for claims, then kill
    if (suspect.asked && suspect.samples >= 3 + thresholds.reaperGraceSamples) {
      // Check if anyone claimed this PID
      const claimed = api.hasRecentMessage(`reaper:claim PID ${pid}`)
      if (claimed) {
        log.info?.(`reaper: PID ${pid} claimed by a session, removing from suspects`)
        state.reaperSuspects.delete(pid)
        continue
      }

      // Verify process still exists and is still high-CPU before killing
      let stillAlive = false
      try {
        const checkProc = Bun.spawn(["ps", "-p", String(pid), "-o", "pid="], {
          stdout: "pipe",
          stderr: "ignore",
        })
        const checkOutput = (await new Response(checkProc.stdout).text()).trim()
        stillAlive = checkOutput.length > 0
      } catch {
        stillAlive = false
      }

      if (!stillAlive) {
        state.reaperSuspects.delete(pid)
        continue
      }

      // Kill: SIGTERM first
      log.info?.(
        `reaper: killing PID ${pid} (${suspect.command}) — unclaimed after ${thresholds.reaperGraceSamples * 10}s`,
      )
      try {
        process.kill(pid, "SIGTERM")
      } catch {
        // Process may have already exited
        state.reaperSuspects.delete(pid)
        continue
      }

      // Wait 2s, then SIGKILL if still alive
      await new Promise((resolve) => setTimeout(resolve, 2000))
      try {
        process.kill(pid, 0) // Check if still alive
        process.kill(pid, "SIGKILL")
        log.info?.(`reaper: SIGKILL sent to PID ${pid}`)
      } catch {
        // Already dead from SIGTERM — good
      }

      const killMsg = `health:reaper: killed PID ${pid} (${suspect.command}) — unclaimed after ${thresholds.reaperGraceSamples * 10}s, ${suspect.cpu}% CPU for ${suspect.etime}`
      api.broadcast(killMsg, "health:reaper:killed", undefined, {
        delivery: "pull",
        pluginKind: "health:reaper:killed",
      })
      state.reaperSuspects.delete(pid)
    }
  }
}

// ---------------------------------------------------------------------------
// Full metrics collection (async — spawns ps)
// ---------------------------------------------------------------------------

async function collectFullMetrics(): Promise<{ metrics: HealthMetrics; pidToParent: Map<number, number> }> {
  const osMetrics = collectOsMetrics()

  let topProcesses: Array<{ pid: number; cpu: number; mem: number; command: string }> = []
  let bunProcesses = 0
  let swapUsedMB = 0
  let pidToParent = new Map<number, number>()
  let disk: HealthMetrics["disk"]
  let worktrees = 0
  let fdCount: HealthMetrics["fdCount"]

  try {
    // Run ps aux, ps -eo pid,ppid, df -g ., git worktree list, lsof count, and ulimit in parallel
    const psAuxProc = Bun.spawn(["ps", "aux"], { stdout: "pipe", stderr: "ignore" })
    const psPpidProc = Bun.spawn(["ps", "-eo", "pid,ppid"], { stdout: "pipe", stderr: "ignore" })
    const dfProc = Bun.spawn(["df", "-g", "."], { stdout: "pipe", stderr: "ignore" })
    const wtProc = Bun.spawn(["git", "worktree", "list"], { stdout: "pipe", stderr: "ignore" })
    const fdCountProc = Bun.spawn(["sh", "-c", "lsof -n 2>/dev/null | wc -l"], { stdout: "pipe", stderr: "ignore" })
    const ulimitProc = Bun.spawn(["sh", "-c", "ulimit -n"], { stdout: "pipe", stderr: "ignore" })
    const [psAuxOutput, psPpidOutput, dfOutput, wtOutput, fdCountOutput, ulimitOutput] = await Promise.all([
      new Response(psAuxProc.stdout).text(),
      new Response(psPpidProc.stdout).text(),
      new Response(dfProc.stdout).text().catch(() => ""),
      new Response(wtProc.stdout).text().catch(() => ""),
      new Response(fdCountProc.stdout).text().catch(() => "0"),
      new Response(ulimitProc.stdout).text().catch(() => "0"),
    ])
    const allProcesses = parseProcessList(psAuxOutput)
    topProcesses = topCpuConsumers(allProcesses)
    bunProcesses = countBunNodeProcesses(allProcesses)
    pidToParent = buildPidToParent(psPpidOutput)
    disk = parseDfOutput(dfOutput) ?? undefined
    worktrees = parseWorktreeList(wtOutput)

    // File descriptor count
    const lsofCount = parseInt(fdCountOutput.trim(), 10) || 0
    const ulimitN = parseUlimitOutput(ulimitOutput)
    if (ulimitN > 0) {
      const fdInfo = parseFdInfo(lsofCount, ulimitN)
      fdCount = { total: fdInfo.total, perSession: [], limit: fdInfo.limit }
    }
  } catch (err) {
    log.debug?.(`ps failed: ${err instanceof Error ? err.message : err}`)
  }

  // macOS swap detection + accurate memory pressure via vm_stat.
  // os.freemem() on Darwin reports only truly-free pages and misses the
  // ~50 GB of inactive/compressed memory that is reclaimable on demand, so
  // it systematically over-reports pressure ("96% used" with 60 GB actually
  // available). Override with vm_stat-derived numbers matching Activity
  // Monitor semantics. See km-tribe.reliability-sweep-0415.
  let memoryOverride: { usedMB: number; availableMB: number; pressurePercent: number } | null = null
  if (process.platform === "darwin") {
    try {
      const swapProc = Bun.spawn(["sysctl", "vm.swapusage"], { stdout: "pipe", stderr: "ignore" })
      const swapOutput = await new Response(swapProc.stdout).text()
      swapUsedMB = parseSwapUsage(swapOutput)
    } catch {
      // Swap info unavailable — not critical
    }
    try {
      const vmStatProc = Bun.spawn(["vm_stat"], { stdout: "pipe", stderr: "ignore" })
      const vmStatOutput = await new Response(vmStatProc.stdout).text()
      const vm = parseVmStat(vmStatOutput)
      const bytesPerMB = 1024 * 1024
      const toMB = (pages: number): number => Math.round((pages * vm.pageSizeBytes) / bytesPerMB)

      // "Genuinely used" = active + wired + compressed. This is what
      // Activity Monitor shows as "Memory Used".
      const usedMB = toMB(vm.active + vm.wired + vm.compressed)
      // "Available" = free + inactive + speculative. Inactive pages are
      // reclaimable on demand without pressure; speculative is page cache.
      const availableMB = toMB(vm.free + vm.inactive + vm.speculative)
      const totalMB = usedMB + availableMB
      const pressurePercent = totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : 0
      memoryOverride = { usedMB, availableMB, pressurePercent }
    } catch {
      // Fall back to os.freemem() values if vm_stat is unavailable
    }
  }

  return {
    metrics: {
      cpu: {
        ...osMetrics.cpu,
        topProcesses,
      },
      memory: {
        ...osMetrics.memory,
        ...memoryOverride,
        swapUsedMB,
      },
      disk,
      fdCount,
      bunProcesses,
      worktrees,
      timestamp: osMetrics.timestamp,
    },
    pidToParent,
  }
}

// ---------------------------------------------------------------------------
// On-demand health snapshot (for tribe_health_check requests)
// ---------------------------------------------------------------------------

export async function getHealthSnapshot(): Promise<HealthMetrics> {
  const { metrics } = await collectFullMetrics()
  return metrics
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export const healthMonitorPlugin: TribePluginApi = {
  name: "health-monitor",

  available() {
    // Always available — uses only OS APIs
    return true
  },

  start(api: TribeClientApi) {
    const pollIntervalSec = parseInt(process.env.HEALTH_POLL_INTERVAL ?? "10", 10) || 10
    const thresholds = defaultThresholds()
    const alertState = createAlertState()

    const ac = new AbortController()
    const timers = createTimers(ac.signal)

    let ghRateSampleCount = 0
    let ioSampleCount = 0

    log.info?.(
      `starting: poll=${pollIntervalSec}s, cpu warn=${thresholds.cpuWarningMultiplier}x crit=${thresholds.cpuCriticalMultiplier}x, mem warn=${thresholds.memWarningPercent}% crit=${thresholds.memCriticalPercent}%`,
    )

    async function sample(): Promise<void> {
      try {
        const { metrics, pidToParent } = await collectFullMetrics()
        const alerts = evaluateAlerts(metrics, thresholds, alertState)
        const sessions = api.getActiveSessions()

        for (const alert of alerts) {
          // Group offenders by session
          const sessionLoad = new Map<string, { total: number; procs: string[] }>()
          for (const p of alert.topOffenders) {
            const session = attributeToSession(p.pid, pidToParent, sessions)
            const key = session ?? "unattributed"
            const entry = sessionLoad.get(key) ?? { total: 0, procs: [] }
            entry.total += p.cpu
            entry.procs.push(`${p.cpu}% ${p.command.slice(0, 30)}`)
            sessionLoad.set(key, entry)
          }

          // Format: "km-3: 45% bun vitest | unattributed: 8% mds_stores"
          const parts: string[] = []
          for (const [name, load] of sessionLoad) {
            parts.push(`${name}: ${load.procs.join(", ")}`)
          }
          const attribution = parts.length > 0 ? `. ${parts.join(" | ")}` : ""
          const msg = `${alert.message}${attribution}`
          log.info?.(`alert: ${msg}`)

          // km-tribe.event-classification: criticals are actionable (push) so
          // a session pays attention; warnings are ambient (pull). The reply
          // hint is derived at delivery time (kind + sender role + recipient).
          const isCritical = alert.severity === "critical"
          const dmClass = {
            delivery: "push",
            pluginKind: `health:${alert.type}:${alert.severity}`,
          } as const
          const broadcastClass = {
            delivery: isCritical ? "push" : "pull",
            pluginKind: `health:${alert.type}:${alert.severity}`,
          } as const
          // Route: DM each responsible session
          const attributedSessions = new Set<string>()
          for (const [name] of sessionLoad) {
            if (name !== "unattributed") {
              attributedSessions.add(name)
              api.send(name, msg, `health:${alert.type}:${alert.severity}`, undefined, dmClass)
            }
          }

          // Critical: also broadcast to everyone
          if (alert.severity === "critical") {
            api.broadcast(msg, `health:${alert.type}:${alert.severity}`, undefined, broadcastClass)
          } else if (attributedSessions.size === 0 && api.hasChief()) {
            // Warning with no attributed sessions (e.g. disk, worktree): send to chief
            api.send("chief", msg, `health:${alert.type}:${alert.severity}`, undefined, dmClass)
          } else {
            // Warning: send to chief if unattributed processes exist
            if (sessionLoad.has("unattributed") && api.hasChief()) {
              api.send("chief", msg, `health:${alert.type}:${alert.severity}`, undefined, dmClass)
            }
          }
        }

        // --- Process reaper ---
        await checkReaper(metrics.cpu.topProcesses, pidToParent, sessions, thresholds, alertState, api)

        // --- Git lock detection (main repo + submodules) ---
        const gitDir = `${process.cwd()}/.git`
        const locks = await detectGitLocks(gitDir)
        const now = Date.now()
        const activeLockPaths = new Set<string>()

        for (const lock of locks) {
          activeLockPaths.add(lock.path)

          // Auto-reap holderless locks: git uses O_EXCL, no holder = stale.
          // Silent + logged on daemon (not broadcast) so reaps are observable
          // for incident analysis without flooding agent channels.
          if (!lock.holder && reapStaleLock(lock, now)) {
            log.info?.(`git-lock reaped: path=${lock.path} label=${lock.label} (no holder)`)
            // Drop tracking for this lock — it's gone.
            alertState.lockFirstSeen.delete(lock.path)
            alertState.lockStaleWarned.delete(lock.path)
            alertState.firedAlerts.delete(`git-lock:${lock.path}`)
            activeLockPaths.delete(lock.path)
            continue
          }

          // Track when we first saw this lock
          if (!alertState.lockFirstSeen.has(lock.path)) {
            alertState.lockFirstSeen.set(lock.path, now)
          }
          const firstSeen = alertState.lockFirstSeen.get(lock.path)!
          const durationMs = now - firstSeen
          const durationSec = Math.round(durationMs / 1000)

          // Attribute to a session if possible
          const sessionName = lock.holder ? attributeToSession(lock.holder.pid, pidToParent, sessions) : null

          // First detection: broadcast lock info. Suppress unattributed locks
          // under the stale threshold — "held by unknown for 10s" is almost
          // always concurrent commits across sessions briefly overlapping the
          // poll window, not a real stuck process. If we CAN attribute the
          // holder (lsof found a known session's PID), warn at the shorter
          // threshold so the owner knows they're blocking the tribe.
          const lockKey = `git-lock:${lock.path}`
          const shouldAlert =
            !alertState.firedAlerts.has(lockKey) &&
            durationMs >= LOCK_ALERT_THRESHOLD_MS &&
            (sessionName != null || durationMs >= LOCK_STALE_THRESHOLD_MS)
          if (shouldAlert) {
            alertState.gitLockDetected = true
            alertState.firedAlerts.add(lockKey)
            const lockMsg = formatLockMessage(lock, sessionName, durationSec)
            log.info?.(`alert: ${lockMsg}`)

            // km-tribe.event-classification: first-detect git-lock is ambient
            // (most are concurrent commits resolving in <30s). The session
            // attributed to the lock still gets a DM so the holder can act —
            // the channel envelope's reply hint is derived at delivery time.
            if (sessionName) {
              api.send(sessionName, lockMsg, "health:git-lock:warning", undefined, {
                delivery: "push",
                pluginKind: "health:git-lock:warning",
              })
            }
            api.broadcast(lockMsg, "health:git-lock:warning", undefined, {
              delivery: "pull",
              pluginKind: "health:git-lock:warning",
            })
          }

          // Stale lock escalation: >30s — actionable, the lock is stuck.
          if (durationMs > LOCK_STALE_THRESHOLD_MS && !alertState.lockStaleWarned.has(lock.path)) {
            alertState.lockStaleWarned.add(lock.path)
            const staleMsg = formatStaleLockMessage(lock, sessionName, durationMs / 1000)
            log.info?.(`alert: ${staleMsg}`)
            api.broadcast(staleMsg, "health:git-lock:warning", undefined, {
              delivery: "push",
              pluginKind: "health:git-lock:stale",
            })
          }
        }

        // Clean up tracking for released locks
        for (const [path] of alertState.lockFirstSeen) {
          if (!activeLockPaths.has(path)) {
            alertState.lockFirstSeen.delete(path)
            alertState.lockStaleWarned.delete(path)
            alertState.firedAlerts.delete(`git-lock:${path}`)
          }
        }
        if (locks.length === 0 && alertState.gitLockDetected) {
          alertState.gitLockDetected = false
        }

        // --- Disk I/O saturation (every 3rd sample — ~30s) ---
        ioSampleCount++
        if (ioSampleCount % 3 === 0) {
          try {
            const ioProc = Bun.spawn(["iostat", "-d", "-c", "2", "-w", "1"], { stdout: "pipe", stderr: "ignore" })
            const ioOutput = await new Response(ioProc.stdout).text()
            const io = parseIostatOutput(ioOutput)
            if (io && io.readWriteMBps > thresholds.diskIoWarningMBps) {
              alertState.ioAboveWarning++
              if (alertState.ioAboveWarning >= 2 && !alertState.firedAlerts.has("disk-io:warning")) {
                alertState.firedAlerts.add("disk-io:warning")
                const msg = `Disk I/O warning: ${io.readWriteMBps.toFixed(0)} MB/s sustained (threshold: ${thresholds.diskIoWarningMBps} MB/s). Multiple agents may be running tests simultaneously.`
                log.info?.(`alert: ${msg}`)
                api.broadcast(msg, "health:disk-io:warning", undefined, {
                  delivery: "pull",
                  pluginKind: "health:disk-io:warning",
                })
              }
            } else {
              alertState.ioAboveWarning = 0
              alertState.firedAlerts.delete("disk-io:warning")
            }
          } catch {
            // iostat not available — skip silently
          }
        }

        // --- GitHub API rate limit (every 5th sample — ~50s) ---
        ghRateSampleCount++
        if (ghRateSampleCount % 5 === 0) {
          try {
            const ghProc = Bun.spawn(["gh", "api", "rate_limit"], { stdout: "pipe", stderr: "ignore" })
            const ghOutput = await new Response(ghProc.stdout).text()
            const rateLimit = parseGhRateLimit(ghOutput)
            if (rateLimit) {
              const usagePercent = ((rateLimit.limit - rateLimit.remaining) / rateLimit.limit) * 100
              const remainingPercent = 100 - usagePercent
              if (
                remainingPercent < thresholds.ghRateLimitWarning &&
                !alertState.firedAlerts.has("gh-rate-limit:warning")
              ) {
                alertState.firedAlerts.add("gh-rate-limit:warning")
                const resetIn = Math.max(0, Math.round((rateLimit.resetAt * 1000 - Date.now()) / 60000))
                const msg = `GitHub API rate limit warning: ${rateLimit.remaining}/${rateLimit.limit} remaining (${Math.round(remainingPercent)}%). Resets in ${resetIn}min.`
                log.info?.(`alert: ${msg}`)
                api.broadcast(msg, "health:gh-rate-limit:warning", undefined, {
                  delivery: "push",
                  pluginKind: "health:gh-rate-limit:warning",
                })
              } else if (remainingPercent >= thresholds.ghRateLimitWarning) {
                alertState.firedAlerts.delete("gh-rate-limit:warning")
              }
            }
          } catch {
            // gh not available — skip silently
          }
        }
      } catch (err) {
        log.error?.(`sample failed: ${err instanceof Error ? err.message : err}`)
      }
    }

    // Initial sample after a short delay (let daemon finish startup)
    timers.setTimeout(() => void sample(), 2_000)

    // Regular sampling
    timers.setInterval(() => void sample(), pollIntervalSec * 1000)

    return () => ac.abort()
  },

  instructions() {
    return "- Health monitoring active: CPU, memory, process count, disk space, disk I/O, worktree count, file descriptor count, GitHub API rate limit, git lock alerts, and process reaper are broadcast automatically. To claim a process the reaper is targeting, reply with 'reaper:claim PID <pid>'."
  },
}
