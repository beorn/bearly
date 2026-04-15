#!/usr/bin/env bun
/**
 * qmd-watchdog — Supervise `qmd embed` runs.
 *
 * The bare `qmd embed` command has no dead-hand timer on embedding API
 * calls, so a single hung batch can leave the process resident with its
 * working set (10+ GB) allocated indefinitely. This wrapper spawns qmd
 * as a child, monitors its RSS + progress, and kills + restarts (or
 * gives up) when it misbehaves.
 *
 * Signals watched:
 *   - Progress: every line from qmd stdout/stderr resets a progress timer.
 *     If no output appears for --no-progress-sec seconds, qmd is
 *     considered hung and killed.
 *   - RSS ceiling: sampled via `ps -p $PID -o rss` every --sample-sec
 *     seconds. If RSS exceeds --max-rss-mb, qmd is killed.
 *   - Wall-clock cap: qmd is killed after --max-run-sec seconds regardless.
 *
 * On kill, the watchdog waits --restart-delay-sec then relaunches, up to
 * --max-restarts times. Incidents are logged to stderr as structured
 * JSONL lines so they can be tailed and aggregated.
 *
 * Usage:
 *   bun vendor/bearly/tools/qmd-watchdog.ts [watchdog-opts] -- [qmd-args]
 *
 * Example:
 *   bun vendor/bearly/tools/qmd-watchdog.ts \
 *     --max-rss-mb 6000 --no-progress-sec 1800 --max-run-sec 14400 \
 *     -- embed --max-docs-per-batch 100 --max-batch-mb 50
 *
 * Tracked in km-tribe.reliability-sweep-0415.
 */

interface WatchdogOptions {
  maxRssMB: number
  noProgressSec: number
  maxRunSec: number
  sampleSec: number
  maxRestarts: number
  restartDelaySec: number
  qmdBin: string
  qmdArgs: string[]
}

function parseArgs(argv: string[]): WatchdogOptions {
  const opts: WatchdogOptions = {
    maxRssMB: 6000,
    noProgressSec: 1800, // 30 min
    maxRunSec: 14400, // 4 h
    sampleSec: 30,
    maxRestarts: 3,
    restartDelaySec: 10,
    qmdBin: "qmd",
    qmdArgs: [],
  }
  let i = 0
  while (i < argv.length) {
    const a = argv[i]!
    if (a === "--") {
      opts.qmdArgs = argv.slice(i + 1)
      break
    }
    const next = (): string => {
      i++
      if (i >= argv.length) throw new Error(`${a} needs a value`)
      return argv[i]!
    }
    switch (a) {
      case "--max-rss-mb":
        opts.maxRssMB = parseInt(next(), 10)
        break
      case "--no-progress-sec":
        opts.noProgressSec = parseInt(next(), 10)
        break
      case "--max-run-sec":
        opts.maxRunSec = parseInt(next(), 10)
        break
      case "--sample-sec":
        opts.sampleSec = parseInt(next(), 10)
        break
      case "--max-restarts":
        opts.maxRestarts = parseInt(next(), 10)
        break
      case "--restart-delay-sec":
        opts.restartDelaySec = parseInt(next(), 10)
        break
      case "--qmd-bin":
        opts.qmdBin = next()
        break
      case "-h":
      case "--help":
        console.log(
          "qmd-watchdog — supervise qmd embed\n\n" +
            "Usage: qmd-watchdog [options] -- [qmd args]\n\n" +
            "Options:\n" +
            "  --max-rss-mb N         Kill qmd if RSS exceeds N MB (default 6000)\n" +
            "  --no-progress-sec N    Kill qmd after N seconds of silent stdout (default 1800)\n" +
            "  --max-run-sec N        Hard wall-clock cap per run (default 14400)\n" +
            "  --sample-sec N         RSS sampling interval (default 30)\n" +
            "  --max-restarts N       Stop after N restarts (default 3)\n" +
            "  --restart-delay-sec N  Delay between restarts (default 10)\n" +
            "  --qmd-bin PATH         qmd binary (default 'qmd')\n",
        )
        process.exit(0)
      // eslint-disable-next-line no-fallthrough
      default:
        throw new Error(`unknown option: ${a}`)
    }
    i++
  }
  if (opts.qmdArgs.length === 0) {
    throw new Error("qmd args required after `--`")
  }
  return opts
}

type IncidentReason = "no-progress" | "rss-exceeded" | "max-run" | "exit" | "signal"

function logIncident(event: Record<string, unknown>): void {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n")
}

