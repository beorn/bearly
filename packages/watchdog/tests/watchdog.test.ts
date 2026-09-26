/**
 * @failure A process whose main thread spins synchronously answers nothing, runs
 *          no timer and no signal handler, and logs nothing: a watchdog on that
 *          thread reports healthy exactly when its subject is dead.
 * @level l2
 * @consumer @bearly/watchdog
 */
import { afterEach, describe, expect, test } from "vitest"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { armWatchdog } from "../src/index.ts"
import { renderWatchdogLine, WATCHDOG_WORKER_SOURCE } from "../src/worker-source.ts"

const MODULE = fileURLToPath(new URL("../src/index.ts", import.meta.url))
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Run a scenario in a REAL child process: the failure is a main thread that stops
 * servicing its own event loop, so it cannot be asserted from inside that thread.
 */
async function scenario(
  body: string,
): Promise<{ code: number | null; signal: string | null; stderr: string; elapsedMs: number }> {
  const root = mkdtempSync(join(tmpdir(), "bearly-watchdog-"))
  roots.push(root)
  const script = join(root, "scenario.ts")
  writeFileSync(script, `import { armWatchdog } from ${JSON.stringify(MODULE)}\n${body}`)
  const started = Date.now()
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] })
  let stderr = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk
  })
  const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null]
  return { code, signal, stderr, elapsedMs: Date.now() - started }
}

const SPIN = (ms: number): string => `{ const until = Date.now() + ${ms}; while (Date.now() < until) {} }`

describe("armWatchdog: a watch that ends says so unless it was disarmed", () => {
  test("a worker that dies is reported on stderr, naming the watchdog and why", async () => {
    const { code, stderr } = await scenario(
      [
        // A message that is not a string throws inside the worker at its first stale read.
        `armWatchdog({ label: "scenario", checkEveryMs: 20, log: { afterMs: 40, repeatEveryMs: 40, message: 42 as unknown as string, recovered: "" } })`,
        `await new Promise((resolve) => setTimeout(resolve, 600))`,
        `console.error("DONE")`,
      ].join("\n"),
    )
    expect(code, stderr).toBe(0)
    expect(stderr).toMatch(/watchdog scenario: its worker failed, so this process is no longer watched: .+/u)
    expect(stderr).toMatch(/watchdog scenario: its worker exited \(code \d+\), so this process is no longer watched/u)
  }, 60_000)

  test("a disarmed watchdog ends quietly", async () => {
    const { code, stderr } = await scenario(
      [
        `const dog = armWatchdog({ label: "scenario", checkEveryMs: 20, log: { afterMs: 5_000, repeatEveryMs: 5_000, message: "STALL\\n", recovered: "" } })`,
        `await new Promise((resolve) => setTimeout(resolve, 100))`,
        `dog.disarm()`,
        `await new Promise((resolve) => setTimeout(resolve, 300))`,
        `console.error("DONE")`,
      ].join("\n"),
    )
    expect(code, stderr).toBe(0)
    expect(stderr).toContain("DONE")
    expect(stderr).not.toContain("no longer watched")
  }, 60_000)
})

