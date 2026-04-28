#!/usr/bin/env bun
/**
 * bg-recall — async just-in-time recall daemon, wired to the bearly tribe.
 *
 * The package `@bearly/bg-recall` carries the pure logic (pipeline, throttle,
 * metrics, log, explain). This script is the bearly-internal host: it
 *   - connects to the tribe daemon as a system member named `bg-recall`
 *   - opens a tiny Unix socket where the PostToolUse hook posts tool-call
 *     events (JSONL: one event per line)
 *   - wires recall + qmd as the daemon's `sources`
 *   - composes the recall-quality-gate library when present, falls back to
 *     a permissive stub otherwise (with a TODO for parent integration)
 *   - serves `bg-recall status / watch / explain / start / stop` via the
 *     same socket
 *
 * Lifecycle: idle-quits after BG_RECALL_IDLE_TIMEOUT_SEC of zero events
 * (default 30 min). The host calls `process.exit(0)` from `onIdleQuit`.
 *
 * NEVER blocks. The PostToolUse hook fires the event over a unix socket and
 * exits — no waiting on a recall query, no waiting on a tribe send.
 */

import { Command } from "commander"
import { createConnection, createServer, type Server, type Socket } from "node:net"
import { existsSync, mkdirSync, unlinkSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { spawn } from "node:child_process"
import { addWriter, createFileWriter } from "loggily"
import { createBgRecallDaemon, type BgRecallDaemon, type ToolCallEvent, type QualityGate } from "@bearly/bg-recall"
import { formatStatus, formatExplain } from "@bearly/bg-recall"
import {
  resolveSocketPath as resolveTribeSocketPath,
  connectToDaemon as connectToTribeDaemon,
  createReconnectingClient as createTribeClient,
  TRIBE_PROTOCOL_VERSION,
  type DaemonClient,
} from "./lib/tribe/socket.ts"
import { createLineParser, makeRequest, makeResponse, makeError, isRequest } from "@bearly/tribe-client"
import { recall as bearlyRecall } from "../plugins/recall/src/history/search.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BG_RECALL_NAME = "bg-recall"

function resolveBgRecallSocket(): string {
  if (process.env.BG_RECALL_SOCKET) return process.env.BG_RECALL_SOCKET
  const xdg = process.env.XDG_RUNTIME_DIR
  return xdg ? resolve(xdg, "bg-recall.sock") : resolve(process.env.HOME ?? "/tmp", ".local/share/bg-recall.sock")
}

function resolveDaemonScript(): string {
  return resolve(dirname(new URL(import.meta.url).pathname), "bg-recall.ts")
}

// ---------------------------------------------------------------------------
// Observability — route bg-recall:* loggily traffic to a JSONL file.
// Resolution: LOGGILY_FILE_BG_RECALL → LOGGILY_FILE → BG_RECALL_DEBUG_LOG.
// The last is a one-release back-compat alias retained until the
// follow-on env-purge bead lands.
// ---------------------------------------------------------------------------

function installBgRecallFileWriter(): void {
  const path = process.env.LOGGILY_FILE_BG_RECALL ?? process.env.LOGGILY_FILE ?? process.env.BG_RECALL_DEBUG_LOG
  if (!path) return
  const writer = createFileWriter(path)
  addWriter({ ns: "bg-recall:*" }, (_formatted, _level, _ns, event) => {
    if (event.kind !== "log") return
    // Re-emit as JSONL so consumers can `tail -f | jq .`. One namespace per
    // line, structured props (hintId, score, …) preserved verbatim.
    writer.write(
      JSON.stringify({
        ts: new Date(event.time).toISOString(),
        namespace: event.namespace,
        level: event.level,
        msg: event.message,
        ...event.props,
      }),
    )
  })
}

// ---------------------------------------------------------------------------
// Quality gate — composed with @bearly/recall when available
// ---------------------------------------------------------------------------

/**
 * Loads the recall-quality-gate library if present. Returns a permissive
 * fallback otherwise. The fallback is logged so it's obvious the gate isn't
 * wired — never fails silently.
 */
async function loadQualityGate(): Promise<QualityGate> {
  try {
    // Dynamic import so missing module doesn't break startup.
    // The gate lives in @bearly/recall's lib/quality-gate.ts (added by
    // km-tribe.recall-quality-gate). Path is intentionally relative — the
    // host is bearly-internal.
    const mod = await import("../plugins/recall/src/lib/quality-gate.ts")
    return {
      isAcceptable: (text) => mod.isAcceptable(text),
      analyze: (text) => mod.analyzeQuality(text),
    }
  } catch {
    console.error(
      "[bg-recall] WARN: recall-quality-gate unavailable; using permissive fallback. " +
        "TODO(parent-resolved): wire to @bearly/recall.analyzeQuality once km-tribe.recall-quality-gate lands.",
    )
    return {
      isAcceptable: () => true,
      analyze: () => ({}),
    }
  }
}

// ---------------------------------------------------------------------------
// Recall sources — bearly first; qmd is optional + best-effort
// ---------------------------------------------------------------------------

function buildBearlySource(): import("@bearly/bg-recall").RecallFn {
  return async (query, opts) => {
    const startMs = Date.now()
    try {
      const result = await bearlyRecall(query, {
        limit: opts?.limit ?? 5,
        since: opts?.since ?? "7d",
        raw: true, // skip LLM synthesis — we score ourselves
        timeout: 2000,
      })
      return {
        source: "bearly",
        query,
        durationMs: Date.now() - startMs,
        hits: result.results.map((r) => ({
          id: `${r.sessionId}-${r.timestamp}`,
          source: "bearly",
          title: r.sessionTitle ?? r.snippet.slice(0, 60),
          snippet: r.snippet,
          ts: new Date(r.timestamp).toISOString(),
          rank: r.rank,
          sessionId: r.sessionId,
        })),
      }
    } catch (err) {
      // Source errors don't block other sources. Empty result + log.
      console.error(`[bg-recall] bearly recall failed: ${err instanceof Error ? err.message : String(err)}`)
      return { source: "bearly", query, durationMs: Date.now() - startMs, hits: [] }
    }
  }
}

// ---------------------------------------------------------------------------
// Daemon mode — long-running process that owns the bg-recall socket
// ---------------------------------------------------------------------------

type DaemonMode = {
  daemon: BgRecallDaemon
  tribe: DaemonClient
  hostServer: Server
  /** Send a hint via the tribe daemon's `tribe.send` RPC. */
  send: (to: string, content: string, type: string) => Promise<void>
}

async function startDaemon(socketPath: string): Promise<DaemonMode> {
  // Wire JSONL observability for the bg-recall:* namespace tree if a path is
  // configured. Resolution order: LOGGILY_FILE_BG_RECALL → LOGGILY_FILE →
  // BG_RECALL_DEBUG_LOG (back-compat alias for one release).
  installBgRecallFileWriter()

  // Ensure runtime dir + clean stale socket file.
  const sockDir = dirname(socketPath)
  if (!existsSync(sockDir)) mkdirSync(sockDir, { recursive: true })
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath)
    } catch {
      /* ignore */
    }
  }

  // Connect to the tribe daemon.
  const tribeSocket = resolveTribeSocketPath()
  const tribe = await createTribeClient({
    socketPath: tribeSocket,
    async onConnect(client) {
      await client.call("register", {
        name: BG_RECALL_NAME,
        role: "watch", // system member — never chief, never broadcast target
        domains: ["bg-recall"],
        project: process.cwd(),
        protocolVersion: TRIBE_PROTOCOL_VERSION,
        pid: process.pid,
        peerSocket: null,
      })
    },
  })

  const qualityGate = await loadQualityGate()

  const send: DaemonMode["send"] = async (to, content, type) => {
    await tribe.call("tribe.send", { to, message: content, type })
  }

  const daemon = createBgRecallDaemon({
    sources: { bearly: buildBearlySource() },
    qualityGate,
    tribeSend: send,
    onIdleQuit: () => {
      console.error("[bg-recall] idle-quit — shutting down")
      tribe.close()
      hostServer.close()
      process.exit(0)
    },
  })
  daemon.start()

  // Open the host socket where PostToolUse and the CLI talk to us.
  const hostServer = createServer((conn: Socket) => handleConn(conn, daemon))
  await new Promise<void>((res, rej) => {
    hostServer.once("error", rej)
    hostServer.listen(socketPath, () => {
      hostServer.removeListener("error", rej)
      res()
    })
  })

  console.error(`[bg-recall] listening on ${socketPath}`)
  return { daemon, tribe, hostServer, send }
}

