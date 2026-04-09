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
 */

import { existsSync } from "node:fs"
import { cpus, totalmem, freemem, loadavg } from "node:os"
import { createLogger } from "loggily"
import { createTimers } from "./timers.ts"
import type { TribePlugin, PluginContext } from "./plugins.ts"

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
  type: "cpu" | "memory" | "process-count" | "git-lock" | "disk" | "disk-io" | "worktree" | "fd-count" | "gh-rate-limit"
  severity: "warning" | "critical"
  message: string
  metrics: Partial<HealthMetrics>
  topOffenders: Array<{ pid: number; cpu: number; mem: number; command: string }>
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
 * Session PIDs are tribe-proxy PIDs — their parent is the Claude Code process.
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
export function parseGhRateLimit(
  jsonOutput: string,
): { remaining: number; limit: number; resetAt: number } | null {
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
  /** Track if we've already alerted about a git lock (dedup) */
  gitLockDetected: boolean
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
    gitLockDetected: false,
  }
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
    log.warn?.(`ps failed: ${err instanceof Error ? err.message : err}`)
  }

  // macOS swap detection
  if (process.platform === "darwin") {
    try {
      const swapProc = Bun.spawn(["sysctl", "vm.swapusage"], { stdout: "pipe", stderr: "ignore" })
      const swapOutput = await new Response(swapProc.stdout).text()
      swapUsedMB = parseSwapUsage(swapOutput)
    } catch {
      // Swap info unavailable — not critical
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

export function healthMonitorPlugin(): TribePlugin {
  return {
    name: "health-monitor",

    available() {
      // Always available — uses only OS APIs
      return true
    },

    start(ctx) {
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
          const sessions = ctx.getActiveSessions()

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

            // Route: DM each responsible session
            const attributedSessions = new Set<string>()
            for (const [name] of sessionLoad) {
              if (name !== "unattributed") {
                attributedSessions.add(name)
                ctx.sendMessage(name, msg, `health:${alert.type}:${alert.severity}`)
              }
            }

            // Critical: also broadcast to everyone
            if (alert.severity === "critical") {
              ctx.sendMessage("*", msg, `health:${alert.type}:${alert.severity}`)
            } else if (attributedSessions.size === 0 && ctx.hasChief()) {
              // Warning with no attributed sessions (e.g. disk, worktree): send to chief
              ctx.sendMessage("chief", msg, `health:${alert.type}:${alert.severity}`)
            } else {
              // Warning: send to chief if unattributed processes exist
              if (sessionLoad.has("unattributed") && ctx.hasChief()) {
                ctx.sendMessage("chief", msg, `health:${alert.type}:${alert.severity}`)
              }
            }
          }

          // --- Git lock detection ---
          const gitDir = `${process.cwd()}/.git`
          const lockHolder = await detectGitLock(gitDir)
          if (lockHolder) {
            if (!alertState.gitLockDetected) {
              alertState.gitLockDetected = true
              alertState.firedAlerts.add("git-lock")
              const sessionName = attributeToSession(lockHolder.pid, pidToParent, sessions)
              const holder = sessionName ?? `PID ${lockHolder.pid}`
              const lockMsg = `Git lock held by ${holder} (${lockHolder.command}) for ${gitDir}/index.lock`
              log.info?.(`alert: ${lockMsg}`)

              // DM responsible session
              if (sessionName) {
                ctx.sendMessage(sessionName, lockMsg, "health:git-lock:warning")
              }
              // Send to chief
              if (ctx.hasChief()) {
                ctx.sendMessage("chief", lockMsg, "health:git-lock:warning")
              }
            }
          } else {
            // Lock released — clear dedup state
            if (alertState.gitLockDetected) {
              alertState.gitLockDetected = false
              alertState.firedAlerts.delete("git-lock")
            }
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
                  ctx.sendMessage("*", msg, "health:disk-io:warning")
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
                  ctx.sendMessage("*", msg, "health:gh-rate-limit:warning")
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
      return "- Health monitoring active: CPU, memory, process count, disk space, disk I/O, worktree count, file descriptor count, GitHub API rate limit, and git lock alerts are broadcast automatically"
    },
  }
}
