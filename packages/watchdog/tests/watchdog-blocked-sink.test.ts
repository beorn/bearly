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
