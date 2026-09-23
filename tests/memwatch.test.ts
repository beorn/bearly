/**
 * memwatch — unit + smoke tests
 *
 * Unit tests cover pure functions (parseArgs, formatSampleLine, sampleOne via
 * a fake `ps` binary, panic, log rotation).
 *
 * The smoke test spawns a real leaky child fixture, runs memwatch against it
 * with a low threshold, and asserts that:
 *   (a) the log file is written,
 *   (b) a PANIC line lands in it,
 *   (c) SIGUSR2 is actually delivered (the fixture catches it and writes a
 *       marker file).
 *
 * Tests must run under Bun because `tools/memwatch.ts` uses `Bun.spawn`.
 * @reach fs-walk <fixture-only: every fs operation is scoped to mkTmp() = mkdtempSync(tmpdir(),...) dirs; the one readdirSync in the smoke test reads snapshotDir under workDir = m...>
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"

import {
  parseArgs,
  formatSampleLine,
  sampleOne,
  panic,
  logLine,
  writeSnapshot,
  type FullSample,
  type MemwatchOptions,
  type ProcessSample,
} from "../tools/memwatch.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURE_DIR = resolve(dirname(new URL(import.meta.url).pathname), "fixtures")
const LEAKY_CHILD = join(FIXTURE_DIR, "memwatch-leaky-child.ts")
const MEMWATCH_BIN = resolve(dirname(new URL(import.meta.url).pathname), "..", "tools", "memwatch.ts")

function mkTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `memwatch-test-${prefix}-`))
}

function sample(overrides: Partial<ProcessSample> = {}): ProcessSample {
  return {
    ts: 1_700_000_000_000,
    rssMB: 100,
    vszMB: 200,
    cpuPct: 0.5,
    ppid: 1234,
    name: "fixture",
    ...overrides,
  }
}

function fullSample(overrides: Partial<FullSample> = {}): FullSample {
  return {
    ts: 1_700_000_000_000,
    target: sample(),
    parent: sample({ rssMB: 500, name: "pty-parent" }),
    parentPid: 1234,
    childCount: 0,
    ...overrides,
  }
}

function defaultOpts(over: Partial<MemwatchOptions> = {}): MemwatchOptions {
  return {
    targetPid: 99999,
    thresholdRssMB: 4096,
    thresholdParentRssMB: 8192,
    snapshotDir: "/tmp",
    allowKillParent: false,
    intervalSec: 10,
    logPath: "/tmp/memwatch-99999.log",
    maxLogBytes: 10 * 1024 * 1024,
    panicCooldownSec: 60,
    psBin: "ps",
    silent: true,
    ...over,
  }
}

/**
 * Build a tiny shell-script fake `ps` binary that prints whatever lives in
 * the file at envvar PS_FAKE_OUTPUT. Used to drive sampleOne / countChildren
 * deterministically without spawning real processes.
 */
