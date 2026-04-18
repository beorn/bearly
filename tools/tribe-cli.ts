#!/usr/bin/env bun
/**
 * Tribe CLI — Inspect and interact with the tribe from the terminal.
 *
 * Connects to the tribe daemon via Unix socket (no direct DB access).
 */
import { dirname, resolve } from "node:path"
import { existsSync } from "node:fs"
import { spawn } from "node:child_process"
import { Database } from "bun:sqlite"
import { Command, int } from "@silvery/commander"
import { resolveSocketPath, connectToDaemon, readDaemonPid } from "./lib/tribe/socket.ts"
import { generateRetro, formatMarkdown, parseDuration } from "./lib/tribe/retro.ts"
import {
  defaultInstallEnv,
  planInstall,
  applyInstall,
  formatInstallPlan,
  planUninstall,
  applyUninstall,
  formatUninstallPlan,
  doctorReport,
  formatDoctorReport,
} from "./lib/tribe/install.ts"
import { dispatchHook, type HookEvent } from "./lib/tribe/hook-dispatch.ts"

// --- Daemon connection ---

async function callDaemon(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const socketPath = resolveSocketPath()
  try {
    const client = await connectToDaemon(socketPath)
    try {
      const result = await client.call(method, params)
      return result
    } finally {
      client.close()
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ECONNREFUSED" || code === "ENOENT") {
      console.error(`No daemon running (socket: ${socketPath})`)
      console.error(`Start one with: tribe start`)
      process.exit(1)
    }
    throw err
  }
}

// --- Formatting ---

function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

function fmtAge(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
}

function pad(s: string, n: number): string {
  return s.padEnd(n)
}

// --- Types ---

interface SessionInfo {
  id: string
  name: string
  role: string
  domains: string[]
  pid: number
  projectName?: string
  claudeSessionId: string | null
  connectedAt: number
  uptimeMs: number
  source: "daemon" | "db"
  conn?: string
}

interface Msg {
  id: string
  type: string
  sender: string
  recipient: string
  content: string
  bead_id: string | null
  ts: number
}

// --- Commands ---

async function cmdStatus(): Promise<void> {
  const result = (await callDaemon("cli_status")) as {
    sessions: SessionInfo[]
    daemon: { pid: number; uptime: number; clients: number; dbPath: string; socketPath: string }
  }
  const { sessions, daemon } = result

  if (!sessions.length) {
    console.log("No active tribe sessions.")
    return
  }

  console.log(`TRIBE STATUS \u2014 ${sessions.length} session${sessions.length !== 1 ? "s" : ""} active\n`)
  const nW = Math.max(4, ...sessions.map((r) => r.name.length))
  const rW = Math.max(4, ...sessions.map((r) => r.role.length))
  const dW = Math.max(
    7,
    ...sessions.map((r) => {
      const d = r.domains ?? []
      return (d.length ? d.join(", ") : "\u2014").length
    }),
  )
  console.log(`  ${pad("NAME", nW)}  ${pad("ROLE", rW)}  ${pad("DOMAINS", dW)}  ${pad("UPTIME", 10)}  SOURCE`)
  for (const r of sessions) {
    const d = r.domains ?? []
    console.log(
      `  ${pad(r.name, nW)}  ${pad(r.role, rW)}  ${pad(d.length ? d.join(", ") : "\u2014", dW)}  ${pad(fmtDur(r.uptimeMs), 10)}  ${r.source}`,
    )
  }
  console.log(`\n  Daemon: pid=${daemon.pid}, uptime=${fmtDur(daemon.uptime * 1000)}, clients=${daemon.clients}`)
}

async function cmdSessions(showAll: boolean): Promise<void> {
  const result = (await callDaemon("cli_status")) as {
    sessions: SessionInfo[]
    daemon: { pid: number; uptime: number; clients: number }
  }
  let sessions = result.sessions

  if (!showAll) {
    sessions = sessions.filter((s) => s.source === "daemon")
  }

  if (!sessions.length) {
    console.log(showAll ? "No tribe sessions." : "No active tribe sessions.")
    return
  }

  console.log(`TRIBE SESSIONS \u2014 ${sessions.length} ${showAll ? "all" : "active"}\n`)
  const nW = Math.max(4, ...sessions.map((r) => r.name.length))
  const rW = Math.max(4, ...sessions.map((r) => r.role.length))
  console.log(`  ${pad("NAME", nW)}  ${pad("ROLE", rW)}  ${pad("PID", 7)}  ${pad("UPTIME", 10)}  SOURCE`)
  for (const r of sessions) {
    console.log(
      `  ${pad(r.name, nW)}  ${pad(r.role, rW)}  ${pad(String(r.pid), 7)}  ${pad(fmtDur(r.uptimeMs), 10)}  ${r.source}`,
    )
  }
}

