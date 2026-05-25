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
import { resolveSocketPath, connectToDaemon, probeDaemonPid } from "@bearly/tribe-client/lib/socket"
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
import { watchActivity } from "./lib/tribe/activity-watch.ts"
import {
  HOOK_EVENTS,
  type EnrichmentFields,
  type HookEvent as RouterHookEvent,
  loadListeners,
  runIngest,
  runNotify,
} from "./lib/hooks/index.ts"
import { VALID_AUTOSTART_MODES, type TribeAutostart } from "./lib/tribe/autostart-config.ts"
import { resolveDbPath } from "@bearly/tribe-client/lib/config"

/** Thin wrapper so `retro` uses the same DB resolution as the daemon. */
function resolveDbPathFromCli(): string {
  return resolveDbPath({})
}

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
  /** Wall-clock ms since this session's last inbound request. Drives the
   *  `IDLE` column in `tribe sessions` / `tribe health`. Spec:
   *  `@km/tribe/15588-tribe-list-sessions`. */
  idleMs?: number
  /** Working directory the session registered from. Same value as the
   *  daemon's internal `project` field, surfaced under the `cwd`
   *  alias to match the bead's vocabulary. */
  cwd?: string
  source: "daemon" | "db"
  conn?: string
}

/** Compact a cwd path for table display — strips the user's home prefix and
 *  truncates to a reasonable width. `~/Code/pim/km-wt7` is more scannable
 *  than `/Users/beorn/Code/pim/km-wt7`. */