describe("armWatchdog: log with repeat and recovery", () => {
  test("each stall keeps its own clock: repeats are spaced, recovery measures the stall, and a second stall starts over", async () => {
    const { code, stderr } = await scenario(
      [
        `const dog = armWatchdog({`,
        `  label: "scenario",`,
        `  checkEveryMs: 25,`,
        `  log: { afterMs: 300, repeatEveryMs: 300, message: "STALL {elapsed} n={count}\\n", recovered: "RECOVERED {elapsed}\\n" },`,
        `})`,
        `const beat = setInterval(() => dog.stamp(), 20)`,
        `await new Promise((resolve) => setTimeout(resolve, 100))`,
        SPIN(1_000),
        `await new Promise((resolve) => setTimeout(resolve, 300))`,
        SPIN(700),
        `await new Promise((resolve) => setTimeout(resolve, 300))`,
        `clearInterval(beat)`,
        `dog.disarm()`,
        `console.error("DONE")`,
      ].join("\n"),
    )
    expect(code, stderr).toBe(0)
    // Split the output at each recovery: one list of STALL lines per spin.
    const spins = stderr
      .split(/^RECOVERED .*$/mu)
      .slice(0, 2)
      .map((part) => [...part.matchAll(/^STALL (\d+) n=(\d+)$/gmu)].map((m) => ({ ms: Number(m[1]), n: Number(m[2]) })))
    const recoveries = [...stderr.matchAll(/^RECOVERED (\d+)$/gmu)].map((m) => Number(m[1]))
    expect(recoveries.length, stderr).toBe(2)
    // 1000 ms of spin holds lines at 300, 600 and 900 ms; 700 ms holds two. A line per check would hold dozens.
    expect(spins[0]?.length ?? 0, stderr).toBeGreaterThanOrEqual(2)
    expect(spins[0]?.length ?? 0, stderr).toBeLessThanOrEqual(4)
    expect(spins[1]?.length ?? 0, stderr).toBeGreaterThanOrEqual(1)
    expect(spins[1]?.length ?? 0, stderr).toBeLessThanOrEqual(3)
    for (const lines of spins) {
      expect(
        lines.map((line) => line.n),
        stderr,
      ).toEqual(lines.map((_, i) => i + 1))
      expect(lines[0]?.ms ?? 0, stderr).toBeGreaterThanOrEqual(300)
      for (let i = 1; i < lines.length; i++) {
        expect((lines[i]?.ms ?? 0) - (lines[i - 1]?.ms ?? 0), stderr).toBeGreaterThanOrEqual(300 - 25)
      }
    }
    // A recovery measures its own stall: at least the first line's age, and no longer than its spin plus a check.
    expect(recoveries[0] ?? 0, stderr).toBeGreaterThanOrEqual(900)
    expect(recoveries[0] ?? 0, stderr).toBeLessThan(1_000 + 400)
    expect(recoveries[1] ?? 0, stderr).toBeGreaterThanOrEqual(600)
    expect(recoveries[1] ?? 0, stderr).toBeLessThan(700 + 400)
  }, 60_000)

  test("a synchronous spin is logged from off the main thread, repeated with a count, and its end is logged", async () => {
    const { code, stderr } = await scenario(
      [
        `const dog = armWatchdog({`,
        `  label: "scenario",`,
        `  checkEveryMs: 25,`,
        `  fields: ["state"],`,
        `  tables: { state: ["idle", "reconciling"] },`,
        `  log: { afterMs: 300, repeatEveryMs: 300, message: "STALL {elapsed}ms state={state:name} n={count}\\n", recovered: "RECOVERED after {elapsed}ms\\n" },`,
        `})`,
        `dog.set("state", 1)`,
        `const beat = setInterval(() => dog.stamp(), 20)`,
        `await new Promise((resolve) => setTimeout(resolve, 100))`,
        SPIN(1_100),
        `await new Promise((resolve) => setTimeout(resolve, 200))`,
        `clearInterval(beat)`,
        `dog.disarm()`,
        `console.error("DONE")`,
      ].join("\n"),
    )
    expect(code, stderr).toBe(0)
    const stalls = [...stderr.matchAll(/STALL (\d+)ms state=reconciling n=(\d+)/gu)]
    expect(stalls.length, stderr).toBeGreaterThanOrEqual(2)
    expect(stalls.map((m) => Number(m[2]))).toEqual(stalls.map((_, i) => i + 1))
    expect(Number(stalls[0]?.[1])).toBeGreaterThanOrEqual(300)
    expect(stderr).toMatch(/RECOVERED after \d+ms/u)
    expect(stderr.indexOf("RECOVERED")).toBeLessThan(stderr.indexOf("DONE"))
  }, 60_000)

  test("a main thread that keeps stamping is never reported", async () => {
    const { code, stderr } = await scenario(
      [
        `const dog = armWatchdog({ label: "scenario", checkEveryMs: 25, log: { afterMs: 200, repeatEveryMs: 200, message: "STALL\\n", recovered: "RECOVERED\\n" } })`,
        `const beat = setInterval(() => dog.stamp(), 20)`,
        `await new Promise((resolve) => setTimeout(resolve, 800))`,
        `clearInterval(beat)`,
        `dog.disarm()`,
      ].join("\n"),
    )
    expect(code).toBe(0)
    expect(stderr).not.toContain("STALL")
    expect(stderr).not.toContain("RECOVERED")
  }, 60_000)
})

