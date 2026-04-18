/**
 * Hook handlers for UserPromptSubmit and SessionEnd.
 * Called by Claude Code hooks, not directly by users.
 */

import * as path from "path"
import * as os from "os"
import * as fs from "fs"
import { spawn } from "child_process"
import { hookRecall } from "../history/recall"
import { getDb, closeDb, getIndexMeta } from "../history/db"
import { summarizeUnprocessedDays } from "./summarize-daily"
import { withDaemonCall } from "../../../tribe/lore/lib/socket.ts"
import { resolveLoreSocketPath } from "../../../tribe/lore/lib/config.ts"
import { TRIBE_METHODS, LORE_PROTOCOL_VERSION, type InjectDeltaResult } from "../../../tribe/lore/lib/rpc.ts"
import { getEnv as getTribeEnv } from "../../../tribe/lore/lib/env.ts"

// ============================================================================
// Session sentinel (written by hook, read by `bun recall` subprocesses)
// ============================================================================

const SENTINEL_DIR = path.join(os.homedir(), ".claude", "bearly-sessions")

export interface SessionSentinel {
  claudePid: number
  sessionId: string
  transcriptPath?: string
  cwd: string
  ts: number
}

export function writeSessionSentinel(sentinel: Omit<SessionSentinel, "ts">): void {
  try {
    fs.mkdirSync(SENTINEL_DIR, { recursive: true })
    const payload: SessionSentinel = { ...sentinel, ts: Date.now() }
    const file = path.join(SENTINEL_DIR, `pid-${sentinel.claudePid}.json`)
    fs.writeFileSync(file, JSON.stringify(payload))

    // Opportunistic cleanup: drop sentinels older than 24h
    try {
      const entries = fs.readdirSync(SENTINEL_DIR)
      const cutoff = Date.now() - 24 * 60 * 60 * 1000
      for (const name of entries) {
        if (!name.startsWith("pid-") || !name.endsWith(".json")) continue
        const p = path.join(SENTINEL_DIR, name)
        const stat = fs.statSync(p)
        if (stat.mtimeMs < cutoff) fs.unlinkSync(p)
      }
    } catch {
      /* best effort */
    }
  } catch {
    // Sentinel writing is best-effort — must never block the hook.
  }
}

// ============================================================================
// Background FTS index refresh (shared by SessionStart + SessionEnd hooks)
// ============================================================================

const SESSION_STALE_MS = 60 * 60 * 1000 // 1 hour

function indexIsStale(maxAgeMs: number): boolean {
  try {
    const db = getDb()
    try {
      const lastRebuild = getIndexMeta(db, "last_rebuild")
      if (!lastRebuild) return true
      const age = Date.now() - new Date(lastRebuild).getTime()
      return age > maxAgeMs
    } finally {
      closeDb()
    }
  } catch {
    return true
  }
}

/**
 * Fire `recall index --incremental` detached and return immediately.
 * Used by SessionStart (if stale) and SessionEnd (always — a session just
 * finished, so there is guaranteed to be new content).
 *
 * Never blocks, never throws, never holds the hook open.
 */
function spawnBackgroundIncrementalIndex(reason: string): void {
  try {
    const scriptPath = process.argv[1]
    if (!scriptPath) return
    const logDir = path.join(os.homedir(), ".claude", "bearly-sessions")
    fs.mkdirSync(logDir, { recursive: true })
    const logPath = path.join(logDir, "index-bg.log")
    const out = fs.openSync(logPath, "a")
    const header = `\n[${new Date().toISOString()}] incremental index: ${reason}\n`
    fs.writeSync(out, header)
    const child = spawn(process.execPath, [scriptPath, "index", "--incremental"], {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, RECALL_BG: "1" },
    })
    child.unref()
    fs.closeSync(out)
  } catch {
    // best-effort — never block the hook
  }
}

// ============================================================================
// SessionStart hook — writes the sentinel ONCE per session
// ============================================================================

/**
 * Claude Code fires SessionStart once when a session begins, with stdin JSON
 * including session_id, transcript_path, and cwd. We use it to write the
 * sentinel file that `bun recall` will read later, without needing to
 * piggyback on every UserPromptSubmit hook call.
 *
 * Install in .claude/settings.json:
 *   {
 *     "hooks": {
 *       "SessionStart": [{
 *         "matcher": "",
 *         "hooks": [{"type": "command", "command": "tribe hook session-start"}]
 *       }]
 *     }
 *   }
 */
