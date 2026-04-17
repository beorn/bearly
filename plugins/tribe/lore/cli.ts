#!/usr/bin/env bun
/**
 * lore — CLI for the lore workspace daemon.
 *
 * Usage:
 *   bun lore.ts status              Show daemon status (auto-starts if needed)
 *   bun lore.ts sessions            List registered sessions
 *   bun lore.ts ask "query"         Run lore.ask via the daemon
 *   bun lore.ts ping                Cheap liveness check (lore.hello)
 *   bun lore.ts stop                Ask the daemon to exit (SIGTERM if reachable)
 */

import { parseArgs } from "node:util"
import { connectToDaemon, connectOrStart, readLoreDaemonPid, type LoreClient } from "./lib/socket.ts"
import { resolveLoreSocketPath, resolveLorePidPath } from "./lib/config.ts"
import {
  LORE_METHODS,
  LORE_PROTOCOL_VERSION,
  type StatusResult,
  type SessionsListResult,
  type AskResult,
  type WorkspaceStateResult,
} from "./lib/rpc.ts"

const CLIENT_NAME = "lore-cli"
const CLIENT_VERSION = "0.1.0"

async function withClient<T>(fn: (c: LoreClient) => Promise<T>, opts?: { noStart?: boolean }): Promise<T> {
  const socketPath = resolveLoreSocketPath()
  const client = opts?.noStart
    ? await connectToDaemon(socketPath, { callTimeoutMs: 2000 })
    : await connectOrStart(socketPath, { callTimeoutMs: 10_000 })
  try {
    await client.call(LORE_METHODS.hello, {
      clientName: CLIENT_NAME,
      clientVersion: CLIENT_VERSION,
      protocolVersion: LORE_PROTOCOL_VERSION,
    })
    return await fn(client)
  } finally {
    client.close()
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

async function cmdStatus(): Promise<void> {
  try {
    await withClient(async (c) => {
      const s = (await c.call(LORE_METHODS.status, {})) as StatusResult
      const sessions = (await c.call(LORE_METHODS.sessionsList, {})) as SessionsListResult
      const uptime = Date.now() - s.startedAt
      process.stdout.write(
        [
          `lore daemon  v${s.daemonVersion}  pid=${s.daemonPid}  uptime=${formatMs(uptime)}`,
          `socket       ${s.socketPath}`,
          `db           ${s.dbPath}`,
          `sessions     ${sessions.sessions.length} total, ${sessions.sessions.filter((x) => x.status === "alive").length} alive`,
          `idle         ${s.idleDeadline ? `quits in ${formatMs(Math.max(0, s.idleDeadline - Date.now()))}` : "active"}`,
        ].join("\n") + "\n",
      )
    })
  } catch (err) {
    process.stderr.write(`lore: cannot reach daemon: ${err instanceof Error ? err.message : err}\n`)
    process.exit(1)
  }
}

async function cmdSessions(): Promise<void> {
  await withClient(async (c) => {
    const { sessions } = (await c.call(LORE_METHODS.workspaceState, {})) as WorkspaceStateResult
    if (sessions.length === 0) {
      process.stdout.write("no sessions registered\n")
      return
    }
    const now = Date.now()
    for (const s of sessions) {
      const lastSeen = formatMs(now - s.lastSeen)
      const pid = String(s.claudePid).padStart(6, " ")
      const sid = s.sessionId.slice(0, 8)
      const proj = s.project ?? "-"
      const focus = s.focusSummary ?? s.focusHint
      const focusStr = focus ? ` focus="${focus}"` : ""
      const loose = s.looseEnds.length > 0 ? ` loose_ends=${s.looseEnds.length}` : ""
      process.stdout.write(
        `${s.status === "alive" ? "●" : "○"} pid=${pid} sess=${sid} proj=${proj} last_seen=${lastSeen}${focusStr}${loose}\n`,
      )
    }
  })
}

async function cmdWorkspace(): Promise<void> {
  await withClient(async (c) => {
    const state = (await c.call(LORE_METHODS.workspaceState, {})) as WorkspaceStateResult
    process.stdout.write(JSON.stringify(state, null, 2) + "\n")
  })
}

async function cmdAsk(query: string): Promise<void> {
  if (!query) {
    process.stderr.write("lore ask: query is required\n")
    process.exit(2)
  }
  await withClient(async (c) => {
    const result = (await c.call(LORE_METHODS.ask, { query })) as AskResult
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
  })
}

async function cmdPing(): Promise<void> {
  try {
    await withClient(
      async () => {
        process.stdout.write("pong\n")
      },
      { noStart: true },
    )
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ECONNREFUSED" || code === "ENOENT") {
      process.stdout.write("offline\n")
      process.exit(1)
    }
    process.stderr.write(`lore ping: ${err instanceof Error ? err.message : err}\n`)
    process.exit(1)
  }
}

function cmdStop(): void {
  const socketPath = resolveLoreSocketPath()
  const pid = readLoreDaemonPid(socketPath)
  if (!pid) {
    process.stdout.write("lore: no running daemon\n")
    return
  }
  try {
    process.kill(pid, "SIGTERM")
    process.stdout.write(`lore: SIGTERM sent to pid ${pid}\n`)
  } catch (err) {
    process.stderr.write(`lore: stop failed: ${err instanceof Error ? err.message : err}\n`)
    process.exit(1)
  }
}

function usage(): void {
  process.stdout.write(
    [
      "lore — CLI for the lore workspace daemon",
      "",
      "Usage: bun lore.ts <command>",
      "  status        Show daemon status (auto-starts if needed)",
      "  sessions      List registered sessions with focus hints",
      "  workspace     Dump full workspace state as JSON",
      "  ask <query>   Run lore.ask via the daemon",
      "  ping          Cheap liveness check (lore.hello), exits 1 if offline",
      "  stop          SIGTERM the running daemon",
      "  --help        Show this help",
      "",
    ].join("\n"),
  )
}

async function main(): Promise<void> {
  const { positionals } = parseArgs({ allowPositionals: true, strict: false })
  const [cmd, ...rest] = positionals
  if (!cmd || cmd === "--help" || cmd === "-h") {
    usage()
    return
  }
  switch (cmd) {
    case "status":
      await cmdStatus()
      break
    case "sessions":
      await cmdSessions()
      break
    case "workspace":
      await cmdWorkspace()
      break
    case "ask":
      await cmdAsk(rest.join(" "))
      break
    case "ping":
      await cmdPing()
      break
    case "stop":
      cmdStop()
      break
    default:
      process.stderr.write(`lore: unknown command '${cmd}'\n`)
      usage()
      process.exit(2)
  }
}

main().catch((err) => {
  process.stderr.write(`lore: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exit(1)
})