async function cmdLog(limit: number, follow: boolean): Promise<void> {
  const result = (await callDaemon("cli_log", { limit })) as { messages: Msg[] }
  const rows = result.messages

  if (!follow) {
    if (!rows.length) {
      console.log("No messages in tribe log.")
      return
    }
    console.log(`TRIBE LOG \u2014 last ${rows.length} message${rows.length !== 1 ? "s" : ""}\n`)
    for (const m of rows) {
      fmtMsg(m)
    }
    return
  }

  // Follow mode: print recent, then subscribe to daemon notifications
  console.log(`TRIBE LOG \u2014 follow mode (Ctrl+C to quit)\n`)
  for (const m of rows) fmtMsg(m)

  // For follow mode, keep the daemon connection open and listen for notifications
  const socketPath = resolveSocketPath()
  const client = await connectToDaemon(socketPath)
  client.onNotification((method, params) => {
    if (method === "channel") {
      const ts = Date.now()
      const from = String(params?.from ?? "unknown")
      const type = String(params?.type ?? "notify")
      const content = String(params?.content ?? "")
      const to = "all"
      console.log(
        `  ${fmtTime(ts)}  ${pad(`${from} \u2192 ${to}`, 28)}  [${type}] "${content.length > 120 ? content.slice(0, 117) + "..." : content}"`,
      )
    } else if (method === "session.joined" || method === "session.left") {
      const name = String(params?.name ?? "unknown")
      const action = method === "session.joined" ? "joined" : "left"
      console.log(`  ${fmtTime(Date.now())}  [system] ${name} ${action} the tribe`)
    }
  })
  // Subscribe to push notifications
  await client.call("subscribe")
  // Also poll for new DB messages periodically
  let lastTs = rows.length ? Math.max(...rows.map((m) => m.ts)) : Date.now()
  setInterval(async () => {
    try {
      const newResult = (await client.call("cli_log", { limit: 50 })) as { messages: Msg[] }
      const newMsgs = newResult.messages.filter((m) => m.ts > lastTs)
      for (const m of newMsgs) {
        fmtMsg(m)
        lastTs = m.ts
      }
    } catch {
      // Connection lost
    }
  }, 2000)
}

function fmtMsg(m: Msg): void {
  const to = m.recipient === "*" ? "all" : m.recipient
  const txt = m.content.length > 120 ? m.content.slice(0, 117) + "..." : m.content
  const bead = m.bead_id ? ` bead=${m.bead_id}` : ""
  console.log(`  ${fmtTime(m.ts)}  ${pad(`${m.sender} \u2192 ${to}`, 28)}  [${m.type}]${bead} "${txt}"`)
}

async function cmdSend(to: string, message: string): Promise<void> {
  await callDaemon("tribe.send", { to, message, type: "notify" })
  console.log(`Sent message to ${to}`)
}

async function cmdHealth(): Promise<void> {
  const result = (await callDaemon("cli_health")) as {
    content: Array<{ type: string; text: string }>
    daemon: { pid: number; uptime: number; clients: number }
  }

  console.log("TRIBE HEALTH DIAGNOSTICS\n")
  // The health response comes from tribe_health handler, which returns MCP-formatted content
  try {
    const text = result.content?.[0]?.text ?? JSON.stringify(result)
    const data = JSON.parse(text) as Record<string, unknown>
    for (const [key, value] of Object.entries(data)) {
      if (key === "sessions" && Array.isArray(value)) {
        console.log(`  Sessions: ${(value as Array<Record<string, unknown>>).length}`)
        for (const s of value as Array<Record<string, string>>) {
          console.log(`    ${s.name} (${s.role}) — ${s.status}`)
        }
      } else if (key === "issues" && Array.isArray(value)) {
        if ((value as unknown[]).length) {
          console.log("\n  Issues:")
          for (const i of value as string[]) console.log(`    ${i}`)
        } else {
          console.log("\n  No issues detected.")
        }
      }
    }
    if (result.daemon) {
      console.log(
        `\n  Daemon: pid=${result.daemon.pid}, uptime=${fmtDur(result.daemon.uptime * 1000)}, clients=${result.daemon.clients}`,
      )
    }
  } catch {
    // Fallback: just print the raw result
    console.log(JSON.stringify(result, null, 2))
  }
}

