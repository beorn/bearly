/**
 * Tribe hot-reload — donor-process exit invariant.
 *
 * The fix for @km/bearly/hot-reload-zombie-exit-not-forced: after SIGHUP,
 * the donor daemon MUST terminate within `spawnDelayMs + 250ms` (default
 * 1.25s) so the spawned child can take over the listening fd cleanly. Two
 * fixes preserve this invariant:
 *
 *   1. with-runtime.ts:177 — `setTimeout(() => process.exit(0), 250)` is
 *      no longer `.unref()`'d. An unref'd timer doesn't keep the event
 *      loop alive long enough to fire its own callback, so the
 *      force-exit hammer never landed.
 *   2. with-hot-reload.ts — the spawn-delay timer is no longer `.unref()`'d
 *      either, AND a belt-and-braces `process.kill(pid, "SIGKILL")` is
 *      scheduled at `spawnDelayMs + 1500ms` as a last resort if both clean
 *      shutdowns fail to terminate the process (e.g. a sync-heavy plugin
 *      starves the loop).
 *
 * This test spawns a real `tribe-daemon.ts`, sends SIGHUP, and asserts the
 * old PID is dead inside the contract window. It DOES NOT assert anything
 * about the spawned successor process — that's handled by self-heal tests.
 * The orphan child (if any) is reaped at teardown.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const TEST_DIR = dirname(new URL(import.meta.url).pathname)
const DAEMON_SCRIPT = resolve(TEST_DIR, "../tools/tribe-daemon.ts")
const CLI_SCRIPT = resolve(TEST_DIR, "../tools/tribe-cli.ts")

async function waitFor(fn: () => boolean | Promise<boolean>, timeout = 5000, interval = 25): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`waitFor timed out after ${timeout}ms`)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function spawnDaemon(socketPath: string, dbPath: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    // @km/agent/15071 — bumped off `-1` to clean up daemons after test crashes.
    [DAEMON_SCRIPT, "--socket", socketPath, "--db", dbPath, "--quit-timeout", "120"],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        TRIBE_DB: dbPath,
        TRIBE_NO_SUPPRESS: "1",
        TRIBE_NO_PLUGINS: "1",
        TRIBE_NO_AUTORELOAD: "1", // disable source-watcher so only our SIGHUP fires
        TRIBE_ACTIVITY_LOG: "off",
      },
    },
  )
  await waitFor(() => existsSync(socketPath), 8000)
  return child
}

function unlinkIfExists(p: string): void {
  if (!existsSync(p)) return
  try {
    unlinkSync(p)
  } catch {
    /* ignore */
  }
}

async function waitForTribeStatus(socketPath: string, timeout = 8000, interval = 100): Promise<void> {
  const start = Date.now()
  let last = "not probed"
  while (Date.now() - start < timeout) {
    const out = spawnSync(process.execPath, [CLI_SCRIPT, "status"], {
      encoding: "utf8",
      timeout: 8000,
      env: { ...process.env, TRIBE_SOCKET: socketPath },
    })
    if (out.status === 0) return
    last = [
      `status=${String(out.status)}`,
      out.signal ? `signal=${out.signal}` : null,
      out.error ? `error=${out.error.message}` : null,
      out.stdout ? `stdout=${out.stdout.trim()}` : null,
      out.stderr ? `stderr=${out.stderr.trim()}` : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" ")
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`tribe-cli status did not become ready after ${timeout}ms: ${last}`)
}