async function getRssMB(pid: number): Promise<number | null> {
  try {
    const proc = Bun.spawn(["ps", "-p", String(pid), "-o", "rss="], { stdout: "pipe", stderr: "ignore" })
    const out = (await new Response(proc.stdout).text()).trim()
    if (!out) return null
    const kb = parseInt(out, 10)
    if (isNaN(kb)) return null
    return Math.round(kb / 1024)
  } catch {
    return null
  }
}

async function runOnce(opts: WatchdogOptions, attempt: number): Promise<{ ok: boolean; reason: IncidentReason }> {
  const startedAt = Date.now()
  logIncident({ event: "start", attempt, bin: opts.qmdBin, args: opts.qmdArgs })

  const proc = Bun.spawn([opts.qmdBin, ...opts.qmdArgs], {
    stdout: "pipe",
    stderr: "pipe",
  })

  let lastProgressAt = Date.now()
  let killed = false
  let killReason: IncidentReason = "exit"

  const forward = async (stream: ReadableStream<Uint8Array>, target: NodeJS.WriteStream): Promise<void> => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) {
        lastProgressAt = Date.now()
        target.write(decoder.decode(value))
      }
    }
  }

  // Pipe child output through while tracking progress
  const stdoutForward = forward(proc.stdout as unknown as ReadableStream<Uint8Array>, process.stdout)
  const stderrForward = forward(proc.stderr as unknown as ReadableStream<Uint8Array>, process.stderr)

  const killChild = (reason: IncidentReason): void => {
    if (killed) return
    killed = true
    killReason = reason
    logIncident({ event: "kill", attempt, reason, elapsedSec: Math.round((Date.now() - startedAt) / 1000) })
    try {
      proc.kill("SIGTERM")
    } catch {
      /* already dead */
    }
    setTimeout(() => {
      try {
        if (!proc.killed) proc.kill("SIGKILL")
      } catch {
        /* already dead */
      }
    }, 5000)
  }

  // Periodic monitor: RSS ceiling + no-progress timer + wall-clock cap
  const monitor = setInterval(async () => {
    if (killed) return

    const now = Date.now()

    // Wall-clock cap
    if (now - startedAt > opts.maxRunSec * 1000) {
      killChild("max-run")
      return
    }

    // No-progress timer
    if (now - lastProgressAt > opts.noProgressSec * 1000) {
      killChild("no-progress")
      return
    }

    // RSS ceiling
    const rss = await getRssMB(proc.pid)
    if (rss !== null && rss > opts.maxRssMB) {
      logIncident({ event: "rss-exceeded", attempt, rssMB: rss, ceilingMB: opts.maxRssMB })
      killChild("rss-exceeded")
      return
    }
    logIncident({
      event: "sample",
      attempt,
      rssMB: rss,
      elapsedSec: Math.round((now - startedAt) / 1000),
      silentSec: Math.round((now - lastProgressAt) / 1000),
    })
  }, opts.sampleSec * 1000)

  await Promise.all([stdoutForward, stderrForward])
  const exitCode = await proc.exited
  clearInterval(monitor)

  logIncident({
    event: "exit",
    attempt,
    exitCode,
    reason: killed ? killReason : exitCode === 0 ? "exit" : "signal",
    elapsedSec: Math.round((Date.now() - startedAt) / 1000),
  })

  if (killed) return { ok: false, reason: killReason }
  if (exitCode === 0) return { ok: true, reason: "exit" }
  return { ok: false, reason: "signal" }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))

  process.on("SIGINT", () => {
    logIncident({ event: "watchdog-signal", signal: "SIGINT" })
    process.exit(130)
  })
  process.on("SIGTERM", () => {
    logIncident({ event: "watchdog-signal", signal: "SIGTERM" })
    process.exit(143)
  })

  for (let attempt = 1; attempt <= opts.maxRestarts + 1; attempt++) {
    const { ok, reason } = await runOnce(opts, attempt)
    if (ok) {
      logIncident({ event: "success", attempt })
      process.exit(0)
    }
    if (attempt > opts.maxRestarts) {
      logIncident({ event: "gave-up", attempt, reason, maxRestarts: opts.maxRestarts })
      process.exit(1)
    }
    logIncident({ event: "restart", nextAttempt: attempt + 1, reason, delaySec: opts.restartDelaySec })
    await new Promise((r) => setTimeout(r, opts.restartDelaySec * 1000))
  }
}

main().catch((err) => {
  logIncident({ event: "watchdog-error", message: err instanceof Error ? err.message : String(err) })
  process.exit(2)
})
