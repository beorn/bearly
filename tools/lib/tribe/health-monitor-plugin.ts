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
 */

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
  bunProcesses: number
  timestamp: number
}

export interface HealthAlert {
  type: "cpu" | "memory" | "process-count"
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
    // At 10s interval, 3 samples = 30s sustained
    sustainedSamples: 3,
  }
}

// ---------------------------------------------------------------------------
// Metrics collection
// ---------------------------------------------------------------------------

/** Collect OS-level metrics (no child process needed). */
export function collectOsMetrics(): Omit<HealthMetrics, "bunProcesses" | "cpu"> & {
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

// ---------------------------------------------------------------------------
// Alert evaluation
// ---------------------------------------------------------------------------

export interface AlertState {
  cpuAboveCritical: number
  cpuAboveWarning: number
  memAboveCritical: number
  memAboveWarning: number
  /** Track which alerts have been fired to avoid repeating */
  firedAlerts: Set<string>
}

export function createAlertState(): AlertState {
  return {
    cpuAboveCritical: 0,
    cpuAboveWarning: 0,
    memAboveCritical: 0,
    memAboveWarning: 0,
    firedAlerts: new Set(),
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

  try {
    // Run ps aux and ps -eo pid,ppid in parallel
    const psAuxProc = Bun.spawn(["ps", "aux"], { stdout: "pipe", stderr: "ignore" })
    const psPpidProc = Bun.spawn(["ps", "-eo", "pid,ppid"], { stdout: "pipe", stderr: "ignore" })
    const [psAuxOutput, psPpidOutput] = await Promise.all([
      new Response(psAuxProc.stdout).text(),
      new Response(psPpidProc.stdout).text(),
    ])
    const allProcesses = parseProcessList(psAuxOutput)
    topProcesses = topCpuConsumers(allProcesses)
    bunProcesses = countBunNodeProcesses(allProcesses)
    pidToParent = buildPidToParent(psPpidOutput)
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
      bunProcesses,
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
            const attribution = parts.join(" | ")
            const msg = `${alert.message}. ${attribution}`
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
            } else {
              // Warning: send to chief if unattributed processes exist
              if (sessionLoad.has("unattributed") && ctx.hasChief()) {
                ctx.sendMessage("chief", msg, `health:${alert.type}:${alert.severity}`)
              }
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
      return "- Health monitoring active: CPU, memory, and process count alerts are broadcast automatically"
    },
  }
}