function handleConn(conn: Socket, daemon: BgRecallDaemon): void {
  const parse = createLineParser(async (msg) => {
    if (!isRequest(msg)) return
    const { id, method, params } = msg
    try {
      switch (method) {
        case "observe": {
          const event = params as unknown as ToolCallEvent
          const decision = await daemon.observeToolCall(event)
          conn.write(makeResponse(id, { ok: true, decisionId: decision.emitted?.id ?? null }))
          break
        }
        case "status": {
          conn.write(makeResponse(id, daemon.status()))
          break
        }
        case "explain": {
          const hintId = String((params as Record<string, unknown>)?.hintId ?? "")
          const decision = daemon.explain(hintId)
          conn.write(makeResponse(id, { decision: decision ?? null }))
          break
        }
        case "recent-hints": {
          const limit = Number((params as Record<string, unknown>)?.limit ?? 50)
          conn.write(makeResponse(id, { hints: daemon.recentHints(limit) }))
          break
        }
        case "recent-decisions": {
          const limit = Number((params as Record<string, unknown>)?.limit ?? 50)
          conn.write(makeResponse(id, { decisions: daemon.recentDecisions(limit) }))
          break
        }
        case "ping": {
          conn.write(makeResponse(id, { pong: true, pid: process.pid }))
          break
        }
        case "stop": {
          conn.write(makeResponse(id, { ok: true }))
          setTimeout(() => process.exit(0), 50)
          break
        }
        default:
          conn.write(makeError(id, -32601, `Method not found: ${method}`))
      }
    } catch (err) {
      conn.write(makeError(id, -32603, err instanceof Error ? err.message : String(err)))
    }
  })
  conn.on("data", parse)
  conn.on("error", () => {
    /* ignore */
  })
}