function makeFakePs(workDir: string, output: string): string {
  const outFile = join(workDir, "ps-output.txt")
  writeFileSync(outFile, output)
  const psScript = join(workDir, "fake-ps.sh")
  writeFileSync(psScript, `#!/bin/sh\ncat "${outFile}"\n`)
  chmodSync(psScript, 0o755)
  return psScript
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  test("requires pid", () => {
    expect(() => parseArgs([])).toThrow(/missing required <pid>/)
  })

  test("parses bare pid with defaults", () => {
    const opts = parseArgs(["12345"])
    expect(opts.targetPid).toBe(12345)
    expect(opts.thresholdRssMB).toBe(4096)
    expect(opts.thresholdParentRssMB).toBe(8192)
    expect(opts.intervalSec).toBe(10)
    expect(opts.allowKillParent).toBe(false)
    expect(opts.logPath).toBe("/tmp/memwatch-12345.log")
  })

  test("parses all flags", () => {
    const opts = parseArgs([
      "777",
      "--threshold-rss-mb",
      "100",
      "--threshold-parent-rss-mb",
      "200",
      "--snapshot-dir",
      "/var/tmp",
      "--allow-kill-parent",
      "--interval-sec",
      "3",
      "--log-path",
      "/tmp/custom.log",
      "--panic-cooldown-sec",
      "30",
    ])
    expect(opts.targetPid).toBe(777)
    expect(opts.thresholdRssMB).toBe(100)
    expect(opts.thresholdParentRssMB).toBe(200)
    expect(opts.snapshotDir).toBe("/var/tmp")
    expect(opts.allowKillParent).toBe(true)
    expect(opts.intervalSec).toBe(3)
    expect(opts.logPath).toBe("/tmp/custom.log")
    expect(opts.panicCooldownSec).toBe(30)
  })

  test("rejects unknown flag", () => {
    expect(() => parseArgs(["1", "--unknown"])).toThrow(/unknown option/)
  })

  test("rejects non-numeric pid", () => {
    expect(() => parseArgs(["abc"])).toThrow(/expected integer/)
  })

  test("rejects two positionals", () => {
    expect(() => parseArgs(["1", "2"])).toThrow(/unexpected positional/)
  })

  test("rejects non-positive interval", () => {
    expect(() => parseArgs(["1", "--interval-sec", "0"])).toThrow(/must be > 0/)
  })
})

// ---------------------------------------------------------------------------
// formatSampleLine
// ---------------------------------------------------------------------------

