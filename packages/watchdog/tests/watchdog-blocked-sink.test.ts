/**
 * @failure The km daemon's watchdog warned once and then went quiet with the daemon: its worker writes every
 *          line to fd 2 with a blocking writeSync, and the kill line is written BEFORE the SIGKILL, so a stderr
 *          whose reader has stalled (hab under the 2026-10-16 OOM storm wrote one status record 39 s late)
 *          silences the warnings and prevents the kill. Measured under Bun 1.4.3: a worker's writeSync(2)
 *          blocks for good once ~10 KB sits unread on a pty, 64 KiB on a pipe (km 25947).
 * @level l2
 * @consumer @km/daemon/25947-bd-close-blocks-daemon
 */
import { afterEach, describe, expect, test } from "vitest"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const MODULE = fileURLToPath(new URL("../src/index.ts", import.meta.url))
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Like the other rows' scenario(), but the parent never reads the child's stderr until the child is gone: the
 * pipe fills, and every blocking write to fd 2 after that parks its caller in the kernel. A guard SIGTERM after
 * `guardMs` ends a child the watchdog never killed, so a guard kill can never pass as a watchdog kill.
 */
async function scenarioUndrained(
  body: string,
  guardMs: number,
): Promise<{ code: number | null; signal: string | null; stderr: string; elapsedMs: number; guarded: boolean }> {
  const root = mkdtempSync(join(tmpdir(), "bearly-watchdog-undrained-"))
  roots.push(root)
  const script = join(root, "scenario.ts")
  writeFileSync(script, `import { armWatchdog } from ${JSON.stringify(MODULE)}\n${body}`)
  const started = Date.now()
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "pipe"] })
  // A paused stream never asks libuv to read, so nothing drains the pipe while the child runs.
  child.stderr.pause()
  let guarded = false
  const guard = setTimeout(() => {
    guarded = true
    child.kill("SIGTERM")
  }, guardMs)
  const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null]
  clearTimeout(guard)
  const elapsedMs = Date.now() - started
  let stderr = ""
  child.stderr.setEncoding("utf8")
  for (let chunk = child.stderr.read() as string | null; chunk !== null; chunk = child.stderr.read() as string | null) {
    stderr += chunk
  }
  return { code, signal, stderr, elapsedMs, guarded }
}

/**
 * Like scenarioUndrained, but the parent starts reading after `unreadMs`: the pipe fills, the sink's bound fills and
 * lines drop; once the reader drains, the backlog flows and the sink announces what it dropped on the next line.
 */
async function scenarioStalled(
  body: string,
  unreadMs: number,
  guardMs: number,
): Promise<{ code: number | null; signal: string | null; stderr: string; elapsedMs: number; guarded: boolean }> {
  const root = mkdtempSync(join(tmpdir(), "bearly-watchdog-stalled-"))
  roots.push(root)
  const script = join(root, "scenario.ts")
  writeFileSync(script, `import { armWatchdog } from ${JSON.stringify(MODULE)}\n${body}`)
  const started = Date.now()
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "pipe"] })
  child.stderr.pause()
  let guarded = false
  const guard = setTimeout(() => {
    guarded = true
    child.kill("SIGTERM")
  }, guardMs)
  let stderr = ""
  setTimeout(() => {
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    // A stream paused explicitly does not resume when a data listener is attached.
    child.stderr.resume()
  }, unreadMs)
  const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null]
  clearTimeout(guard)
  return { code, signal, stderr, elapsedMs: Date.now() - started, guarded }
}

describe("armWatchdog: lines the sink could not hold while stderr was blocked are counted, never silently lost (km 25947)", () => {
  test("once the reader drains, the backlog flows whole and the next line says how many were dropped", async () => {
    // A 3 s spin logged every 10 ms with a 1 KB line against a 64 KiB pipe and a 64 KiB sink bound, unread for 2.5 s:
    // drops are certain. The stall still recovers, the watch is disarmed, and the process exits by itself.
    const { signal, code, stderr, guarded } = await scenarioStalled(
      [
        `const dog = armWatchdog({`,
        `  label: "scenario",`,
        `  checkEveryMs: 10,`,
        `  log: { afterMs: 100, repeatEveryMs: 10, message: "STALL n={count} ${"x".repeat(1000)}\\n", recovered: "RECOVERED\\n" },`,
        `})`,
        // The main thread stamps while it can; the spin stops the timer, and the first stamp after it ends the stall.
        `const tick = setInterval(() => dog.stamp(), 10)`,
        `{ const until = Date.now() + 3_000; while (Date.now() < until) {} }`,
        `await new Promise((resolve) => setTimeout(resolve, 300))`,
        `clearInterval(tick)`,
        `dog.disarm()`,
      ].join("\n"),
      2_500,
      15_000,
    )
    expect(guarded, stderr.slice(-300)).toBe(false)
    expect(signal ?? code).toBe(0)
    const marker = /\((\d+) lines? dropped while fd 2 was blocked for \d+s\) /u.exec(stderr)
    expect(marker, stderr.slice(-300)).not.toBeNull()
    expect(Number(marker?.[1])).toBeGreaterThan(0)
    const stalls = stderr.split("\n").filter((line) => line.includes("STALL "))
    expect(stalls.length).toBeGreaterThan(50)
    for (const line of stalls) {
      expect(line).toMatch(/^(?:\(\d+ lines? dropped while fd 2 was blocked for \d+s\) )?STALL n=\d+ x{1000}$/u)
    }
    expect(stderr).toContain("RECOVERED\n")
  }, 30_000)
})

describe("armWatchdog: a stderr nobody reads never delays the kill (km 25947)", () => {
  test("a main thread parked in a blocking write to a full stderr is still killed at the bound", async () => {
    const { signal, code, stderr, elapsedMs, guarded } = await scenarioUndrained(
      [
        `const { writeSync } = await import("node:fs")`,
        `const dog = armWatchdog({`,
        `  label: "scenario",`,
        `  checkEveryMs: 25,`,
        `  log: { afterMs: 300, repeatEveryMs: 300, message: "STALL n={count}\\n", recovered: "RECOVERED\\n" },`,
        `  kill: { afterMs: 1_500, message: "KILLED after {elapsed}ms\\n" },`,
        `})`,
        // Past the pipe's 64 KiB the main thread parks inside the kernel's pipe write and never stamps again; the
        // worker's own line writes to the same fd then park the same way unless the kill is sequenced first.
        `const line = "x".repeat(1024) + "\\n"`,
        `for (let i = 0; i < 4096; i++) writeSync(2, line)`,
        `console.error("WRITES COMPLETED — stderr was drained, the row proved nothing")`,
      ].join("\n"),
      8_000,
    )
    expect(stderr).not.toContain("WRITES COMPLETED")
    expect(guarded, `the guard SIGTERM ended the child after ${elapsedMs}ms; the watchdog never killed it`).toBe(false)
    expect(signal ?? code).toBe("SIGKILL")
    expect(elapsedMs).toBeLessThan(6_000)
  }, 30_000)
})