export async function cmdSessionStart(): Promise<void> {
  const startTime = Date.now()
  try {
    const stdin = await readStdin()
    let input: { session_id?: string; transcript_path?: string; cwd?: string }
    try {
      input = JSON.parse(stdin) as typeof input
    } catch (e) {
      console.error(`[recall session-start] invalid JSON: ${String(e)}`)
      process.exit(0) // don't block session startup
    }

    if (!input.session_id || !input.cwd) {
      console.error(`[recall session-start] missing session_id or cwd — skipping`)
      process.exit(0)
    }

    const claudePid = process.ppid
    const sessionId = input.session_id
    const transcriptPath = input.transcript_path
    const cwd = input.cwd

    // Always write the sentinel — it's the fallback path when the daemon is
    // down (session-context.ts still reads it). Fast and never blocks.
    writeSessionSentinel({ claudePid, sessionId, transcriptPath, cwd })

    // Best-effort register with lore daemon. Non-blocking: if we can't reach
    // the daemon in 1s we give up and rely on the sentinel.
    let daemonStatus = "skipped"
    if (getTribeEnv("TRIBE_NO_DAEMON") !== "1") {
      daemonStatus = await registerWithLoreDaemon({ claudePid, sessionId, transcriptPath, cwd })
    }

    // If the FTS5 index is stale (>1h since last rebuild), kick off an
    // incremental refresh in the background. Never blocks session startup.
    let indexStatus = "fresh"
    if (process.env.RECALL_NO_BG_INDEX !== "1" && indexIsStale(SESSION_STALE_MS)) {
      spawnBackgroundIncrementalIndex("SessionStart (stale)")
      indexStatus = "refreshing"
    }

    console.error(
      `[recall session-start] claude PID ${claudePid} session=${sessionId.slice(0, 8)} sentinel=ok daemon=${daemonStatus} index=${indexStatus} (${Date.now() - startTime}ms)`,
    )
  } catch (e) {
    console.error(`[recall session-start] error: ${e instanceof Error ? e.message : String(e)}`)
    // Never fail — session startup must not be blocked
  }
}

// ============================================================================
// SessionEnd hook — always triggers incremental index refresh
// ============================================================================

/**
 * Claude Code fires SessionEnd when a session ends. A session just produced
 * new JSONL content, so an incremental index refresh is always worthwhile.
 * Runs detached — the hook returns immediately.
 *
 * Install in .claude/settings.json:
 *   {
 *     "hooks": {
 *       "SessionEnd": [{
 *         "matcher": "",
 *         "hooks": [{"type": "command", "command": "tribe hook session-end"}]
 *       }]
 *     }
 *   }
 */