// --- Retro ---

/** Walk up from cwd to find .beads directory */
function findBeadsDir(): string {
  let dir = process.cwd()
  while (dir !== "/") {
    const candidate = resolve(dir, ".beads")
    if (existsSync(candidate)) return candidate
    dir = dirname(dir)
  }
  return resolve(process.cwd(), ".beads")
}

function cmdRetro(opts: { since?: string; format: string; db?: string }): void {
  const dbPath = opts.db ?? resolve(findBeadsDir(), "tribe.db")
  if (!existsSync(dbPath)) {
    console.error(`No tribe database found at ${dbPath}`)
    process.exit(1)
  }

  const db = new Database(dbPath, { readonly: true })
  db.run("PRAGMA busy_timeout = 5000")
  let sinceMs: number | undefined
  if (opts.since) {
    try {
      sinceMs = parseDuration(opts.since)
    } catch (err) {
      console.error(String(err))
      process.exit(1)
    }
  }
  const report = generateRetro(db, sinceMs)
  console.log(opts.format === "json" ? JSON.stringify(report, null, 2) : formatMarkdown(report))
  db.close()
}

// --- Daemon management ---

function getSocketPath(): string {
  return resolveSocketPath()
}

function cmdStart(): void {
  const socketPath = getSocketPath()
  const pid = readDaemonPid(socketPath)
  if (pid) {
    console.log(`Daemon already running (pid=${pid})`)
    return
  }
  const daemonScript = resolve(dirname(new URL(import.meta.url).pathname), "tribe-daemon.ts")
  console.log(`Starting tribe daemon in foreground...`)
  console.log(`Socket: ${socketPath}`)
  const child = spawn(process.execPath, [daemonScript, "--socket", socketPath, "--foreground"], {
    stdio: "inherit",
  })
  child.on("exit", (code) => process.exit(code ?? 0))
}

function cmdStop(): void {
  const socketPath = getSocketPath()
  const pid = readDaemonPid(socketPath)
  if (!pid) {
    console.log("No daemon running.")
    return
  }
  console.log(`Stopping daemon (pid=${pid})...`)
  process.kill(pid, "SIGTERM")
  console.log("Sent SIGTERM.")
}

function cmdReload(): void {
  const socketPath = getSocketPath()
  const pid = readDaemonPid(socketPath)
  if (!pid) {
    console.log("No daemon running.")
    return
  }
  console.log(`Sending SIGHUP to daemon (pid=${pid})...`)
  process.kill(pid, "SIGHUP")
  console.log("Sent SIGHUP — daemon will hot-reload.")
}

function cmdWatch(): void {
  const socketPath = getSocketPath()
  const watchScript = resolve(dirname(new URL(import.meta.url).pathname), "tribe-watch.tsx")
  const args = ["--socket", socketPath]
  const child = spawn(process.execPath, [watchScript, ...args], {
    stdio: "inherit",
  })
  child.on("exit", (code) => process.exit(code ?? 0))
}

// --- CLI entry ---

const program = new Command("tribe")
  .description("Tribe CLI — coordination, monitoring, daemon control")
  .version("0.8.1")
  .addHelpSection("Examples:", [
    ["tribe status", "Show active sessions"],
    ["tribe log -f", "Follow live message stream"],
    ["tribe retro --since 2h", "Retro report for last 2 hours"],
    ["tribe watch", "Full TUI dashboard"],
    ['tribe send chief "Ready for work"', "Message the chief"],
  ])

program
  .command("status")
  .description("Show active sessions with uptime and heartbeat")
  .action(() => void cmdStatus())

program
  .command("sessions")
  .description("List sessions")
  .option("-a, --all", "Include dead/pruned sessions")
  .action((opts) => void cmdSessions(!!opts.all))

program
  .command("send")
  .description("Send a message to a session")
  .argument("<to>", "Target session name")
  .argument("<message...>", "Message text")
  .action((to, message) => void cmdSend(to, message.join(" ")))

program
  .command("log")
  .description("Show recent messages")
  .option("-n, --limit <n>", "Number of messages", int, 20)
  .option("-f, --follow", "Follow live — stream new messages")
  .action((opts) => void cmdLog(opts.limit ?? 20, !!opts.follow))