describe("armWatchdog: kill", () => {
  test("escalates from logging to SIGKILL at its bound, printing the facts first", async () => {
    const { signal, code, stderr, elapsedMs } = await scenario(
      [
        `const dog = armWatchdog({`,
        `  label: "scenario",`,
        `  checkEveryMs: 25,`,
        `  fields: ["inFlight"],`,
        `  log: { afterMs: 200, repeatEveryMs: 200, message: "STALL n={count}\\n", recovered: "RECOVERED\\n" },`,
        `  kill: { afterMs: 700, message: "KILLED after {elapsed}ms with {inFlight} in flight\\n" },`,
        `})`,
        `dog.set("inFlight", 3)`,
        SPIN(30_000),
        `console.error("SPIN COMPLETED — the watchdog never fired")`,
      ].join("\n"),
    )
    expect(stderr).not.toContain("SPIN COMPLETED")
    expect(signal ?? code).not.toBe(0)
    expect(elapsedMs).toBeLessThan(10_000)
    expect(stderr).toMatch(/STALL n=1/u)
    expect(stderr).toMatch(/KILLED after (\d+)ms with 3 in flight/u)
    expect(Number(/KILLED after (\d+)ms/u.exec(stderr)?.[1])).toBeGreaterThanOrEqual(700)
  }, 60_000)

  test("a text the main thread published before it blocked is printed in the kill line (km 25947)", async () => {
    const { signal, code, stderr } = await scenario(
      [
        `const dog = armWatchdog({`,
        `  label: "scenario",`,
        `  checkEveryMs: 25,`,
        `  texts: { oldest: 64, short: 16 },`,
        `  kill: { afterMs: 400, message: "KILLED oldest=[{oldest:text}] short=[{short:text}] none=[{never:text}]\\n" },`,
        `})`,
        `dog.setText("oldest", "km.update state.mutation set-status @km/p/0001 op=abc")`,
        // 20 two-byte characters into a 16-byte slot: cut at a character boundary, never mid-character.
        `dog.setText("short", "é".repeat(20))`,
        SPIN(30_000),
        `console.error("SPIN COMPLETED")`,
      ].join("\n"),
    )
    expect(stderr).not.toContain("SPIN COMPLETED")
    expect(signal ?? code).not.toBe(0)
    expect(stderr).toContain(
      `KILLED oldest=[km.update state.mutation set-status @km/p/0001 op=abc] short=[${"é".repeat(8)}] none=[{never:text}]`,
    )
  }, 60_000)

  test("a deadline is a watchdog never stamped: it kills at the bound", async () => {
    const { signal, code, stderr, elapsedMs } = await scenario(
      [
        `armWatchdog({ label: "deadline", checkEveryMs: 900, kill: { afterMs: 900, message: "DEADLINE after {elapsed}ms\\n" } })`,
        SPIN(30_000),
        `console.error("SPIN COMPLETED")`,
      ].join("\n"),
    )
    expect(stderr).not.toContain("SPIN COMPLETED")
    expect(signal ?? code).not.toBe(0)
    expect(elapsedMs).toBeLessThan(10_000)
    expect(stderr).toMatch(/DEADLINE after \d+ms/u)
  }, 60_000)

  test("costs a fast process nothing: the worker never holds it open", async () => {
    const { code, stderr, elapsedMs } = await scenario(
      [
        `armWatchdog({ label: "fast", checkEveryMs: 120_000, kill: { afterMs: 120_000, message: "KILLED\\n" } })`,
        `console.error("DONE")`,
      ].join("\n"),
    )
    expect(stderr).toContain("DONE")
    expect(code).toBe(0)
    expect(elapsedMs).toBeLessThan(10_000)
  }, 60_000)
})