describe("tribe-daemon hot-reload exit", () => {
  let tmpDir: string
  let socketPath: string
  let dbPath: string
  let daemon: ChildProcess | null = null
  const orphans: ChildProcess[] = []

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-hotreload-"))
    socketPath = join(tmpDir, "tribe.sock")
    dbPath = join(tmpDir, "tribe.db")
    daemon = null
  })

  afterEach(async () => {
    // Reap the donor if it's somehow still alive.
    if (daemon && daemon.pid && pidAlive(daemon.pid)) {
      try {
        daemon.kill("SIGKILL")
      } catch {
        /* ignore */
      }
    }
    // Reap any successor children spawned by the hot-reload(s).
    for (const o of orphans) {
      if (o.pid && pidAlive(o.pid)) {
        try {
          o.kill("SIGKILL")
        } catch {
          /* ignore */
        }
      }
    }
    orphans.length = 0
    daemon = null
    // Belt-and-braces: any tribe-daemon whose --socket argument references
    // THIS run's tmpDir is leaked successor — the test's daemon.on("spawn")
    // handler doesn't track them. Scan + reap by CLI-arg match. Fixes
    // @km/bearly/hot-reload-test-leaks-cpu-spinning-successors.
    try {
      const out = spawnSync("pgrep", ["-af", `tribe-daemon.*${tmpDir}`], { encoding: "utf8" })
      const stdout = (out.stdout ?? "").toString()
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue
        const pid = parseInt(line.trim().split(/\s+/)[0]!, 10)
        if (Number.isFinite(pid) && pid > 0 && pidAlive(pid)) {
          try {
            process.kill(pid, "SIGKILL")
          } catch {
            /* already dead or not ours */
          }
        }
      }
    } catch {
      /* pgrep unavailable on this platform — defensive only, never fatal */
    }
    unlinkIfExists(socketPath)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("donor process exits within 2s of SIGHUP", async () => {
    daemon = await spawnDaemon(socketPath, dbPath)
    expect(daemon.pid).toBeGreaterThan(0)
    const donorPid = daemon.pid!

    // Track the spawned child so we can reap it later.
    daemon.on("spawn", () => {})
    process.on("exit", () => {
      if (pidAlive(donorPid)) {
        try {
          process.kill(donorPid, "SIGKILL")
        } catch {
          /* ignore */
        }
      }
    })

    daemon.kill("SIGHUP")

    // Contract: donor exits within spawnDelayMs (1000) + force-exit (250) + slack (750).
    await waitFor(() => !pidAlive(donorPid), 2000)
    expect(pidAlive(donorPid)).toBe(false)
  })

  // Successor survival — the regression assertion for the `tribe.reload`
  // daemon-death bug (km/tribe/reload-kills-daemon, 2026-05-21).
  //
  // Before the fix, hot-reload re-exec'd the successor with `--fd=<socketFd>`
  // so it could inherit the listening socket. Bun's `node:net` cannot
  // `listen({ fd })` — the successor crash-looped on startup while the donor
  // exited anyway. Net result: NO daemon, "No daemon running" everywhere.
  // Separately, the donor's scope-cleanup `unlinkSync` could race-delete the
  // successor's socket path (was tracked as @km/bearly/hot-reload-socket-unlink).
  //
  // The fix (with-hot-reload.ts): donor closes + unlinks the socket, then
  // spawns a DETACHED successor that binds the freed path FRESH. The
  // `handedOff` flag on SocketServer suppresses the donor's scope-cleanup
  // unlink so it can't race-delete the successor's fresh socket.
  it("successor binds the socket and survives the donor exit", async () => {
    daemon = await spawnDaemon(socketPath, dbPath)
    const donorPid = daemon.pid!
    process.on("exit", () => {
      if (pidAlive(donorPid)) {
        try {
          process.kill(donorPid, "SIGKILL")
        } catch {
          /* ignore */
        }
      }
    })

    daemon.kill("SIGHUP")

    // Donor must exit inside the contract window.
    await waitFor(() => !pidAlive(donorPid), 3000)
    expect(pidAlive(donorPid)).toBe(false)

    // A successor daemon must be listening on the SAME socket path — the
    // path-based connection is what every adapter + CLI uses.
    await waitFor(() => existsSync(socketPath), 6000)
    expect(existsSync(socketPath)).toBe(true)

    // Probe it: a PATH-based connection must reach a live daemon. tribe-cli
    // resolves the socket from TRIBE_SOCKET, so point it at the test socket.
    await waitForTribeStatus(socketPath)
    // The successor PID is leaked relative to the test's ChildProcess handle;
    // afterEach's pgrep-by-tmpDir sweep reaps it.
  })
})