program
  .command("health")
  .description("Run health diagnostics")
  .action(() => void cmdHealth())

program
  .command("retro")
  .description("Generate retrospective report — metrics, timeline, coordination health")
  .option("-s, --since <duration>", "Time window (e.g. 2h, 30m, 1d)")
  .option("-f, --format <fmt>", "Output format: markdown or json", "markdown")
  .option("--db <path>", "Path to tribe.db (default: auto-detect)")
  .action((opts) => cmdRetro({ since: opts.since, format: opts.format ?? "markdown", db: opts.db }))

program
  .command("start")
  .description("Start daemon in foreground")
  .action(() => cmdStart())

program
  .command("stop")
  .description("Stop daemon (SIGTERM)")
  .action(() => cmdStop())

program
  .command("reload")
  .description("Hot-reload daemon code (SIGHUP)")
  .action(() => cmdReload())

program
  .command("watch")
  .description("Live TUI dashboard — sessions + event stream")
  .action(() => cmdWatch())

// ── install / uninstall / doctor — Claude Code setup ────────────────────

program
  .command("install")
  .description("Install tribe hooks in ~/.claude/settings.json and mcpServers.tribe in the project's .mcp.json")
  .option("--dry-run", "Show the plan without writing any files")
  .option("--claude-dir <path>", "Override ~/.claude directory (for testing)")
  .option("--mcp-name <name>", "mcpServers key to use (default: tribe)")
  .action((opts: { dryRun?: boolean; claudeDir?: string; mcpName?: string }) => {
    const env = defaultInstallEnv({
      ...(opts.claudeDir ? { claudeSettingsPath: resolve(opts.claudeDir, "settings.json") } : {}),
      ...(opts.mcpName ? { mcpName: opts.mcpName } : {}),
    })
    const plan = planInstall(env)
    console.log(formatInstallPlan(plan, !!opts.dryRun))
    if (!opts.dryRun) applyInstall(plan)
  })

program
  .command("uninstall")
  .description("Remove tribe hooks and mcpServers.tribe entries")
  .option("--dry-run", "Show the plan without writing any files")
  .option("--claude-dir <path>", "Override ~/.claude directory (for testing)")
  .option("--mcp-name <name>", "mcpServers key to remove (default: tribe)")
  .action((opts: { dryRun?: boolean; claudeDir?: string; mcpName?: string }) => {
    const env = defaultInstallEnv({
      ...(opts.claudeDir ? { claudeSettingsPath: resolve(opts.claudeDir, "settings.json") } : {}),
      ...(opts.mcpName ? { mcpName: opts.mcpName } : {}),
    })
    const plan = planUninstall(env)
    console.log(formatUninstallPlan(plan, !!opts.dryRun))
    if (!opts.dryRun) applyUninstall(plan)
  })

program
  .command("doctor")
  .description("Diagnose the tribe setup — hooks, MCP, daemon, stale sockets")
  .option("--claude-dir <path>", "Override ~/.claude directory (for testing)")
  .option("--mcp-name <name>", "mcpServers key to check (default: tribe)")
  .action((opts: { claudeDir?: string; mcpName?: string }) => {
    const env = defaultInstallEnv({
      ...(opts.claudeDir ? { claudeSettingsPath: resolve(opts.claudeDir, "settings.json") } : {}),
      ...(opts.mcpName ? { mcpName: opts.mcpName } : {}),
    })
    const report = doctorReport(env)
    console.log(formatDoctorReport(report))
    if (report.hasFailures) process.exit(1)
  })

// ── hook — Claude Code hook dispatch ────────────────────────────────────

const hookCmd = program
  .command("hook")
  .description("Dispatch a Claude Code hook event (internal — called by ~/.claude/settings.json)")

hookCmd
  .command("session-start", { hidden: false })
  .description("SessionStart hook — writes sentinel, registers with lore daemon")
  .action(async () => {
    await dispatchHook("session-start")
  })

hookCmd
  .command("prompt", { hidden: false })
  .description("UserPromptSubmit hook — injects delta context")
  .action(async () => {
    await dispatchHook("prompt")
  })

hookCmd
  .command("session-end", { hidden: false })
  .description("SessionEnd hook — spawns background incremental FTS index")
  .action(async () => {
    await dispatchHook("session-end")
  })

hookCmd
  .command("pre-compact", { hidden: false })
  .description("PreCompact hook — checkpoint context before compaction")
  .action(async () => {
    await dispatchHook("pre-compact")
  })

program.parse()
