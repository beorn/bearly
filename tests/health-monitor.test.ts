/**
 * Health monitor plugin — unit tests
 *
 * Tests the extracted core logic (metrics collection, alert evaluation,
 * process parsing, threshold detection) without requiring a running daemon.
 */

import { describe, test, expect } from "vitest"

import {
  collectOsMetrics,
  parseSwapUsage,
  parseProcessList,
  countBunNodeProcesses,
  topCpuConsumers,
  evaluateAlerts,
  createAlertState,
  defaultThresholds,
  type HealthMetrics,
  type HealthThresholds,
} from "../tools/lib/tribe/health-monitor-plugin.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetrics(overrides: Partial<HealthMetrics> = {}): HealthMetrics {
  return {
    cpu: {
      loadAvg1m: 2.0,
      loadAvg5m: 1.5,
      coreCount: 10,
      topProcesses: [
        { pid: 100, cpu: 50, mem: 10, command: "bun tribe-daemon.ts" },
        { pid: 200, cpu: 30, mem: 5, command: "node server.js" },
        { pid: 300, cpu: 10, mem: 2, command: "vim" },
      ],
      ...overrides.cpu,
    },
    memory: {
      totalMB: 16384,
      usedMB: 8192,
      availableMB: 8192,
      pressurePercent: 50,
      swapUsedMB: 0,
      ...overrides.memory,
    },
    bunProcesses: overrides.bunProcesses ?? 5,
    timestamp: overrides.timestamp ?? Date.now(),
  }
}

