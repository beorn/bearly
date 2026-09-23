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
import { armWatchdog, renderWatchdogLine, WATCHDOG_WORKER_SOURCE } from "../src/index.ts"

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

describe("armWatchdog: log with repeat and recovery", () => {
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

  test("a field that was not declared is refused when set", () => {
    const dog = armWatchdog({ label: "x", checkEveryMs: 60_000, fields: ["a"], kill: { afterMs: 60_000, message: "" } })
    try {
      expect(() => dog.set("b", 1)).toThrow(/watchdog x: field "b" was not declared/u)
    } finally {
      dog.disarm()
    }
  })
})

describe("renderWatchdogLine: the line names only what shared memory holds", () => {
  test("fills elapsed, count, integer fields and table names, and names an index outside its table", () => {
    const line = renderWatchdogLine(
      "{elapsed}ms {elapsedS}s n={count} state={state:name} raw={state} method={method:name}",
      {
        elapsedMs: 12_345,
        count: 2,
        fields: ["state", "method"],
        values: [1, 7],
        tables: { state: ["idle", "busy"], method: ["km.ping"] },
      },
    )
    expect(line).toBe("12345ms 12.3s n=2 state=busy raw=1 method=unknown(7)")
  })

  test("renders a published epoch-ms time as its age in seconds, and 0 as none", () => {
    const since = Date.now() - 4_000
    const line = renderWatchdogLine("oldest {since:ageS}s, other {other:ageS}", {
      elapsedMs: 0,
      count: 0,
      fields: ["since", "other"],
      values: [since, 0],
      tables: {},
    })
    expect(line).toMatch(/^oldest 4\.\ds, other none$/u)
  })

  test("the worker source is import-free and renders with the same function", () => {
    expect(WATCHDOG_WORKER_SOURCE).not.toMatch(/\bimport\b/u)
    expect(WATCHDOG_WORKER_SOURCE).toContain(renderWatchdogLine.toString())
  })
})