export async function cmdSessionEnd(): Promise<void> {
  const startTime = Date.now()
  try {
    // Drain stdin so Claude Code doesn't hang on the pipe, but we don't need it.
    try {
      await readStdin()
    } catch {
      /* best effort */
    }
    if (process.env.RECALL_NO_BG_INDEX !== "1") {
      spawnBackgroundIncrementalIndex("SessionEnd")
    }
    console.error(`[recall session-end] background incremental index spawned (${Date.now() - startTime}ms)`)
  } catch (e) {
    console.error(`[recall session-end] error: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * Register the current session with the lore daemon. Returns a short status
 * string for the log line. Never throws — daemon registration is best-effort
 * and the sentinel file is the ground-truth fallback.
 */
async function registerWithLoreDaemon(input: {
  claudePid: number
  sessionId: string
  transcriptPath?: string
  cwd: string
}): Promise<string> {
  const outcome = await withDaemonCall(
    { socketPath: resolveLoreSocketPath(), deadlineMs: 1500, callTimeoutMs: 1000 },
    async (client) => {
      await client.call(TRIBE_METHODS.hello, {
        clientName: "recall-hook",
        clientVersion: "0.1.0",
        protocolVersion: LORE_PROTOCOL_VERSION,
      })
      await client.call(TRIBE_METHODS.sessionRegister, input)
    },
  )
  switch (outcome.kind) {
    case "ok":
      return "ok"
    case "no-daemon":
      return "no-daemon"
    case "timeout":
      return "err(timeout)"
    case "error":
      return `err(${outcome.message})`
  }
}

// ============================================================================
// Daemon path for UserPromptSubmit — tribe.inject_delta
// ============================================================================

type InjectDeltaOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "ok"; additionalContext: string; contextLen: number; seenCount: number; turnNumber: number }
  | { kind: "error"; message: string }

/**
 * Call tribe.inject_delta on the daemon. Short budget — if the daemon can't
 * answer in time we return `error` so the caller can fall back to the
 * library hookRecall path without blocking the user's prompt.
 */
async function tryInjectDeltaViaDaemon(prompt: string, sessionId?: string): Promise<InjectDeltaOutcome> {
  const outcome = await withDaemonCall(
    { socketPath: resolveLoreSocketPath(), deadlineMs: 2500, callTimeoutMs: 2000 },
    async (client): Promise<InjectDeltaOutcome> => {
      await client.call(TRIBE_METHODS.hello, {
        clientName: "recall-hook",
        clientVersion: "0.1.0",
        protocolVersion: LORE_PROTOCOL_VERSION,
      })
      const result = (await client.call(TRIBE_METHODS.injectDelta, { prompt, sessionId })) as InjectDeltaResult
      if (result.skipped) {
        return { kind: "skipped", reason: result.reason ?? "unknown" }
      }
      const ctx = result.additionalContext ?? ""
      return {
        kind: "ok",
        additionalContext: ctx,
        contextLen: ctx.length,
        seenCount: result.seenCount ?? 0,
        turnNumber: result.turnNumber ?? 0,
      }
    },
  )
  switch (outcome.kind) {
    case "ok":
      return outcome.value
    case "no-daemon":
      return { kind: "error", message: "no-daemon" }
    case "timeout":
      return { kind: "error", message: "timeout" }
    case "error":
      return { kind: "error", message: outcome.message }
  }
}

// ============================================================================
// Stdin reader
// ============================================================================

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}

// ============================================================================
// Hook command — UserPromptSubmit
// ============================================================================

export async function cmdHook(): Promise<void> {
  const startTime = Date.now()
  try {
    const stdin = await readStdin()
    let input: { prompt?: string; session_id?: string; transcript_path?: string; cwd?: string }
    try {
      input = JSON.parse(stdin) as { prompt?: string; session_id?: string; transcript_path?: string; cwd?: string }
    } catch (e) {
      console.error(
        `[recall hook] FATAL: invalid JSON on stdin (${Date.now() - startTime}ms): ${String(e)}\nstdin was: ${stdin.slice(0, 200)}`,
      )
      process.exit(1)
      return
    }

    // Write a sentinel file keyed by the parent Claude Code PID so that
    // subsequent `bun recall` invocations (from the same session) can look
    // up the current session_id reliably — without depending on env vars
    // Claude Code doesn't set, or mtime heuristics that break under
    // parallel sessions. Hook runs as a direct child of claude, so
    // process.ppid = claude PID.
    if (input.session_id && input.cwd) {
      writeSessionSentinel({
        claudePid: process.ppid,
        sessionId: input.session_id,
        transcriptPath: input.transcript_path,
        cwd: input.cwd,
      })
    }

    const prompt = input.prompt
    if (!prompt) {
      console.error(`[recall hook] no prompt in stdin (${Date.now() - startTime}ms)`)
      process.exit(0)
    }

    // Try daemon first. Daemon holds per-session dedup state
    // in memory, so repeated injections across the same session don't
    // rely on tmpfile round-trips and survive Claude Code session
    // boundaries as long as the daemon is alive.
    if (getTribeEnv("TRIBE_NO_DAEMON") !== "1") {
      const daemonOutput = await tryInjectDeltaViaDaemon(prompt, input.session_id)
      if (daemonOutput.kind === "skipped") {
        console.error(
          `[recall hook] daemon skipped: ${daemonOutput.reason} (${Date.now() - startTime}ms) prompt="${prompt.slice(0, 60)}"`,
        )
        process.exit(0)
      }
      if (daemonOutput.kind === "ok") {
        console.error(
          `[recall hook] daemon OK: ${daemonOutput.contextLen} chars synthesis (${Date.now() - startTime}ms, seen=${daemonOutput.seenCount} turn=${daemonOutput.turnNumber}) prompt="${prompt.slice(0, 60)}"`,
        )
        console.log(
          JSON.stringify({
            hookSpecificOutput: { additionalContext: daemonOutput.additionalContext },
          }),
        )
        process.exit(0)
      }
      // kind === "error" — fall through to library path below.
    }

    const result = await hookRecall(prompt)
    const elapsed = Date.now() - startTime
    if (result.skipped) {
      console.error(`[recall hook] skipped: ${result.reason} (${elapsed}ms) prompt="${prompt.slice(0, 60)}"`)
      process.exit(0)
    }
    const synthLen = result.hookOutput?.hookSpecificOutput.additionalContext.length ?? 0
    console.error(`[recall hook] OK: ${synthLen} chars synthesis (${elapsed}ms) prompt="${prompt.slice(0, 60)}"`)
    console.log(JSON.stringify(result.hookOutput))
  } catch (e) {
    const elapsed = Date.now() - startTime
    console.error(
      `[recall hook] FATAL: unhandled error (${elapsed}ms): ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}`,
    )
    process.exit(1)
  }
}

// ============================================================================
// Remember command — SessionEnd
// ============================================================================

/**
 * SessionEnd hook: trigger daily summarization for any unprocessed past days.
 * No per-session LLM call — daily summaries are more useful and less noisy.
 */
export async function cmdRemember(opts: { json?: boolean }): Promise<void> {
  const startTime = Date.now()
  try {
    // Read stdin (required by hook protocol, but we only need session_id for logging)
    const stdin = await readStdin()
    let sessionId = "unknown"
    try {
      const input = JSON.parse(stdin) as { session_id?: string }
      sessionId = input.session_id?.slice(0, 8) ?? "unknown"
    } catch {
      // Best-effort parse
    }

    // Summarize any unprocessed past days (not today — still in progress)
    const results = await summarizeUnprocessedDays({ limit: 3, verbose: false })
    const elapsed = Date.now() - startTime

    const summarized = results.filter((r) => !r.skipped)
    if (summarized.length > 0) {
      console.error(
        `[recall remember] summarized ${summarized.length} day(s): ${summarized.map((r) => r.date).join(", ")} (${elapsed}ms) session=${sessionId}`,
      )
    } else {
      console.error(`[recall remember] no unprocessed days (${elapsed}ms) session=${sessionId}`)
    }

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2))
    }
  } catch (e) {
    const elapsed = Date.now() - startTime
    console.error(
      `[recall remember] FATAL: unhandled error (${elapsed}ms): ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}`,
    )
    process.exit(1)
  }
}