function makeThresholds(overrides: Partial<HealthThresholds> = {}): HealthThresholds {
  return {
    cpuWarningMultiplier: 0.8,
    cpuCriticalMultiplier: 1.5,
    memWarningPercent: 85,
    memCriticalPercent: 95,
    processCountWarning: 50,
    sustainedSamples: 3,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// collectOsMetrics
// ---------------------------------------------------------------------------

describe("collectOsMetrics", () => {
  test("returns CPU load averages as numbers", () => {
    const metrics = collectOsMetrics()
    expect(typeof metrics.cpu.loadAvg1m).toBe("number")
    expect(typeof metrics.cpu.loadAvg5m).toBe("number")
    expect(metrics.cpu.loadAvg1m).toBeGreaterThanOrEqual(0)
    expect(metrics.cpu.loadAvg5m).toBeGreaterThanOrEqual(0)
  })

  test("returns memory metrics with pressurePercent 0-100", () => {
    const metrics = collectOsMetrics()
    expect(metrics.memory.pressurePercent).toBeGreaterThanOrEqual(0)
    expect(metrics.memory.pressurePercent).toBeLessThanOrEqual(100)
    expect(metrics.memory.totalMB).toBeGreaterThan(0)
    expect(metrics.memory.usedMB).toBeGreaterThan(0)
    expect(metrics.memory.availableMB).toBeGreaterThanOrEqual(0)
  })

  test("returns coreCount > 0", () => {
    const metrics = collectOsMetrics()
    expect(metrics.cpu.coreCount).toBeGreaterThan(0)
  })

  test("returns a timestamp", () => {
    const before = Date.now()
    const metrics = collectOsMetrics()
    const after = Date.now()
    expect(metrics.timestamp).toBeGreaterThanOrEqual(before)
    expect(metrics.timestamp).toBeLessThanOrEqual(after)
  })
})

// ---------------------------------------------------------------------------
// parseSwapUsage
// ---------------------------------------------------------------------------

describe("parseSwapUsage", () => {
  test("parses macOS sysctl output", () => {
    const output = "vm.swapusage: total = 2048.00M  used = 123.45M  free = 1924.55M  (encrypted)"
    expect(parseSwapUsage(output)).toBeCloseTo(123.45)
  })

  test("returns 0 for unparseable output", () => {
    expect(parseSwapUsage("")).toBe(0)
    expect(parseSwapUsage("garbage")).toBe(0)
  })

  test("handles zero swap usage", () => {
    const output = "vm.swapusage: total = 2048.00M  used = 0.00M  free = 2048.00M"
    expect(parseSwapUsage(output)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// parseProcessList
// ---------------------------------------------------------------------------

describe("parseProcessList", () => {
  const PS_OUTPUT = `USER               PID  %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND
beorn            12345  45.2  3.1  1234567  56789   ??  R    Mon01PM   5:32.12 bun tribe-daemon.ts
beorn            12346   8.3  1.2   987654  34567   ??  S    Mon01PM   1:02.45 node server.js
root                 1   0.0  0.1   123456   7890   ??  Ss   Sun10AM   0:12.34 /sbin/launchd`

  test("parses ps aux output correctly", () => {
    const procs = parseProcessList(PS_OUTPUT)
    expect(procs).toHaveLength(3)
    expect(procs[0]).toEqual({
      pid: 12345,
      cpu: 45.2,
      mem: 3.1,
      command: "bun tribe-daemon.ts",
    })
    expect(procs[1]!.pid).toBe(12346)
    expect(procs[2]!.pid).toBe(1)
  })

  test("returns empty array for empty input", () => {
    expect(parseProcessList("")).toEqual([])
  })

  test("skips header line", () => {
    const procs = parseProcessList("USER PID %CPU %MEM VSZ RSS TT STAT START TIME COMMAND\n")
    expect(procs).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// countBunNodeProcesses
// ---------------------------------------------------------------------------

describe("countBunNodeProcesses", () => {
  test("counts bun and node processes", () => {
    const procs = [
      { command: "bun tribe-daemon.ts" },
      { command: "node server.js" },
      { command: "/usr/bin/node --max-old-space-size=4096 app.js" },
      { command: "vim CLAUDE.md" },
      { command: "/opt/homebrew/bin/bun run test" },
    ]
    expect(countBunNodeProcesses(procs)).toBe(4)
  })

  test("returns 0 with no bun/node processes", () => {
    const procs = [{ command: "vim" }, { command: "top" }]
    expect(countBunNodeProcesses(procs)).toBe(0)
  })

  test("does not match partial words", () => {
    // "bunny" should not match "bun"
    const procs = [{ command: "bunny-hop" }, { command: "nodemon run" }]
    // "nodemon" contains "node" at the start but has no word boundary after —
    // \b matches after "node" since "m" is a word char. Actually \bnode\b
    // should NOT match "nodemon". Let's verify.
    expect(countBunNodeProcesses(procs)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// topCpuConsumers
// ---------------------------------------------------------------------------

describe("topCpuConsumers", () => {
  test("returns top N sorted by CPU descending", () => {
    const procs = [
      { pid: 1, cpu: 5, mem: 1, command: "a" },
      { pid: 2, cpu: 50, mem: 2, command: "b" },
      { pid: 3, cpu: 25, mem: 3, command: "c" },
      { pid: 4, cpu: 10, mem: 4, command: "d" },
    ]
    const top = topCpuConsumers(procs, 2)
    expect(top).toHaveLength(2)
    expect(top[0]!.pid).toBe(2)
    expect(top[1]!.pid).toBe(3)
  })

  test("truncates long commands to 80 chars", () => {
    const longCmd = "x".repeat(200)
    const procs = [{ pid: 1, cpu: 100, mem: 1, command: longCmd }]
    const top = topCpuConsumers(procs)
    expect(top[0]!.command.length).toBe(80)
  })
})

// ---------------------------------------------------------------------------
// evaluateAlerts — CPU
// ---------------------------------------------------------------------------

describe("evaluateAlerts — CPU", () => {
  test("fires warning after sustained samples above threshold", () => {
    // 10 cores * 0.8 = 8.0 threshold; load = 9.0
    const thresholds = makeThresholds({ sustainedSamples: 3 })
    const state = createAlertState()
    const metrics = makeMetrics({ cpu: { loadAvg1m: 9.0, loadAvg5m: 8.0, coreCount: 10, topProcesses: [] } })

    // Samples 1 and 2: no alert yet
    expect(evaluateAlerts(metrics, thresholds, state)).toEqual([])
    expect(evaluateAlerts(metrics, thresholds, state)).toEqual([])

    // Sample 3: sustained threshold met — alert fires
    const alerts = evaluateAlerts(metrics, thresholds, state)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.type).toBe("cpu")
    expect(alerts[0]!.severity).toBe("warning")
  })

  test("fires critical after sustained samples above critical threshold", () => {
    // 10 cores * 1.5 = 15.0 threshold; load = 16.0
    const thresholds = makeThresholds({ sustainedSamples: 3 })
    const state = createAlertState()
    const metrics = makeMetrics({ cpu: { loadAvg1m: 16.0, loadAvg5m: 14.0, coreCount: 10, topProcesses: [] } })

    evaluateAlerts(metrics, thresholds, state)
    evaluateAlerts(metrics, thresholds, state)
    const alerts = evaluateAlerts(metrics, thresholds, state)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.type).toBe("cpu")
    expect(alerts[0]!.severity).toBe("critical")
  })

  test("does not repeat alerts once fired", () => {
    const thresholds = makeThresholds({ sustainedSamples: 1 })
    const state = createAlertState()
    const metrics = makeMetrics({ cpu: { loadAvg1m: 9.0, loadAvg5m: 8.0, coreCount: 10, topProcesses: [] } })

    // First sample fires
    const first = evaluateAlerts(metrics, thresholds, state)
    expect(first).toHaveLength(1)

    // Second sample: no duplicate
    const second = evaluateAlerts(metrics, thresholds, state)
    expect(second).toEqual([])
  })

  test("resets alert state when load drops below threshold", () => {
    const thresholds = makeThresholds({ sustainedSamples: 1 })
    const state = createAlertState()
    const highMetrics = makeMetrics({ cpu: { loadAvg1m: 9.0, loadAvg5m: 8.0, coreCount: 10, topProcesses: [] } })
    const lowMetrics = makeMetrics({ cpu: { loadAvg1m: 1.0, loadAvg5m: 1.0, coreCount: 10, topProcesses: [] } })

    // Fire alert
    evaluateAlerts(highMetrics, thresholds, state)

    // Drop below — resets
    evaluateAlerts(lowMetrics, thresholds, state)

    // Spike again — fires new alert
    const alerts = evaluateAlerts(highMetrics, thresholds, state)
    expect(alerts).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// evaluateAlerts — Memory
// ---------------------------------------------------------------------------

describe("evaluateAlerts — Memory", () => {
  test("fires memory warning when above 85%", () => {
    const thresholds = makeThresholds()
    const state = createAlertState()
    const metrics = makeMetrics({
      memory: { totalMB: 16384, usedMB: 14746, availableMB: 1638, pressurePercent: 90, swapUsedMB: 0 },
    })

    const alerts = evaluateAlerts(metrics, thresholds, state)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.type).toBe("memory")
    expect(alerts[0]!.severity).toBe("warning")
  })

  test("fires memory critical when above 95%", () => {
    const thresholds = makeThresholds()
    const state = createAlertState()
    const metrics = makeMetrics({
      memory: { totalMB: 16384, usedMB: 15974, availableMB: 410, pressurePercent: 97, swapUsedMB: 512 },
    })

    const alerts = evaluateAlerts(metrics, thresholds, state)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.type).toBe("memory")
    expect(alerts[0]!.severity).toBe("critical")
    expect(alerts[0]!.message).toContain("97%")
    expect(alerts[0]!.message).toContain("swap: 512MB")
  })
})

// ---------------------------------------------------------------------------
// evaluateAlerts — Process count
// ---------------------------------------------------------------------------

describe("evaluateAlerts — Process count", () => {
  test("fires process-count warning when above threshold", () => {
    const thresholds = makeThresholds({ processCountWarning: 50 })
    const state = createAlertState()
    const metrics = makeMetrics({ bunProcesses: 65 })

    const alerts = evaluateAlerts(metrics, thresholds, state)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.type).toBe("process-count")
    expect(alerts[0]!.severity).toBe("warning")
    expect(alerts[0]!.message).toContain("65")
  })

  test("does not fire when below threshold", () => {
    const thresholds = makeThresholds({ processCountWarning: 50 })
    const state = createAlertState()
    const metrics = makeMetrics({ bunProcesses: 10 })

    const alerts = evaluateAlerts(metrics, thresholds, state)
    expect(alerts).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Alert format
// ---------------------------------------------------------------------------

describe("alert format", () => {
  test("alert has required fields", () => {
    const thresholds = makeThresholds({ sustainedSamples: 1 })
    const state = createAlertState()
    const metrics = makeMetrics({
      cpu: {
        loadAvg1m: 20.0,
        loadAvg5m: 18.0,
        coreCount: 10,
        topProcesses: [
          { pid: 100, cpu: 50, mem: 10, command: "bun tribe-daemon.ts" },
          { pid: 200, cpu: 30, mem: 5, command: "node server.js" },
        ],
      },
    })

    const alerts = evaluateAlerts(metrics, thresholds, state)
    expect(alerts.length).toBeGreaterThan(0)

    const alert = alerts[0]!
    expect(alert).toHaveProperty("type")
    expect(alert).toHaveProperty("severity")
    expect(alert).toHaveProperty("message")
    expect(alert).toHaveProperty("metrics")
    expect(alert).toHaveProperty("topOffenders")
    expect(["cpu", "memory", "process-count"]).toContain(alert.type)
    expect(["warning", "critical"]).toContain(alert.severity)
    expect(typeof alert.message).toBe("string")
    expect(Array.isArray(alert.topOffenders)).toBe(true)
  })
})