// ---------------------------------------------------------------------------
// CLI client — connects to the daemon socket and issues a single RPC
// ---------------------------------------------------------------------------

async function callBgRecall(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const socketPath = resolveBgRecallSocket()
  // Auto-start if no daemon: connect-or-spawn, like the tribe pattern.
  let client: DaemonClient
  try {
    client = await connectViaSocket(socketPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "ECONNREFUSED" && code !== "ENOENT") throw err
    // Spawn detached daemon.
    const child = spawn(process.execPath, [resolveDaemonScript(), "start", "--socket", socketPath], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    })
    child.unref()
    // Retry connect with backoff.
    let connected: DaemonClient | null = null
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, Math.min(50 * 2 ** attempt, 1000)))
      try {
        connected = await connectViaSocket(socketPath)
        break
      } catch {
        /* retry */
      }
    }
    if (!connected) throw new Error(`Failed to start bg-recall daemon at ${socketPath}`)
    client = connected
  }
  try {
    return await client.call(method, params)
  } finally {
    client.close()
  }
}

function connectViaSocket(socketPath: string): Promise<DaemonClient> {
  return new Promise((res, rej) => {
    const sock = createConnection(socketPath)
    const pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
    const handlers: Array<(method: string, params?: Record<string, unknown>) => void> = []
    let nextId = 1
    const parse = createLineParser((msg) => {
      const m = msg as { id?: number | string; result?: unknown; error?: { message: string } }
      if (m.id !== undefined && !("method" in (msg as Record<string, unknown>))) {
        const p = pending.get(m.id)
        if (p) {
          pending.delete(m.id)
          if (m.error) p.reject(new Error(m.error.message))
          else p.resolve(m.result)
        }
      }
    })
    sock.on("data", parse)
    sock.on("error", rej)
    sock.once("connect", () => {
      sock.removeListener("error", rej)
      sock.on("error", () => {
        for (const [, p] of pending) p.reject(new Error("Connection error"))
        pending.clear()
      })
      res({
        call(method, params) {
          return new Promise((res2, rej2) => {
            const id = nextId++
            pending.set(id, { resolve: res2, reject: rej2 })
            sock.write(makeRequest(id, method, params))
            setTimeout(() => {
              if (pending.delete(id)) rej2(new Error(`Request ${method} timed out`))
            }, 5000)
          })
        },
        notify() {
          /* unused */
        },
        onNotification(h) {
          handlers.push(h)
        },
        close() {
          for (const [, p] of pending) p.reject(new Error("Closed"))
          pending.clear()
          sock.end()
        },
        socket: sock,
      })
    })
  })
}

