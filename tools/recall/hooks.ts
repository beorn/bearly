/**
 * Hook handlers for UserPromptSubmit and SessionEnd.
 * Called by Claude Code hooks, not directly by users.
 */

import * as path from "path"
import * as os from "os"
import * as fs from "fs"
import { hookRecall } from "../lib/history/recall"
import { summarizeUnprocessedDays } from "./summarize-daily"
import { connectToDaemon } from "../../plugins/lore/src/lib/socket.ts"
import { resolveLoreSocketPath } from "../../plugins/lore/src/lib/config.ts"
import { LORE_METHODS, LORE_PROTOCOL_VERSION, type InjectDeltaResult } from "../../plugins/lore/src/lib/rpc.ts"

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
 *         "hooks": [{"type": "command", "command": "bun recall session-start"}]
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
    if (process.env.LORE_NO_DAEMON !== "1") {
      daemonStatus = await registerWithLoreDaemon({ claudePid, sessionId, transcriptPath, cwd })
    }

    console.error(
      `[recall session-start] claude PID ${claudePid} session=${sessionId.slice(0, 8)} sentinel=ok daemon=${daemonStatus} (${Date.now() - startTime}ms)`,
    )
  } catch (e) {
    console.error(`[recall session-start] error: ${e instanceof Error ? e.message : String(e)}`)
    // Never fail — session startup must not be blocked
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
  const deadline = Date.now() + 1500 // 1.5s overall budget
  const socketPath = resolveLoreSocketPath()
  try {
    const racePromise = (async () => {
      const client = await connectToDaemon(socketPath, { callTimeoutMs: 1000 })
      try {
        await client.call(LORE_METHODS.hello, {
          clientName: "recall-hook",
          clientVersion: "0.1.0",
          protocolVersion: LORE_PROTOCOL_VERSION,
        })
        await client.call(LORE_METHODS.sessionRegister, input)
      } finally {
        client.close()
      }
    })()
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), Math.max(50, deadline - Date.now())),
    )
    await Promise.race([racePromise, timeout])
    return "ok"
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ECONNREFUSED" || code === "ENOENT") return "no-daemon"
    return `err(${err instanceof Error ? err.message : String(err)})`
  }
}

// ============================================================================
// Daemon path for UserPromptSubmit — lore.inject_delta (Phase 5)
// ============================================================================

type InjectDeltaOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "ok"; additionalContext: string; contextLen: number; seenCount: number; turnNumber: number }
  | { kind: "error"; message: string }

/**
 * Call lore.inject_delta on the daemon. Short budget — if the daemon can't
 * answer in time we return `error` so the caller can fall back to the
 * library hookRecall path without blocking the user's prompt.
 */
async function tryInjectDeltaViaDaemon(prompt: string, sessionId?: string): Promise<InjectDeltaOutcome> {
  const socketPath = resolveLoreSocketPath()
  const deadline = Date.now() + 2500
  try {
    const racePromise = (async (): Promise<InjectDeltaOutcome> => {
      const client = await connectToDaemon(socketPath, { callTimeoutMs: 2000 })
      try {
        await client.call(LORE_METHODS.hello, {
          clientName: "recall-hook",
          clientVersion: "0.1.0",
          protocolVersion: LORE_PROTOCOL_VERSION,
        })
        const result = (await client.call(LORE_METHODS.injectDelta, { prompt, sessionId })) as InjectDeltaResult
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
      } finally {
        client.close()
      }
    })()
    const timeout = new Promise<InjectDeltaOutcome>((resolve) =>
      setTimeout(() => resolve({ kind: "error", message: "timeout" }), Math.max(50, deadline - Date.now())),
    )
    return await Promise.race([racePromise, timeout])
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ECONNREFUSED" || code === "ENOENT") return { kind: "error", message: "no-daemon" }
    return { kind: "error", message: err instanceof Error ? err.message : String(err) }
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

    // Try daemon first (Phase 5). Daemon holds per-session dedup state
    // in memory, so repeated injections across the same session don't
    // rely on tmpfile round-trips and survive Claude Code session
    // boundaries as long as the daemon is alive.
    if (process.env.LORE_NO_DAEMON !== "1") {
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