describe("armWatchdog: refusals, never a silent default", () => {
  test.each([
    ["checkEveryMs", { label: "x", checkEveryMs: 0, kill: { afterMs: 1, message: "" } }],
    [
      "log.afterMs",
      { label: "x", checkEveryMs: 1, log: { afterMs: -1, repeatEveryMs: 1, message: "", recovered: "" } },
    ],
    [
      "log.repeatEveryMs",
      { label: "x", checkEveryMs: 1, log: { afterMs: 1, repeatEveryMs: Number.NaN, message: "", recovered: "" } },
    ],
    ["kill.afterMs", { label: "x", checkEveryMs: 1, kill: { afterMs: Number.POSITIVE_INFINITY, message: "" } }],
  ])("a non-positive or non-finite %s is refused", (name, options) => {
    expect(() => armWatchdog(options)).toThrow(
      new RegExp(`watchdog x: ${name.replace(".", "\\.")} must be a positive`, "u"),
    )
  })

  test("a watchdog with no action is refused", () => {
    expect(() => armWatchdog({ label: "x", checkEveryMs: 10 })).toThrow(/watchdog x: needs a log or a kill action/u)
  })

  test("a text that was not declared is refused when set, and a text slot must have a positive whole size", () => {
    const dog = armWatchdog({
      label: "x",
      checkEveryMs: 60_000,
      texts: { a: 8 },
      kill: { afterMs: 60_000, message: "" },
    })
    try {
      expect(() => dog.setText("b", "v")).toThrow(/watchdog x: text "b" was not declared/u)
    } finally {
      dog.disarm()
    }
    expect(() =>
      armWatchdog({ label: "x", checkEveryMs: 1, texts: { a: 0 }, kill: { afterMs: 1, message: "" } }),
    ).toThrow(/watchdog x: text "a" must hold a positive whole number of bytes, got 0/u)
  })

  test("a field that was not declared is refused when set", () => {
    const dog = armWatchdog({ label: "x", checkEveryMs: 60_000, fields: ["a"], kill: { afterMs: 60_000, message: "" } })
    try {
      expect(() => dog.set("b", 1)).toThrow(/watchdog x: field "b" was not declared/u)
    } finally {
      dog.disarm()
    }
  })
})

describe("the package entry", () => {
  test("exports armWatchdog and nothing else at runtime; the renderer and worker source stay internal", async () => {
    expect(Object.keys(await import("../src/index.ts")).sort()).toEqual(["armWatchdog"])
  })
})

describe("renderWatchdogLine: the line names only what shared memory holds", () => {
  test("fills elapsed, count, integer fields and table names, names an index past its table, and a negative code as none", () => {
    const line = renderWatchdogLine(
      "{elapsed}ms {elapsedS}s n={count} state={state:name} raw={state} method={method:name} oldest={oldest:name}",
      {
        elapsedMs: 12_345,
        count: 2,
        fields: ["state", "method", "oldest"],
        values: [1, 7, -1],
        tables: { state: ["idle", "busy"], method: ["km.ping"], oldest: ["km.ping"] },
      },
    )
    expect(line).toBe("12345ms 12.3s n=2 state=busy raw=1 method=unknown(7) oldest=none")
  })

  test("renders a published epoch-ms time as its age with its unit, and 0 as none", () => {
    const since = Date.now() - 4_000
    const line = renderWatchdogLine("oldest {since:ageS}, other {other:ageS}", {
      elapsedMs: 0,
      count: 0,
      fields: ["since", "other"],
      values: [since, 0],
      tables: {},
    })
    expect(line).toMatch(/^oldest 4\.\ds, other none$/u)
  })

  test("renders a published text, and an empty one as none", () => {
    const line = renderWatchdogLine("op {op:text}; other {other:text}", {
      elapsedMs: 0,
      count: 0,
      fields: [],
      values: [],
      tables: {},
      texts: { op: "km.update state.mutation", other: "" },
    })
    expect(line).toBe("op km.update state.mutation; other none")
  })

  test("the worker source is import-free and renders with the same function", () => {
    expect(WATCHDOG_WORKER_SOURCE).not.toMatch(/\bimport\b/u)
    expect(WATCHDOG_WORKER_SOURCE).toContain(renderWatchdogLine.toString())
  })
})