describe("formatSampleLine", () => {
  test("formats target + parent fields", () => {
    const line = formatSampleLine(42, fullSample())
    expect(line).toContain("42")
    expect(line).toContain("target_rss_mb=100")
    expect(line).toContain("target_vsz_mb=200")
    expect(line).toContain("target_cpu=0.5")
    expect(line).toContain("parent_pid=1234")
    expect(line).toContain("parent_rss_mb=500")
    expect(line).toContain("parent_name=pty-parent")
    expect(line).toContain("children=0")
    // Leading ISO timestamp
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test("handles target gone", () => {
    const line = formatSampleLine(42, fullSample({ target: null, parent: null, parentPid: null }))
    expect(line).toContain("target=gone")
  })

  test("quotes names with whitespace", () => {
    const line = formatSampleLine(42, fullSample({ target: sample({ name: "node --foo" }) }))
    expect(line).toContain('target_name="node --foo"')
  })
})

// ---------------------------------------------------------------------------
// sampleOne (via fake ps)
// ---------------------------------------------------------------------------

describe("sampleOne", () => {
  test("parses a valid macOS-style ps line", async () => {
    const dir = mkTmp("ps-ok")
    try {
      // ps -o pid=,ppid=,rss=,vsz=,%cpu=,comm=  -> "42 1 102400 204800 1.5 bun"
      const fakePs = makeFakePs(dir, "   42     1 102400 204800   1.5 bun\n")
      const s = await sampleOne(42, fakePs)
      expect(s).not.toBeNull()
      expect(s!.rssMB).toBe(100) // 102400 KB → 100 MB
      expect(s!.vszMB).toBe(200)
      expect(s!.cpuPct).toBeCloseTo(1.5)
      expect(s!.ppid).toBe(1)
      expect(s!.name).toBe("bun")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns null on empty ps output (pid gone)", async () => {
    const dir = mkTmp("ps-gone")
    try {
      const fakePs = makeFakePs(dir, "")
      const s = await sampleOne(42, fakePs)
      expect(s).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns null when ps reports a different pid (paranoid check)", async () => {
    const dir = mkTmp("ps-mismatch")
    try {
      const fakePs = makeFakePs(dir, "   99     1 102400 204800   1.5 bun\n")
      const s = await sampleOne(42, fakePs)
      expect(s).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("parses multi-word comm field", async () => {
    const dir = mkTmp("ps-multiword")
    try {
      const fakePs = makeFakePs(dir, "  42   1 102400 204800 0.0 /usr/bin/node --foo bar\n")
      const s = await sampleOne(42, fakePs)
      expect(s).not.toBeNull()
      expect(s!.name).toBe("/usr/bin/node --foo bar")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// logLine + rotation
// ---------------------------------------------------------------------------

describe("logLine", () => {
  test("appends a line", () => {
    const dir = mkTmp("log-append")
    try {
      const logPath = join(dir, "memwatch.log")
      logLine("hello", logPath, 1024 * 1024)
      logLine("world", logPath, 1024 * 1024)
      const contents = readFileSync(logPath, "utf8")
      expect(contents).toBe("hello\nworld\n")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("rotates when size exceeds maxBytes", () => {
    const dir = mkTmp("log-rotate")
    try {
      const logPath = join(dir, "memwatch.log")
      // First write fills the file; subsequent write triggers rotation.
      logLine("x".repeat(100), logPath, 50)
      expect(statSync(logPath).size).toBeGreaterThan(50)
      logLine("after-rotate", logPath, 50)
      expect(existsSync(`${logPath}.1`)).toBe(true)
      expect(readFileSync(logPath, "utf8")).toBe("after-rotate\n")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// panic pipeline (signal delivery + snapshot write)
// ---------------------------------------------------------------------------

describe("panic", () => {
  test("writes snapshot file with recent samples", () => {
    const dir = mkTmp("panic-snap")
    try {
      const logPath = join(dir, "memwatch.log")
      const opts = defaultOpts({
        targetPid: process.pid, // safe — we'll trySignal ourselves later
        snapshotDir: dir,
        logPath,
      })
      const samples = [fullSample({ ts: Date.now() - 1000 }), fullSample({ ts: Date.now() })]
      // Use a non-existent target pid so SIGUSR2 fails harmlessly.
      const action = panic("target", 5000, 4096, { ...opts, targetPid: 1 }, null, samples)
      expect(existsSync(action.snapshotPath)).toBe(true)
      const snap = readFileSync(action.snapshotPath, "utf8")
      expect(snap).toContain("# memwatch panic snapshot")
      expect(snap).toContain("target_rss_mb=100")
      // Log got a PANIC banner.
      const log = readFileSync(logPath, "utf8")
      expect(log).toMatch(/PANIC: target RSS = 5000MB exceeds threshold 4096MB/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("sends SIGUSR2 to current process when targetPid = self", async () => {
    const dir = mkTmp("panic-sigusr2")
    try {
      const logPath = join(dir, "memwatch.log")
      const opts = defaultOpts({ targetPid: process.pid, snapshotDir: dir, logPath })
      let received = false
      const handler = (): void => {
        received = true
      }
      process.on("SIGUSR2", handler)
      try {
        const action = panic("target", 5000, 4096, opts, null, [fullSample()])
        expect(action.sigusr2Sent).toBe(true)
        // Give the event loop a tick to deliver the signal.
        await new Promise((r) => setTimeout(r, 50))
        expect(received).toBe(true)
      } finally {
        process.off("SIGUSR2", handler)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("does NOT send SIGINT to parent without --allow-kill-parent", () => {
    const dir = mkTmp("panic-noparent")
    try {
      const logPath = join(dir, "memwatch.log")
      const opts = defaultOpts({ targetPid: 1, snapshotDir: dir, logPath, allowKillParent: false })
      const action = panic("parent", 9000, 8192, opts, 99999, [fullSample()])
      expect(action.sigintParentSent).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// writeSnapshot
// ---------------------------------------------------------------------------

describe("writeSnapshot", () => {
  test("includes one line per sample", () => {
    const dir = mkTmp("snap")
    try {
      const samples = [fullSample({ ts: 1_700_000_000_000 }), fullSample({ ts: 1_700_000_001_000 })]
      const path = writeSnapshot(dir, 42, Date.now(), samples)
      const contents = readFileSync(path, "utf8")
      const sampleLines = contents.split("\n").filter((l) => l.startsWith("2"))
      expect(sampleLines.length).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Smoke test: real leaky child + real memwatch process
// ---------------------------------------------------------------------------

describe("memwatch smoke test", () => {
  let workDir: string
  let leakyChild: ChildProcess | null = null
  let memwatchProc: ChildProcess | null = null

  beforeAll(() => {
    workDir = mkTmp("smoke")
  })

  afterAll(() => {
    for (const proc of [leakyChild, memwatchProc]) {
      if (proc && !proc.killed) {
        try {
          proc.kill("SIGKILL")
        } catch {
          /* already dead */
        }
      }
    }
    rmSync(workDir, { recursive: true, force: true })
  })

  test("trips threshold, writes log + PANIC line + delivers SIGUSR2 marker", { timeout: 60_000 }, async () => {
    const markerPath = join(workDir, "marker.txt")
    const logPath = join(workDir, "memwatch.log")
    const snapshotDir = join(workDir, "snapshots")

    // Spawn the leaky fixture — allocates 10 × 50MB = ~500MB.
    leakyChild = spawn(
      "bun",
      [LEAKY_CHILD, "--marker-path", markerPath, "--chunk-mb", "50", "--max-chunks", "10", "--interval-ms", "100"],
      { stdio: ["ignore", "ignore", "pipe"], detached: false },
    )
    expect(leakyChild.pid).toBeDefined()
    const childPid = leakyChild.pid!

    // Give the child a moment to allocate enough to trip a low threshold (200 MB).
    await new Promise((r) => setTimeout(r, 2000))

    // Spawn memwatch with a 1-second interval and 200 MB target threshold —
    // the child should be past 200 MB after the 2s warmup.
    memwatchProc = spawn(
      "bun",
      [
        MEMWATCH_BIN,
        String(childPid),
        "--threshold-rss-mb",
        "200",
        "--threshold-parent-rss-mb",
        "999999", // disable parent trip — we only want to assert target trip
        "--interval-sec",
        "1",
        "--snapshot-dir",
        snapshotDir,
        "--log-path",
        logPath,
        "--panic-cooldown-sec",
        "5",
      ],
      { stdio: ["ignore", "pipe", "pipe"], detached: false },
    )

    // Wait for the marker file (fixture caught SIGUSR2 and exited).
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && !existsSync(markerPath)) {
      await new Promise((r) => setTimeout(r, 200))
    }

    // The fixture should have caught SIGUSR2 and written the marker.
    expect(existsSync(markerPath), `marker file ${markerPath} should exist`).toBe(true)
    expect(readFileSync(markerPath, "utf8")).toContain("SIGUSR2")

    // Log file should contain a PANIC line.
    expect(existsSync(logPath), `log file ${logPath} should exist`).toBe(true)
    const log = readFileSync(logPath, "utf8")
    expect(log).toMatch(/PANIC: target RSS = \d+MB exceeds threshold 200MB/)

    // Snapshot summary file was written under snapshotDir.
    expect(existsSync(snapshotDir), `snapshot dir ${snapshotDir} should exist`).toBe(true)
    const snapshotFiles = readdirSync(snapshotDir).filter((f) => f.startsWith(`memwatch-${childPid}-`))
    expect(snapshotFiles.length).toBeGreaterThan(0)
    const snapshot = readFileSync(join(snapshotDir, snapshotFiles[0]!), "utf8")
    expect(snapshot).toContain("# memwatch panic snapshot")
    // Log file logged the snapshot path.
    expect(log).toContain("snapshot=")

    // memwatch should exit naturally once the target dies (SIGUSR2 → child exit).
    const memwatchExit = new Promise<number | null>((resolve) => {
      memwatchProc!.on("exit", (code) => resolve(code))
    })
    const exitCode = await Promise.race([
      memwatchExit,
      new Promise<number | null>((r) => setTimeout(() => r(null), 15_000)),
    ])
    // Either it exited (code 0) or we tear down in afterAll; we don't assert
    // a strict exit code — the user-visible signal + log are what matter.
    // But we DO want to stop the process here to avoid a runaway test.
    if (exitCode === null && memwatchProc && !memwatchProc.killed) {
      memwatchProc.kill("SIGTERM")
    }
  })
})