function fmtCwd(cwd: string | undefined, maxWidth: number = 30): string {
  if (!cwd) return "—"
  const home = process.env.HOME ?? ""
  let display = home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd
  if (display.length > maxWidth) {
    display = "…" + display.slice(display.length - (maxWidth - 1))
  }
  return display
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
  const cwds = sessions.map((r) => fmtCwd(r.cwd))
  const cW = Math.max(3, ...cwds.map((c) => c.length))
  console.log(
    `  ${pad("NAME", nW)}  ${pad("ROLE", rW)}  ${pad("PID", 7)}  ${pad("UPTIME", 10)}  ${pad("IDLE", 8)}  ${pad("CWD", cW)}  SOURCE`,
  )
  for (let i = 0; i < sessions.length; i++) {
    const r = sessions[i]!
    const idle = typeof r.idleMs === "number" ? fmtDur(r.idleMs) : "\u2014"
    console.log(
      `  ${pad(r.name, nW)}  ${pad(r.role, rW)}  ${pad(String(r.pid), 7)}  ${pad(fmtDur(r.uptimeMs), 10)}  ${pad(idle, 8)}  ${pad(cwds[i]!, cW)}  ${r.source}`,
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

const VALID_MESSAGE_TYPES = ["assign", "status", "query", "response", "notify", "request", "verdict"] as const
type MessageType = (typeof VALID_MESSAGE_TYPES)[number]

async function cmdSend(to: string, message: string, type: MessageType = "notify"): Promise<void> {
  await callDaemon("tribe.send", { to, message, type })
  console.log(`Sent message to ${to}`)
}

/**
 * Parse a `tribe pending --stale <duration>` argument (NNs|NNm|NNh) into
 * milliseconds. Returns undefined on unparseable input — the caller exits
 * with an error so the bad arg is loud.
 */
function parseStaleMs(spec: string): number | undefined {
  const match = spec.match(/^(\d+)([smh])$/)
  if (!match) return undefined
  const n = Number(match[1])
  if (!Number.isFinite(n) || n < 0) return undefined
  switch (match[2]) {
    case "s":
      return n * 1000
    case "m":
      return n * 60_000
    case "h":
      return n * 3_600_000
    default:
      return undefined
  }
}

/**
 * Ball-tracker query — list open requests where `owner` is responsible for
 * replying. Wraps the `tribe.pending` MCP tool added in
 * @km/tribe/message-ball-tracker Phase 2a. Used by §C1 chief loop step 0.5
 * (call with `--owner @chief --stale 15m` to surface dropped balls).
 */
async function cmdPending(owner: string | undefined, staleMs: number | undefined): Promise<void> {
  const args: Record<string, unknown> = {}
  if (owner) args.owner = owner
  if (staleMs !== undefined) args.stale_ms = staleMs
  const result = (await callDaemon("tribe.pending", args)) as {
    structuredContent?: {
      owner?: string
      pending?: Array<{
        request_id: string
        sender: string
        opened_at: string
        age_ms: number
        message_id: string
        fanout: string
      }>
      count?: number
    }
  }
  const payload = result.structuredContent
  if (!payload) {
    console.log("No structured result returned.")
    return
  }
  const count = payload.count ?? 0
  const displayOwner = payload.owner ?? owner ?? "(caller)"
  if (count === 0) {
    console.log(`No pending requests for ${displayOwner}.`)
    return
  }
  console.log(`${count} pending request(s) for ${displayOwner}:`)
  for (const p of payload.pending ?? []) {
    const ageSec = Math.floor(p.age_ms / 1000)
    const age = ageSec >= 60 ? `${Math.floor(ageSec / 60)}m` : `${ageSec}s`
    console.log(`  ${p.request_id}  from ${p.sender}  ${age} ago  fanout=${p.fanout}  (msg ${p.message_id})`)
  }
}

/**
 * Inbox status — count + age of actionable DMs the target session hasn't
 * drained via `tribe.fetch` yet. JSON when `--json` is set; otherwise a
 * human-readable summary. Used by `.claude/hooks/chief-drain-check.sh`.
 * Spec: @km/all/silent-errors-enforcement/chief-silent-watchdog-relay-pattern-detection (Layer 2).
 */
async function cmdInboxStatus(opts: { session?: string; json?: boolean }): Promise<void> {
  const session = opts.session ?? "@chief"
  const result = (await callDaemon("cli_inbox_status", { session })) as {
    session: string
    unread_count: number
    oldest_unread_age_min: number
    oldest_unread_ts: number
  }
  if (opts.json) {
    console.log(JSON.stringify(result))
    return
  }
  const n = result.unread_count
  if (n === 0) {
    console.log(`${session}: inbox drained (0 unread actionable DMs).`)
    return
  }
  console.log(
    `${session}: ${n} unread actionable DM${n === 1 ? "" : "s"}, ` + `oldest ${result.oldest_unread_age_min}min ago.`,
  )
}

/**
 * Andon-pull alarm — `tribe alarm <reason>` sets a project-wide stop-the-line
 * flag. The chief-drain-check.sh PreToolUse hook reads it and HARD-BLOCKS
 * chief's tool calls until `tribe alarm-ack` clears it.
 * Spec: @km/all/silent-errors-enforcement/chief-silent-watchdog-relay-pattern-detection (Layer 3).
 */
async function cmdAlarmSet(reason: string, opts: { by?: string }): Promise<void> {
  const by = opts.by ?? process.env.USER ?? "anonymous"
  const result = (await callDaemon("cli_alarm_set", { reason, by })) as { ok: boolean }
  if (!result.ok) {
    console.error("tribe alarm: daemon refused")
    process.exit(1)
  }
  console.log(`ALARM SET — chief tool calls will block until 'tribe alarm-ack' is run.`)
  console.log(`  Reason: ${reason}`)
  console.log(`  By:     ${by}`)
}

async function cmdAlarmStatus(opts: { json?: boolean }): Promise<void> {
  const result = (await callDaemon("cli_alarm_get")) as
    | { active: false }
    | { active: true; reason: string; by: string; ts: number; age_min: number }
  if (opts.json) {
    console.log(JSON.stringify(result))
    return
  }
  if (!result.active) {
    console.log("No alarm active.")
    return
  }
  console.log(`ALARM ACTIVE (${result.age_min}min):`)
  console.log(`  Reason: ${result.reason}`)
  console.log(`  By:     ${result.by}`)
}

async function cmdAlarmAck(): Promise<void> {
  const result = (await callDaemon("cli_alarm_ack")) as { ok: boolean }
  if (!result.ok) {
    console.error("tribe alarm-ack: daemon refused")
    process.exit(1)
  }
  console.log("ALARM CLEARED — chief tool calls unblocked.")
}

async function cmdHealth(): Promise<void> {
  const result = (await callDaemon("cli_health")) as {
    content: Array<{ type: string; text: string }>
    sessions?: Array<{ name: string; role: string; pid: number; cwd?: string; uptimeMs: number; idleMs: number }>
    daemon: { pid: number; uptime: number; clients: number }
  }

  console.log("TRIBE HEALTH DIAGNOSTICS\n")
  // The health response comes from tribe_health handler, which returns MCP-formatted content
  try {
    const text = result.content?.[0]?.text ?? JSON.stringify(result)
    const data = JSON.parse(text) as Record<string, unknown>
    for (const [key, value] of Object.entries(data)) {
      if (key === "issues" && Array.isArray(value)) {
        if ((value as unknown[]).length) {
          console.log("\n  Issues:")
          for (const i of value as string[]) console.log(`    ${i}`)
        } else {
          console.log("  No issues detected.")
        }
      }
    }
    // 15588 — show the live roster section so chief can answer "who is
    // connected / who is idle >15min" with one command. Roster comes from
    // the dispatcher's cli_health response (live `clients` map, not the
    // DB), so it reflects active connections.
    if (Array.isArray(result.sessions) && result.sessions.length > 0) {
      console.log(`\n  Sessions: ${result.sessions.length} active`)
      const nW = Math.max(4, ...result.sessions.map((r) => r.name.length))
      const rW = Math.max(4, ...result.sessions.map((r) => r.role.length))
      const cwds = result.sessions.map((r) => fmtCwd(r.cwd))
      const cW = Math.max(3, ...cwds.map((c) => c.length))
      console.log(
        `    ${pad("NAME", nW)}  ${pad("ROLE", rW)}  ${pad("PID", 7)}  ${pad("UPTIME", 10)}  ${pad("IDLE", 8)}  CWD`,
      )
      for (let i = 0; i < result.sessions.length; i++) {
        const r = result.sessions[i]!
        console.log(
          `    ${pad(r.name, nW)}  ${pad(r.role, rW)}  ${pad(String(r.pid), 7)}  ${pad(fmtDur(r.uptimeMs), 10)}  ${pad(fmtDur(r.idleMs), 8)}  ${cwds[i]}`,
        )
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

function cmdRetro(opts: { since?: string; format: string; db?: string }): void {
  // Use the shared resolver so retro follows the same `--db > TRIBE_DB > XDG
  // > legacy migration` priority as the daemon. Before this fix, retro
  // hardcoded `.beads/tribe.db`, which breaks on fresh installs after the
  // km-tribe.decouple-db-location migration.
  const dbPath = opts.db ?? resolveDbPathFromCli()
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

async function cmdStart(): Promise<void> {
  const socketPath = getSocketPath()
  const pid = await probeDaemonPid(socketPath)
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

async function cmdStop(): Promise<void> {
  const socketPath = getSocketPath()
  const pid = await probeDaemonPid(socketPath)
  if (!pid) {
    console.log("No daemon running.")
    return
  }
  console.log(`Stopping daemon (pid=${pid})...`)
  process.kill(pid, "SIGTERM")
  console.log("Sent SIGTERM.")
}

async function cmdReload(): Promise<void> {
  const socketPath = getSocketPath()
  const pid = await probeDaemonPid(socketPath)
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
  .description("Show active sessions with uptime and last-seen")
  .action(() => void cmdStatus())

program
  .command("sessions")
  .description("List sessions")
  .option("-a, --all", "Include historical (disconnected) sessions")
  .action((opts) => void cmdSessions(!!opts.all))

program
  .command("send")
  .description("Send a message to a session")
  .argument("<to>", "Target session name")
  .argument("<message...>", "Message text")
  .option("-t, --type <type>", `Message type: ${VALID_MESSAGE_TYPES.join("|")} (default: notify)`)
  .action((to, message, opts: { type?: string }) => {
    const type = opts.type ?? "notify"
    if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(type)) {
      console.error(`tribe send: invalid --type '${type}' — expected one of: ${VALID_MESSAGE_TYPES.join(", ")}`)
      process.exit(2)
    }
    void cmdSend(to, message.join(" "), type as MessageType)
  })

program
  .command("pending")
  .description("List open ball-tracker requests for an owner (§C1 chief loop step 0.5)")
  .option("-o, --owner <name>", "Owner session name (default: caller)")
  .option("-s, --stale <duration>", "Only show requests older than this (e.g. 15m, 1h)")
  .action((opts: { owner?: string; stale?: string }) => {
    const stale = opts.stale ? parseStaleMs(opts.stale) : undefined
    if (opts.stale && stale === undefined) {
      console.error(`tribe pending: bad --stale '${opts.stale}' (expected NNs|NNm|NNh)`)
      process.exit(2)
    }
    void cmdPending(opts.owner, stale)
  })

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
  .command("inbox-status")
  .description("Show actionable DMs the target session hasn't drained yet (chief-silent watchdog Layer 2)")
  .option("--session <name>", "Session to inspect (default: @chief)", "@chief")
  .option("--json", "Emit machine-readable JSON (for hooks)")
  .action((opts: { session?: string; json?: boolean }) => void cmdInboxStatus(opts))

program
  .command("alarm <reason>")
  .description("Andon-pull stop-the-line — blocks chief tool calls until 'alarm-ack' (Layer 3)")
  .option("--by <name>", "Set the author of the alarm (default: $USER)")
  .action((reason: string, opts: { by?: string }) => void cmdAlarmSet(reason, opts))

program
  .command("alarm-status")
  .description("Show current andon-pull alarm state (active reason + age, or 'no alarm active')")
  .option("--json", "Emit machine-readable JSON (for hooks)")
  .action((opts: { json?: boolean }) => void cmdAlarmStatus(opts))

program
  .command("alarm-ack")
  .description("Clear the andon-pull alarm — unblocks chief tool calls")
  .action(() => void cmdAlarmAck())

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
  .action(() => void cmdStart())

program
  .command("stop")
  .description("Stop daemon (SIGTERM)")
  .action(() => void cmdStop())

program
  .command("reload")
  .description("Hot-reload daemon code (SIGHUP)")
  .action(() => void cmdReload())

program
  .command("watch")
  .description("Live TUI dashboard — sessions + event stream")
  .action(() => cmdWatch())

program
  .command("activity")
  .description("Tail the unified activity log (tribe DMs + recall injections + gate verdicts)")
  .option("-f, --follow", "Follow live — stream new entries as they land")
  .option("-s, --since <duration>", "Start from now-<duration>, e.g. 1h, 30m, 2d (default: today midnight)")
  .option("--no-color", "Disable ANSI colors (good for piping to jq / grep)")
  .action(async (opts: { follow?: boolean; since?: string; color?: boolean }) => {
    try {
      await watchActivity({
        follow: !!opts.follow,
        since: opts.since,
        noColor: opts.color === false,
      })
    } catch (err) {
      console.error(`tribe activity: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  })

program
  .command("lifecycle")
  .description(
    "Show the latest tool-call-lifecycle snapshot for a session (or all sessions). Diagnostic surface for chief — see @km/infra/15630-stuck-agent-observability § S4.",
  )
  .argument("[session]", "Session name to inspect (e.g. @agent/8). Omit to list every cached snapshot, newest first.")
  .option("--json", "Emit raw JSON (default: pretty-printed)")
  .action(async (session: string | undefined, opts: { json?: boolean }) => {
    const params: Record<string, unknown> = {}
    if (session) params.session = session
    const result = (await callDaemon("tribe.lifecycle", params)) as
      | { session?: string; snapshot?: unknown; snapshots?: unknown[]; error?: string }
      | undefined
    if (!result) {
      console.error("tribe lifecycle: empty response from daemon")
      process.exit(1)
    }
    if (result.error) {
      console.error(`tribe lifecycle: ${result.error}`)
      process.exit(1)
    }
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }
    if (session) {
      if (result.snapshot === null) {
        console.log(`No lifecycle snapshot published for ${session}.`)
        return
      }
      console.log(JSON.stringify(result.snapshot, null, 2))
      return
    }
    const snapshots = Array.isArray(result.snapshots) ? result.snapshots : []
    if (snapshots.length === 0) {
      console.log("No lifecycle snapshots cached. Sessions publish on each tool-call state transition.")
      return
    }
    for (const snap of snapshots) console.log(JSON.stringify(snap, null, 2))
  })

// ── install / uninstall / doctor — Claude Code setup ────────────────────

program
  .command("install")
  .description("Install tribe hooks in ~/.claude/settings.json and mcpServers.tribe in the project's .mcp.json")
  .option("--dry-run", "Show the plan without writing any files")
  .option("--claude-dir <path>", "Override ~/.claude directory (for testing)")
  .option("--mcp-name <name>", "mcpServers key to use (default: tribe)")
  .option("--autostart <mode>", "Daemon autostart mode: daemon | library | never (default: daemon)")
  .action((opts: { dryRun?: boolean; claudeDir?: string; mcpName?: string; autostart?: string }) => {
    let autostart: TribeAutostart | undefined
    if (opts.autostart !== undefined) {
      if (!(VALID_AUTOSTART_MODES as readonly string[]).includes(opts.autostart)) {
        console.error(
          `Invalid --autostart value: ${opts.autostart} (must be one of: ${VALID_AUTOSTART_MODES.join(", ")})`,
        )
        process.exit(2)
      }
      autostart = opts.autostart as TribeAutostart
    }
    const overrides: Parameters<typeof defaultInstallEnv>[0] = {}
    if (opts.claudeDir) {
      overrides.claudeSettingsPath = resolve(opts.claudeDir, "settings.json")
      overrides.autostartConfigPath = resolve(opts.claudeDir, "tribe", "config.json")
    }
    if (opts.mcpName) overrides.mcpName = opts.mcpName
    const env = defaultInstallEnv(overrides)
    const plan = planInstall(env, autostart ? { autostart } : {})
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
    const overrides: Parameters<typeof defaultInstallEnv>[0] = {}
    if (opts.claudeDir) {
      overrides.claudeSettingsPath = resolve(opts.claudeDir, "settings.json")
      overrides.autostartConfigPath = resolve(opts.claudeDir, "tribe", "config.json")
    }
    if (opts.mcpName) overrides.mcpName = opts.mcpName
    const env = defaultInstallEnv(overrides)
    const plan = planUninstall(env)
    console.log(formatUninstallPlan(plan, !!opts.dryRun))
    if (!opts.dryRun) applyUninstall(plan)
  })

program
  .command("doctor")
  .description("Diagnose the tribe setup — hooks, MCP, daemon, stale sockets")
  .option("--claude-dir <path>", "Override ~/.claude directory (for testing)")
  .option("--mcp-name <name>", "mcpServers key to check (default: tribe)")
  .action(async (opts: { claudeDir?: string; mcpName?: string }) => {
    const overrides: Parameters<typeof defaultInstallEnv>[0] = {}
    if (opts.claudeDir) {
      overrides.claudeSettingsPath = resolve(opts.claudeDir, "settings.json")
      overrides.autostartConfigPath = resolve(opts.claudeDir, "tribe", "config.json")
    }
    if (opts.mcpName) overrides.mcpName = opts.mcpName
    const env = defaultInstallEnv(overrides)
    const report = await doctorReport(env)
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

// ── hook ingest / notify — pluggable router for external listeners ───────
//
// These subcommands route Claude Code (and other coding-agent) hook events
// through the loader/router at `tools/lib/hooks/`. Listeners drop into
// `~/.claude/hooks.d/*.ts` and opt into events via filters. `ingest` blocks
// for up to 5s per listener; `notify` is best-effort (100ms, never throws).
// Both exit 0 always — a non-zero exit from a Claude Code hook can block
// the session.

interface PluggableHookOptions {
  event?: string
  source?: string
  activityText?: string
  toolName?: string
  finalMessage?: string
  hookEventName?: string
  notificationType?: string
  metadataBase64?: string
  projectPath?: string
  sessionId?: string
}

function parseEnrichment(opts: PluggableHookOptions): EnrichmentFields {
  const out: EnrichmentFields = {}
  if (opts.activityText) out.activityText = opts.activityText
  if (opts.toolName) out.toolName = opts.toolName
  if (opts.finalMessage) out.finalMessage = opts.finalMessage
  if (opts.hookEventName) out.hookEventName = opts.hookEventName
  if (opts.notificationType) out.notificationType = opts.notificationType
  if (opts.metadataBase64) {
    try {
      out.metadata = JSON.parse(Buffer.from(opts.metadataBase64, "base64").toString("utf8"))
    } catch {
      // Drop invalid metadata silently — hook CLIs must not throw on bad input.
    }
  }
  return out
}

function isValidRouterEvent(event: string): event is RouterHookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(event)
}

function hooksDebug(msg: string): void {
  if (process.env.BEARLY_HOOKS_DEBUG || process.env.KM_HOOKS_DEBUG) {
    process.stderr.write(`[bearly hooks] ${msg}\n`)
  }
}

async function runPluggableHook(mode: "ingest" | "notify", opts: PluggableHookOptions): Promise<void> {
  const event = opts.event ?? ""
  if (!isValidRouterEvent(event)) {
    if (mode === "notify") return // silent drop for best-effort mode
    process.stderr.write(`[bearly hooks] invalid event: ${opts.event ?? "(missing)"}\n`)
    process.stderr.write(`[bearly hooks] valid events: ${HOOK_EVENTS.join(", ")}\n`)
    // Exit 0 anyway — non-zero exit from a Claude Code hook can block the session.
    return
  }
  const source = opts.source ?? "claude"
  const listeners = await loadListeners({ projectPath: opts.projectPath })
  const enrichment = parseEnrichment(opts)
  const run = mode === "ingest" ? runIngest : runNotify
  const result = await run(listeners, event, source, enrichment, {
    sessionId: opts.sessionId,
    projectPath: opts.projectPath,
  })
  hooksDebug(`${mode} ${event} source=${source} listeners=${result.listeners.length} total=${result.totalMs}ms`)
  for (const r of result.listeners) {
    hooksDebug(`  ${r.name}: ${r.status} ${r.durationMs}ms${r.error ? ` error="${r.error}"` : ""}`)
  }
}

function addPluggableHookFlags(cmd: Command): Command {
  return cmd
    .requiredOption("--event <event>", `Event: ${HOOK_EVENTS.join(" | ")}`)
    .option("--source <source>", "Source: claude | codex | gemini | opencode | km | ...", "claude")
    .option("--activity-text <text>", "Short activity summary")
    .option("--tool-name <name>", "Tool name (for tool-related events)")
    .option("--final-message <message>", "Assistant's final message (for stop events)")
    .option("--hook-event-name <name>", "Original agent-side hook event name (e.g. PreToolUse)")
    .option("--notification-type <type>", "Notification subtype (e.g. permission_prompt)")
    .option("--metadata-base64 <b64>", "Base64-encoded JSON metadata payload")
    .option("--project-path <path>", "Project path (for loading project-local listeners)")
    .option("--session-id <id>", "Session identifier")
}

addPluggableHookFlags(
  hookCmd.command("ingest").description("Dispatch a hook event synchronously (5s per-listener timeout)."),
).action(async (opts: PluggableHookOptions) => {
  await runPluggableHook("ingest", opts)
})

addPluggableHookFlags(
  hookCmd
    .command("notify")
    .description("Dispatch a hook event best-effort (100ms per-listener timeout, never throws)."),
).action(async (opts: PluggableHookOptions) => {
  await runPluggableHook("notify", opts)
})

program.parse()