// ---------------------------------------------------------------------------
// CLI commands
// ---------------------------------------------------------------------------

const program = new Command("bg-recall")
program.description("Background just-in-time recall daemon")

program
  .command("start")
  .description("Start the daemon (foreground)")
  .option("--socket <path>", "Override the bg-recall socket path")
  .action(async (opts) => {
    const sock = opts.socket ?? resolveBgRecallSocket()
    await startDaemon(sock)
    // Stay alive until idle-quit fires.
  })

program
  .command("stop")
  .description("Stop the running daemon")
  .action(async () => {
    try {
      await callBgRecall("stop")
      console.log("daemon stopped")
    } catch (err) {
      console.error(`stop failed: ${err instanceof Error ? err.message : err}`)
      process.exit(1)
    }
  })

program
  .command("status")
  .description("Show daemon state, sessions, and recent hints")
  .option("--json", "Emit raw JSON")
  .action(async (opts) => {
    const status = (await callBgRecall("status")) as import("@bearly/bg-recall").DaemonStatus
    if (opts.json) console.log(JSON.stringify(status, null, 2))
    else console.log(formatStatus(status))
  })

program
  .command("explain <hint-id>")
  .description("Show the full causality chain behind a hint")
  .action(async (hintId) => {
    const result = (await callBgRecall("explain", { hintId })) as {
      decision: import("@bearly/bg-recall").Decision | null
    }
    if (!result.decision) {
      console.error(`hint ${hintId} not found in the recent ring`)
      process.exit(1)
    }
    console.log(formatExplain(result.decision))
  })

program
  .command("watch")
  .description("Live TUI dashboard (silvery-rendered)")
  .action(() => {
    // Spawn the .tsx file as a separate bun process — tribe-watch pattern.
    // Keeps React load cost out of the status/explain hot paths and avoids
    // needing JSX compilation in the CLI's tsc pipeline.
    const watchScript = resolve(dirname(new URL(import.meta.url).pathname), "bg-recall-watch.tsx")
    const child = spawn(process.execPath, [watchScript], { stdio: "inherit", env: process.env })
    child.on("exit", (code) => process.exit(code ?? 0))
  })

program
  .command("observe")
  .description("Post a tool-call event (JSON on stdin)")
  .action(async () => {
    const chunks: Buffer[] = []
    for await (const c of process.stdin) chunks.push(c as Buffer)
    const event = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as ToolCallEvent
    const result = await callBgRecall("observe", event as unknown as Record<string, unknown>)
    console.log(JSON.stringify(result))
  })

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exit(1)
})
