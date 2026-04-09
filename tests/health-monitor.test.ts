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
  parseDfOutput,
  parseWorktreeList,
  parseUlimitOutput,
  parseFdInfo,
  parseGhRateLimit,
  parseIostatOutput,
  evaluateAlerts,
  createAlertState,
  defaultThresholds,
  buildPidToParent,
  attributeToSession,
  findGitLockPaths,
  formatLockMessage,
  formatStaleLockMessage,
  LOCK_STALE_THRESHOLD_MS,
  type HealthMetrics,
  type HealthThresholds,
  type GitLockInfo,
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
    disk: overrides.disk,
    fdCount: overrides.fdCount,
    bunProcesses: overrides.bunProcesses ?? 5,
    worktrees: overrides.worktrees ?? 1,
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
    diskWarningPercent: 85,
    diskCriticalPercent: 95,
    worktreeWarning: 5,
    fdWarningPercent: 70,
    diskIoWarningMBps: 500,
    ghRateLimitWarning: 20,
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
    expect([
      "cpu",
      "memory",
      "process-count",
      "git-lock",
      "disk",
      "disk-io",
      "worktree",
      "fd-count",
      "gh-rate-limit",
    ]).toContain(alert.type)
    expect(["warning", "critical"]).toContain(alert.severity)
    expect(typeof alert.message).toBe("string")
    expect(Array.isArray(alert.topOffenders)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Process attribution — buildPidToParent
// ---------------------------------------------------------------------------

describe("process attribution", () => {
  describe("buildPidToParent", () => {
    test("parses standard ps -eo pid,ppid output correctly", () => {
      const psOutput = ["  PID  PPID", "    1     0", "  100    50", "  101   100", "  200    50"].join("\n")

      const map = buildPidToParent(psOutput)
      expect(map.get(1)).toBe(0)
      expect(map.get(100)).toBe(50)
      expect(map.get(101)).toBe(100)
      expect(map.get(200)).toBe(50)
      expect(map.size).toBe(4)
    })

    test("handles empty output (just header)", () => {
      const psOutput = "  PID  PPID\n"
      const map = buildPidToParent(psOutput)
      expect(map.size).toBe(0)
    })

    test("skips malformed lines", () => {
      const psOutput = ["  PID  PPID", "    1     0", "  not a number", "", "  200    50"].join("\n")

      const map = buildPidToParent(psOutput)
      expect(map.size).toBe(2)
      expect(map.get(1)).toBe(0)
      expect(map.get(200)).toBe(50)
    })
  })

  // -------------------------------------------------------------------------
  // attributeToSession
  // -------------------------------------------------------------------------

  /*
   * Test process tree:
   *
   * launchd (PID 1, PPID 0)
   * ├── bash (PID 50, PPID 1)
   * │   ├── Claude Code A (PID 100, PPID 50)
   * │   │   ├── tribe-proxy (PID 101, PPID 100) ← session "km"
   * │   │   ├── bun vitest (PID 102, PPID 100)
   * │   │   └── subshell (PID 103, PPID 100)
   * │   │       └── node (PID 104, PPID 103)
   * │   └── Claude Code B (PID 200, PPID 50)
   * │       ├── tribe-proxy (PID 201, PPID 200) ← session "km-2"
   * │       └── bun build (PID 202, PPID 200)
   * └── mds_stores (PID 300, PPID 1)
   */

  const pidToParent = new Map([
    [1, 0],
    [50, 1],
    [100, 50],
    [101, 100],
    [102, 100],
    [103, 100],
    [104, 103],
    [200, 50],
    [201, 200],
    [202, 200],
    [300, 1],
  ])

  // Sessions: session name + tribe-proxy PID
  const sessions = [
    { name: "km", pid: 101 },
    { name: "km-2", pid: 201 },
  ]

  describe("attributeToSession", () => {
    test("direct child — process whose parent is a session's Claude Code parent", () => {
      // PID 102 (bun vitest) → parent 100 → 100 is parent of session "km"'s proxy (101)
      expect(attributeToSession(102, pidToParent, sessions)).toBe("km")
    })

    test("grandchild — subprocess of a subprocess of Claude Code", () => {
      // PID 104 → parent 103 → parent 100 → 100 is parent of session "km"'s proxy (101)
      expect(attributeToSession(104, pidToParent, sessions)).toBe("km")
    })

    test("session PID itself — the tribe-proxy PID returns its own session", () => {
      expect(attributeToSession(101, pidToParent, sessions)).toBe("km")
      expect(attributeToSession(201, pidToParent, sessions)).toBe("km-2")
    })

    test("unattributable — process with no ancestry matching any session", () => {
      // PID 300 → parent 1 → parent 0 → no match
      expect(attributeToSession(300, pidToParent, sessions)).toBeNull()
    })

    test("multiple sessions — process attributed to the correct one", () => {
      // PID 202 (bun build) → parent 200 → 200 is parent of "km-2"'s proxy (201)
      expect(attributeToSession(202, pidToParent, sessions)).toBe("km-2")
      // PID 102 → parent 100 → 100 is parent of "km"'s proxy (101)
      expect(attributeToSession(102, pidToParent, sessions)).toBe("km")
    })

    test("cycle protection — PPID chain with a cycle does not infinite loop", () => {
      // Create a cycle: 500 → 501 → 502 → 500
      const cyclicMap = new Map([
        [500, 501],
        [501, 502],
        [502, 500],
      ])
      expect(attributeToSession(500, cyclicMap, sessions)).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// parseDfOutput
// ---------------------------------------------------------------------------

describe("parseDfOutput", () => {
  test("parses macOS df -g output", () => {
    const output = `Filesystem   1G-blocks  Used Available Capacity  Mounted on
/dev/disk3s1    1863   976       791    56%    /System/Volumes/Data`
    const result = parseDfOutput(output)
    expect(result).toEqual({
      totalGB: 1863,
      usedGB: 976,
      availableGB: 791,
      usagePercent: 56,
    })
  })

  test("returns null for empty input", () => {
    expect(parseDfOutput("")).toBeNull()
  })

  test("returns null for header-only input", () => {
    expect(parseDfOutput("Filesystem   1G-blocks  Used Available Capacity  Mounted on\n")).toBeNull()
  })

  test("returns null for malformed data line", () => {
    expect(parseDfOutput("Filesystem   1G-blocks  Used Available Capacity\nfoo")).toBeNull()
  })

  test("handles high usage percentage", () => {
    const output = `Filesystem   1G-blocks  Used Available Capacity  Mounted on
/dev/disk3s1    1863  1770        93    96%    /System/Volumes/Data`
    const result = parseDfOutput(output)
    expect(result).toEqual({
      totalGB: 1863,
      usedGB: 1770,
      availableGB: 93,
      usagePercent: 96,
    })
  })
})

// ---------------------------------------------------------------------------
// parseWorktreeList
// ---------------------------------------------------------------------------

describe("parseWorktreeList", () => {
  test("counts worktrees from git worktree list output", () => {
    const output = `/Users/beorn/Code/pim/km                  d3dc1c2 [main]
/Users/beorn/Code/pim/km/.claude/worktrees/fix-123  abc1234 [fix-123]`
    expect(parseWorktreeList(output)).toBe(2)
  })

  test("returns 1 for single worktree (main only)", () => {
    const output = `/Users/beorn/Code/pim/km  d3dc1c2 [main]`
    expect(parseWorktreeList(output)).toBe(1)
  })

  test("returns 0 for empty output", () => {
    expect(parseWorktreeList("")).toBe(0)
  })

  test("counts multiple worktrees", () => {
    const output = `/Users/beorn/Code/pim/km                  d3dc1c2 [main]
/Users/beorn/Code/pim/km/.claude/worktrees/fix-1  aaa1111 [fix-1]
/Users/beorn/Code/pim/km/.claude/worktrees/fix-2  bbb2222 [fix-2]
/Users/beorn/Code/pim/km/.claude/worktrees/fix-3  ccc3333 [fix-3]`
    expect(parseWorktreeList(output)).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// evaluateAlerts — Disk
// ---------------------------------------------------------------------------

describe("evaluateAlerts — Disk", () => {
  test("fires disk warning when above 85%", () => {
    const thresholds = makeThresholds()
    const state = createAlertState()
    const metrics = makeMetrics({
      disk: { totalGB: 1863, usedGB: 1620, availableGB: 243, usagePercent: 87 },
    })

    const alerts = evaluateAlerts(metrics, thresholds, state)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.type).toBe("disk")
    expect(alerts[0]!.severity).toBe("warning")
    expect(alerts[0]!.message).toContain("87%")
  })

  test("fires disk critical when above 95%", () => {
    const thresholds = makeThresholds()
    const state = createAlertState()
    const metrics = makeMetrics({
      disk: { totalGB: 1863, usedGB: 1800, availableGB: 63, usagePercent: 97 },
    })

    const alerts = evaluateAlerts(metrics, thresholds, state)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.type).toBe("disk")
    expect(alerts[0]!.severity).toBe("critical")
    expect(alerts[0]!.message).toContain("97%")
  })

  test("does not fire when disk usage below threshold", () => {
    const thresholds = makeThresholds()
    const state = createAlertState()
    const metrics = makeMetrics({
      disk: { totalGB: 1863, usedGB: 976, availableGB: 887, usagePercent: 52 },
    })

    const alerts = evaluateAlerts(metrics, thresholds, state)
    expect(alerts).toEqual([])
  })

  test("does not fire when disk is undefined", () => {
    const thresholds = makeThresholds()
    const state = createAlertState()
    const metrics = makeMetrics()

    const alerts = evaluateAlerts(metrics, thresholds, state)
    expect(alerts).toEqual([])
  })

  test("does not repeat disk alerts once fired", () => {
    const thresholds = makeThresholds()
    const state = createAlertState()
    const metrics = makeMetrics({
      disk: { totalGB: 1863, usedGB: 1620, availableGB: 243, usagePercent: 90 },
    })

    const first = evaluateAlerts(metrics, thresholds, state)
    expect(first).toHaveLength(1)

    const second = evaluateAlerts(metrics, thresholds, state)
    expect(second).toEqual([])
  })

  test("resets disk alerts when usage drops", () => {
    const thresholds = makeThresholds()
    const state = createAlertState()
    const highMetrics = makeMetrics({
      disk: { totalGB: 1863, usedGB: 1620, availableGB: 243, usagePercent: 90 },
    })
    const lowMetrics = makeMetrics({
      disk: { totalGB: 1863, usedGB: 976, availableGB: 887, usagePercent: 52 },
    })

    evaluateAlerts(highMetrics, thresholds, state)
    evaluateAlerts(lowMetrics, thresholds, state)

    const alerts = evaluateAlerts(highMetrics, thresholds, state)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.type).toBe("disk")
  })
})

// ---------------------------------------------------------------------------
// evaluateAlerts — Worktree count
// ---------------------------------------------------------------------------

describe("evaluateAlerts — Worktree count", () => {
  test("fires worktree warning when above threshold", () => {
    const thresholds = makeThresholds({ worktreeWarning: 5 })
    const state = createAlertState()
    const metrics = makeMetrics({ worktrees: 8 })

    const alerts = evaluateAlerts(metrics, thresholds, state)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.type).toBe("worktree")
    expect(alerts[0]!.severity).toBe("warning")
    expect(alerts[0]!.message).toContain("8")
    expect(alerts[0]!.message).toContain("bun worktree clean")
  })

  test("does not fire when below threshold", () => {
    const thresholds = makeThresholds({ worktreeWarning: 5 })
    const state = createAlertState()
    const metrics = makeMetrics({ worktrees: 3 })

    const alerts = evaluateAlerts(metrics, thresholds, state)
    expect(alerts).toEqual([])
  })

  test("does not repeat worktree alerts once fired", () => {
    const thresholds = makeThresholds({ worktreeWarning: 5 })
    const state = createAlertState()
    const metrics = makeMetrics({ worktrees: 8 })

    const first = evaluateAlerts(metrics, thresholds, state)
    expect(first).toHaveLength(1)

    const second = evaluateAlerts(metrics, thresholds, state)
    expect(second).toEqual([])
  })

  test("resets when worktree count drops", () => {
    const thresholds = makeThresholds({ worktreeWarning: 5 })
    const state = createAlertState()
    const highMetrics = makeMetrics({ worktrees: 8 })
    const lowMetrics = makeMetrics({ worktrees: 2 })

    evaluateAlerts(highMetrics, thresholds, state)
    evaluateAlerts(lowMetrics, thresholds, state)

    const alerts = evaluateAlerts(highMetrics, thresholds, state)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.type).toBe("worktree")
  })
})

// ---------------------------------------------------------------------------
// parseUlimitOutput
// ---------------------------------------------------------------------------

describe("parseUlimitOutput", () => {
  test("parses numeric ulimit output", () => {
    expect(parseUlimitOutput("10240\n")).toBe(10240)
  })

  test("parses output with whitespace", () => {
    expect(parseUlimitOutput("  256  \n")).toBe(256)
  })

  test("returns 0 for non-numeric output", () => {
    expect(parseUlimitOutput("unlimited")).toBe(0)
    expect(parseUlimitOutput("")).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// parseFdInfo
// ---------------------------------------------------------------------------

describe("parseFdInfo", () => {
  test("computes usage percent correctly", () => {
    const info = parseFdInfo(7000, 10000)
    expect(info).toEqual({ total: 7000, limit: 10000, usagePercent: 70 })
  })

  test("rounds usage percent", () => {
    const info = parseFdInfo(3333, 10000)
    expect(info.usagePercent).toBe(33)
  })

  test("handles zero ulimit gracefully (avoids division by zero)", () => {
    const info = parseFdInfo(100, 0)
    expect(info.limit).toBe(1)
    expect(info.total).toBe(100)
  })

  test("handles zero fds", () => {
    const info = parseFdInfo(0, 10000)
    expect(info).toEqual({ total: 0, limit: 10000, usagePercent: 0 })
  })
})

// ---------------------------------------------------------------------------
// evaluateAlerts — File descriptor count
// ---------------------------------------------------------------------------

describe("evaluateAlerts — File descriptor count", () => {
  test("fires fd-count warning when above threshold", () => {
    const thresholds = makeThresholds({ fdWarningPercent: 70 })
    const state = createAlertState()
    const metrics = makeMetrics({
      fdCount: { total: 8000, perSession: [], limit: 10000 },
    })

    const alerts = evaluateAlerts(metrics, thresholds, state)
    const fdAlerts = alerts.filter((a) => a.type === "fd-count")
    expect(fdAlerts).toHaveLength(1)
    expect(fdAlerts[0]!.severity).toBe("warning")
    expect(fdAlerts[0]!.message).toContain("8000")
    expect(fdAlerts[0]!.message).toContain("80%")
    expect(fdAlerts[0]!.message).toContain("10000")
  })

  test("does not fire when below threshold", () => {
    const thresholds = makeThresholds({ fdWarningPercent: 70 })
    const state = createAlertState()
    const metrics = makeMetrics({
      fdCount: { total: 3000, perSession: [], limit: 10000 },
    })

    const alerts = evaluateAlerts(metrics, thresholds, state)
    const fdAlerts = alerts.filter((a) => a.type === "fd-count")
    expect(fdAlerts).toEqual([])
  })

  test("does not fire when fdCount is undefined", () => {
    const thresholds = makeThresholds({ fdWarningPercent: 70 })
    const state = createAlertState()
    const metrics = makeMetrics()

    const alerts = evaluateAlerts(metrics, thresholds, state)
    const fdAlerts = alerts.filter((a) => a.type === "fd-count")
    expect(fdAlerts).toEqual([])
  })

  test("does not repeat fd-count alerts once fired", () => {
    const thresholds = makeThresholds({ fdWarningPercent: 70 })
    const state = createAlertState()
    const metrics = makeMetrics({
      fdCount: { total: 8000, perSession: [], limit: 10000 },
    })

    const first = evaluateAlerts(metrics, thresholds, state)
    expect(first.filter((a) => a.type === "fd-count")).toHaveLength(1)

    const second = evaluateAlerts(metrics, thresholds, state)
    expect(second.filter((a) => a.type === "fd-count")).toEqual([])
  })

  test("resets when fd count drops below threshold", () => {
    const thresholds = makeThresholds({ fdWarningPercent: 70 })
    const state = createAlertState()
    const highMetrics = makeMetrics({
      fdCount: { total: 8000, perSession: [], limit: 10000 },
    })
    const lowMetrics = makeMetrics({
      fdCount: { total: 3000, perSession: [], limit: 10000 },
    })

    evaluateAlerts(highMetrics, thresholds, state)
    evaluateAlerts(lowMetrics, thresholds, state)

    const alerts = evaluateAlerts(highMetrics, thresholds, state)
    const fdAlerts = alerts.filter((a) => a.type === "fd-count")
    expect(fdAlerts).toHaveLength(1)
    expect(fdAlerts[0]!.type).toBe("fd-count")
  })
})

// ---------------------------------------------------------------------------
// parseGhRateLimit
// ---------------------------------------------------------------------------

describe("parseGhRateLimit", () => {
  test("parses valid gh api rate_limit JSON output", () => {
    const json = JSON.stringify({
      resources: {
        core: {
          limit: 5000,
          remaining: 4999,
          reset: 1372700873,
          used: 1,
        },
      },
      rate: {
        limit: 5000,
        remaining: 4999,
        reset: 1372700873,
        used: 1,
      },
    })
    const result = parseGhRateLimit(json)
    expect(result).toEqual({
      remaining: 4999,
      limit: 5000,
      resetAt: 1372700873,
    })
  })

  test("returns null for malformed JSON", () => {
    expect(parseGhRateLimit("not json")).toBeNull()
    expect(parseGhRateLimit("")).toBeNull()
    expect(parseGhRateLimit("{")).toBeNull()
  })

  test("returns null when resources.core is missing", () => {
    expect(parseGhRateLimit(JSON.stringify({}))).toBeNull()
    expect(parseGhRateLimit(JSON.stringify({ resources: {} }))).toBeNull()
    expect(parseGhRateLimit(JSON.stringify({ resources: { core: {} } }))).toBeNull()
  })

  test("returns null when core fields have wrong types", () => {
    const json = JSON.stringify({
      resources: {
        core: {
          limit: "five thousand",
          remaining: 4999,
          reset: 1372700873,
        },
      },
    })
    expect(parseGhRateLimit(json)).toBeNull()
  })

  test("handles zero remaining (fully exhausted)", () => {
    const json = JSON.stringify({
      resources: {
        core: {
          limit: 5000,
          remaining: 0,
          reset: 1700000000,
          used: 5000,
        },
      },
    })
    const result = parseGhRateLimit(json)
    expect(result).toEqual({
      remaining: 0,
      limit: 5000,
      resetAt: 1700000000,
    })
  })
})

// ---------------------------------------------------------------------------
// parseIostatOutput
// ---------------------------------------------------------------------------

describe("parseIostatOutput", () => {
  test("parses valid macOS iostat -d -c 2 -w 1 output", () => {
    const output = `              disk0
    KB/t  tps  MB/s
   52.57   95  4.88
   64.00  150  9.38`
    const result = parseIostatOutput(output)
    expect(result).toEqual({ readWriteMBps: 9.38 })
  })

  test("returns the LAST data line (current sample, not historical)", () => {
    const output = `              disk0
    KB/t  tps  MB/s
  128.00   50  6.25
   32.00  200  6.25
   16.00  500  7.81`
    // With -c 3 there would be 3 data lines; we want the last one
    const result = parseIostatOutput(output)
    expect(result).toEqual({ readWriteMBps: 7.81 })
  })

  test("returns null for empty output", () => {
    expect(parseIostatOutput("")).toBeNull()
  })

  test("returns null for header-only output", () => {
    const output = `              disk0
    KB/t  tps  MB/s`
    expect(parseIostatOutput(output)).toBeNull()
  })

  test("handles zero throughput", () => {
    const output = `              disk0
    KB/t  tps  MB/s
    0.00    0  0.00
    0.00    0  0.00`
    const result = parseIostatOutput(output)
    expect(result).toEqual({ readWriteMBps: 0 })
  })

  test("handles high throughput values", () => {
    const output = `              disk0
    KB/t  tps  MB/s
   52.57   95  4.88
  256.00 3000  750.00`
    const result = parseIostatOutput(output)
    expect(result).toEqual({ readWriteMBps: 750 })
  })

  test("handles multiple disks (takes last data line)", () => {
    // macOS with multiple disks shows more columns but same format
    const output = `              disk0               disk1
    KB/t  tps  MB/s     KB/t  tps  MB/s
   52.57   95  4.88    32.00   10  0.31
   64.00  150  9.38    16.00   20  0.31`
    const result = parseIostatOutput(output)
    // Last data line, last numeric column = 0.31
    expect(result).not.toBeNull()
    expect(result!.readWriteMBps).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Git lock detection — findGitLockPaths
// ---------------------------------------------------------------------------

describe("findGitLockPaths", () => {
  test("returns empty array when no locks exist", () => {
    // Use a non-existent directory — no locks possible
    const locks = findGitLockPaths("/tmp/nonexistent-git-dir-health-test")
    expect(locks).toEqual([])
  })

  test("LOCK_STALE_THRESHOLD_MS is 30 seconds", () => {
    expect(LOCK_STALE_THRESHOLD_MS).toBe(30_000)
  })
})

// ---------------------------------------------------------------------------
// Git lock messaging — formatLockMessage / formatStaleLockMessage
// ---------------------------------------------------------------------------

describe("formatLockMessage", () => {
  test("formats message with session name for main repo lock", () => {
    const lock: GitLockInfo = {
      path: "/repo/.git/index.lock",
      label: "main",
      holder: { pid: 12345, command: "git" },
    }
    const msg = formatLockMessage(lock, "km-3", 5)
    expect(msg).toBe("git lock: .git/index.lock held by km-3 for 5s")
  })

  test("formats message with PID when no session attribution", () => {
    const lock: GitLockInfo = {
      path: "/repo/.git/index.lock",
      label: "main",
      holder: { pid: 12345, command: "git" },
    }
    const msg = formatLockMessage(lock, null, 12)
    expect(msg).toBe("git lock: .git/index.lock held by PID 12345 for 12s")
  })

  test("formats message with 'unknown' when no holder info", () => {
    const lock: GitLockInfo = {
      path: "/repo/.git/index.lock",
      label: "main",
      holder: null,
    }
    const msg = formatLockMessage(lock, null, 3)
    expect(msg).toBe("git lock: .git/index.lock held by unknown for 3s")
  })

  test("formats submodule lock path correctly", () => {
    const lock: GitLockInfo = {
      path: "/repo/.git/modules/silvery/index.lock",
      label: "silvery",
      holder: { pid: 999, command: "git" },
    }
    const msg = formatLockMessage(lock, "km-2", 8)
    expect(msg).toBe("git lock: .git/modules/silvery/index.lock held by km-2 for 8s")
  })
})

describe("formatStaleLockMessage", () => {
  test("formats stale warning with session name", () => {
    const lock: GitLockInfo = {
      path: "/repo/.git/index.lock",
      label: "main",
      holder: { pid: 12345, command: "git" },
    }
    const msg = formatStaleLockMessage(lock, "km-3", 45.7)
    expect(msg).toBe("git lock WARNING: .git/index.lock held >45s by km-3 -- may be stale")
  })

  test("formats stale warning with PID fallback", () => {
    const lock: GitLockInfo = {
      path: "/repo/.git/index.lock",
      label: "main",
      holder: { pid: 12345, command: "git" },
    }
    const msg = formatStaleLockMessage(lock, null, 60)
    expect(msg).toBe("git lock WARNING: .git/index.lock held >60s by PID 12345 -- may be stale")
  })

  test("formats stale warning for submodule lock", () => {
    const lock: GitLockInfo = {
      path: "/repo/.git/modules/flexily/index.lock",
      label: "flexily",
      holder: null,
    }
    const msg = formatStaleLockMessage(lock, null, 120)
    expect(msg).toBe("git lock WARNING: .git/modules/flexily/index.lock held >120s by unknown -- may be stale")
  })
})

// ---------------------------------------------------------------------------
// AlertState — lock tracking fields
// ---------------------------------------------------------------------------

describe("AlertState lock tracking", () => {
  test("createAlertState initializes lock tracking fields", () => {
    const state = createAlertState()
    expect(state.lockFirstSeen).toBeInstanceOf(Map)
    expect(state.lockFirstSeen.size).toBe(0)
    expect(state.lockStaleWarned).toBeInstanceOf(Set)
    expect(state.lockStaleWarned.size).toBe(0)
    expect(state.gitLockDetected).toBe(false)
  })

  test("lockFirstSeen tracks when locks were first observed", () => {
    const state = createAlertState()
    const now = Date.now()
    state.lockFirstSeen.set("/repo/.git/index.lock", now)
    state.lockFirstSeen.set("/repo/.git/modules/silvery/index.lock", now + 5000)

    expect(state.lockFirstSeen.size).toBe(2)
    expect(state.lockFirstSeen.get("/repo/.git/index.lock")).toBe(now)
  })

  test("lockStaleWarned prevents duplicate stale warnings", () => {
    const state = createAlertState()
    state.lockStaleWarned.add("/repo/.git/index.lock")

    expect(state.lockStaleWarned.has("/repo/.git/index.lock")).toBe(true)
    expect(state.lockStaleWarned.has("/repo/.git/modules/silvery/index.lock")).toBe(false)
  })
})
