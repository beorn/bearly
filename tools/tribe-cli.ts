#!/usr/bin/env bun
/**
 * Tribe CLI — Inspect and interact with the tribe from the terminal.
 *
 * Usage:
 *   bun tribe status          # Active sessions with uptime and heartbeat
 *   bun tribe send <to> <msg> # Send a message to a session
 *   bun tribe log [--limit N] # Recent messages (default: 20)
 *   bun tribe health          # Diagnostics: stale sessions, unread messages
 *   bun tribe sessions [--all]# List sessions (--all includes dead/pruned)
 *   bun tribe start           # Start daemon in foreground
 *   bun tribe stop            # Stop daemon
 *   bun tribe reload          # Hot-reload daemon (SIGHUP)
 *   bun tribe watch           # Live dashboard (updates pushed from daemon)
 */
import { Database } from "bun:sqlite"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { parseArgs } from "node:util"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"

// --- DB discovery ---

function findTribeDb(): string | null {
  let dir = process.cwd()
  while (dir !== "/") {
    const p = resolve(dir, ".beads/tribe.db")
    if (existsSync(p)) return p
    dir = dirname(dir)
  }
  return null
}

function openDb(writable = false): Database {
  const path = findTribeDb()
  if (!path) {
    console.error("No .beads/tribe.db found (walked up from cwd)")
    process.exit(1)
  }
  const db = writable ? new Database(path) : new Database(path, { readonly: true })
  db.exec(writable ? "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000" : "PRAGMA busy_timeout = 3000")
  return db
}

function hasColumn(db: Database, table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === col)
}

function liveWhere(db: Database): string {
  return hasColumn(db, "sessions", "pruned_at") ? "heartbeat > ? AND pruned_at IS NULL" : "heartbeat > ?"
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

interface Session {
  id: string
  name: string
  role: string
  domains: string
  pid: number
  started_at: number
  heartbeat: number
  pruned_at: number | null
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

function cmdStatus(): void {
  const db = openDb(),
    now = Date.now(),
    t = now - 30_000
  const rows = db
    .prepare(`SELECT * FROM sessions WHERE ${liveWhere(db)} ORDER BY role DESC, started_at ASC`)
    .all(t) as Session[]
  if (!rows.length) {
    console.log("No active tribe sessions.")
    db.close()
    return
  }

  console.log(`TRIBE STATUS \u2014 ${rows.length} session${rows.length !== 1 ? "s" : ""} active\n`)
  const nW = Math.max(4, ...rows.map((r) => r.name.length))
  const rW = Math.max(4, ...rows.map((r) => r.role.length))
  const dW = Math.max(
    7,
    ...rows.map((r) => {
      const d = JSON.parse(r.domains) as string[]
      return (d.length ? d.join(", ") : "\u2014").length
    }),
  )
  console.log(`  ${pad("NAME", nW)}  ${pad("ROLE", rW)}  ${pad("DOMAINS", dW)}  ${pad("UPTIME", 10)}  LAST SEEN`)
  for (const r of rows) {
    const d = JSON.parse(r.domains) as string[]
    console.log(
      `  ${pad(r.name, nW)}  ${pad(r.role, rW)}  ${pad(d.length ? d.join(", ") : "\u2014", dW)}  ${pad(fmtDur(now - r.started_at), 10)}  ${fmtAge(now - r.heartbeat)}`,
    )
  }
  db.close()
}

function cmdSessions(showAll: boolean): void {
  const db = openDb(),
    now = Date.now(),
    t = now - 30_000
  const rows = showAll
    ? (db.prepare("SELECT * FROM sessions ORDER BY heartbeat DESC").all() as Session[])
    : (db
        .prepare(`SELECT * FROM sessions WHERE ${liveWhere(db)} ORDER BY role DESC, started_at ASC`)
        .all(t) as Session[])
  if (!rows.length) {
    console.log(showAll ? "No tribe sessions in database." : "No active tribe sessions.")
    db.close()
    return
  }

  console.log(`TRIBE SESSIONS \u2014 ${rows.length} ${showAll ? "all" : "active"}\n`)
  const nW = Math.max(4, ...rows.map((r) => r.name.length))
  const rW = Math.max(4, ...rows.map((r) => r.role.length))
  console.log(
    `  ${pad("NAME", nW)}  ${pad("ROLE", rW)}  ${pad("PID", 7)}  ${pad("UPTIME", 10)}  ${pad("LAST SEEN", 10)}  STATUS`,
  )
  for (const r of rows) {
    const alive = r.heartbeat > t && r.pruned_at == null
    const st = r.pruned_at != null ? "pruned" : alive ? "alive" : "dead"
    console.log(
      `  ${pad(r.name, nW)}  ${pad(r.role, rW)}  ${pad(String(r.pid), 7)}  ${pad(fmtDur(now - r.started_at), 10)}  ${pad(fmtAge(now - r.heartbeat), 10)}  ${st}`,
    )
  }
  db.close()
}

function cmdLog(limit: number): void {
  const db = openDb()
  const rows = db.prepare("SELECT * FROM messages ORDER BY ts DESC LIMIT ?").all(limit) as Msg[]
  if (!rows.length) {
    console.log("No messages in tribe log.")
    db.close()
    return
  }

  console.log(`TRIBE LOG \u2014 last ${rows.length} message${rows.length !== 1 ? "s" : ""}\n`)
  for (const m of rows.reverse()) {
    const to = m.recipient === "*" ? "all" : m.recipient
    const txt = m.content.length > 120 ? m.content.slice(0, 117) + "..." : m.content
    const bead = m.bead_id ? ` bead=${m.bead_id}` : ""
    console.log(`  ${fmtTime(m.ts)}  ${pad(`${m.sender} \u2192 ${to}`, 28)}  [${m.type}]${bead} "${txt}"`)
  }
  db.close()
}

function cmdSend(to: string, message: string): void {
  const db = openDb(true)
  const session = db.prepare("SELECT name FROM sessions WHERE name = ?").get(to) as { name: string } | null
  if (!session) {
    const all = db.prepare("SELECT name FROM sessions").all() as Array<{ name: string }>
    console.error(`Unknown session: "${to}"`)
    if (all.length) console.error(`Known sessions: ${all.map((r) => r.name).join(", ")}`)
    db.close()
    process.exit(1)
  }
  const id = randomUUID()
  db.prepare(
    "INSERT INTO messages (id, type, sender, recipient, content, bead_id, ref, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, "notify", "cli", to, message, null, null, Date.now())
  console.log(`Sent message to ${to} (id: ${id.slice(0, 8)})`)
  db.close()
}

function cmdHealth(): void {
  const db = openDb(),
    now = Date.now(),
    t = now - 30_000,
    silentT = now - 300_000
  const hasPruned = hasColumn(db, "sessions", "pruned_at")
  const sessions = (
    hasPruned
      ? db.prepare("SELECT * FROM sessions WHERE pruned_at IS NULL").all()
      : db.prepare("SELECT * FROM sessions").all()
  ) as Session[]

  console.log("TRIBE HEALTH DIAGNOSTICS\n")
  const issues: string[] = []
  let aliveN = 0,
    deadN = 0
  for (const s of sessions) {
    const alive = s.heartbeat > t
    alive ? aliveN++ : deadN++
    if (!alive) {
      issues.push(`[DEAD] ${s.name} \u2014 last heartbeat ${fmtAge(now - s.heartbeat)}`)
      continue
    }
    const last = db.prepare("SELECT ts FROM messages WHERE sender = ? ORDER BY ts DESC LIMIT 1").get(s.name) as {
      ts: number
    } | null
    if (last && now - last.ts > silentT)
      issues.push(`[SILENT] ${s.name} \u2014 alive but last message ${fmtAge(now - last.ts)}`)
    else if (!last) issues.push(`[SILENT] ${s.name} \u2014 alive but never sent a message`)
  }
  console.log(`  Sessions: ${aliveN} alive, ${deadN} dead`)

  const unread = db
    .prepare(`
    SELECT m.recipient, COUNT(*) as count FROM messages m
    WHERE m.recipient != '*' AND NOT EXISTS (
      SELECT 1 FROM reads r JOIN sessions s ON r.session_id = s.id
      WHERE r.message_id = m.id AND s.name = m.recipient
    ) GROUP BY m.recipient`)
    .all() as Array<{ recipient: string; count: number }>

  if (unread.length) {
    console.log("\n  Unread messages:")
    for (const u of unread) console.log(`    ${u.recipient}: ${u.count} unread`)
  } else console.log("  Unread messages: none")
  if (issues.length) {
    console.log("\n  Issues:")
    for (const i of issues) console.log(`    ${i}`)
  } else console.log("\n  No issues detected.")
  db.close()
}

// --- Daemon management ---

function findSocketPath(): string {
  // Reuse the same discovery as the daemon
  const beadsDir = findTribeDb()?.replace(/\/tribe\.db$/, "")
  if (beadsDir) return resolve(beadsDir, "tribe.sock")
  return `/tmp/tribe-${process.getuid?.() ?? process.pid}.sock`
}

function findPidPath(): string {
  return findSocketPath().replace(/\.sock$/, ".pid")
}

function readPid(): number | null {
  try {
    const pid = parseInt(readFileSync(findPidPath(), "utf-8").trim(), 10)
    if (isNaN(pid)) return null
    try { process.kill(pid, 0); return pid } catch { return null }
  } catch { return null }
}

function cmdStart(): void {
  const pid = readPid()
  if (pid) {
    console.log(`Daemon already running (pid=${pid})`)
    return
  }
  const daemonScript = resolve(dirname(new URL(import.meta.url).pathname), "tribe-daemon.ts")
  console.log(`Starting tribe daemon in foreground...`)
  console.log(`Socket: ${findSocketPath()}`)
  const child = spawn(process.execPath, [daemonScript, "--socket", findSocketPath(), "--foreground"], {
    stdio: "inherit",
  })
  child.on("exit", (code) => process.exit(code ?? 0))
}

function cmdStop(): void {
  const pid = readPid()
  if (!pid) {
    console.log("No daemon running.")
    return
  }
  console.log(`Stopping daemon (pid=${pid})...`)
  process.kill(pid, "SIGTERM")
  console.log("Sent SIGTERM.")
}

function cmdReload(): void {
  const pid = readPid()
  if (!pid) {
    console.log("No daemon running.")
    return
  }
  console.log(`Sending SIGHUP to daemon (pid=${pid})...`)
  process.kill(pid, "SIGHUP")
  console.log("Sent SIGHUP — daemon will hot-reload.")
}

async function cmdWatch(): Promise<void> {
  const socketPath = findSocketPath()
  let client: import("./lib/tribe/socket.ts").DaemonClient | null = null

  // Try connecting to daemon
  try {
    const { connectToDaemon, connectOrStart } = await import("./lib/tribe/socket.ts")
    client = await connectOrStart(socketPath)
  } catch (err) {
    console.error(`Cannot connect to daemon at ${socketPath}: ${err instanceof Error ? err.message : err}`)
    console.error("Falling back to direct DB polling mode.\n")
  }

  if (client) {
    // Daemon mode: subscribe and stream events
    console.log("TRIBE WATCH — Live dashboard (Ctrl+C to quit)\n")

    // Get initial status
    const status = await client.call("cli_status") as {
      sessions: Array<{ name: string; role: string; domains: string[]; uptimeMs: number }>
      daemon: { uptime: number; clients: number; dbPath: string }
    }
    console.log(`Daemon: pid=${process.pid} uptime=${fmtDur(status.daemon.uptime * 1000)} clients=${status.daemon.clients}`)
    console.log(`Sessions:`)
    for (const s of status.sessions) {
      console.log(`  ${pad(s.name, 20)} ${pad(s.role, 8)} ${fmtDur(s.uptimeMs)}`)
    }
    console.log(`\n--- Live events ---\n`)

    // Subscribe to all notifications
    await client.call("subscribe")

    client.onNotification((method, params) => {
      const ts = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      switch (method) {
        case "channel": {
          const from = params?.from ?? "?"
          const type = params?.type ?? "notify"
          const content = String(params?.content ?? "").slice(0, 120)
          console.log(`${ts}  ${pad(String(from), 16)} [${type}] ${content}`)
          break
        }
        case "session.joined":
          console.log(`${ts}  + ${params?.name} joined (${params?.role ?? "member"})`)
          break
        case "session.left":
          console.log(`${ts}  - ${params?.name} left`)
          break
        case "reload":
          console.log(`${ts}  ↻ reload: ${params?.reason}`)
          break
        default:
          console.log(`${ts}  [${method}] ${JSON.stringify(params)}`)
      }
    })

    // Keep alive
    process.on("SIGINT", () => {
      client?.close()
      process.exit(0)
    })
    await new Promise(() => {}) // Block forever
  } else {
    // Fallback: poll DB directly
    console.log("TRIBE WATCH — Polling mode (no daemon) — Ctrl+C to quit\n")
    let lastTs = Date.now()
    const db = openDb()

    const tick = () => {
      const msgs = db.prepare("SELECT * FROM messages WHERE ts > ? ORDER BY ts ASC").all(lastTs) as Msg[]
      for (const m of msgs) {
        const to = m.recipient === "*" ? "all" : m.recipient
        const txt = m.content.length > 100 ? m.content.slice(0, 97) + "..." : m.content
        console.log(`${fmtTime(m.ts)}  ${pad(`${m.sender} → ${to}`, 28)} [${m.type}] "${txt}"`)
        lastTs = m.ts
      }
    }

    setInterval(tick, 2000)
    tick()
    await new Promise(() => {})
  }
}

// --- CLI entry ---

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    limit: { type: "string", short: "n" },
    all: { type: "boolean", short: "a" },
    help: { type: "boolean", short: "h" },
    offline: { type: "boolean" },
  },
  allowPositionals: true,
  strict: false,
})

const cmd = positionals[0]
if (!cmd || values.help) {
  console.log(`Usage: bun tribe <command> [options]

Commands:
  status            Show active sessions (name, role, domains, uptime, last heartbeat)
  send <to> <msg>   Send a message to a session
  log [--limit N]   Show recent messages (default: 20)
  health            Run health diagnostics (stale sessions, unread messages)
  sessions [--all]  List sessions (--all includes dead/pruned)
  start             Start daemon in foreground (for debugging)
  stop              Stop daemon (SIGTERM)
  reload            Hot-reload daemon (SIGHUP)
  watch             Live dashboard — stream events in real-time

Options:
  -h, --help        Show this help
  -n, --limit N     Limit number of messages (log command)
  -a, --all         Show all sessions including dead (sessions command)
  --offline          Force direct DB access (skip daemon connection)`)
  process.exit(0)
}

switch (cmd) {
  case "status":
    cmdStatus()
    break
  case "send": {
    const to = positionals[1],
      msg = positionals.slice(2).join(" ")
    if (!to || !msg) {
      console.error("Usage: bun tribe send <to> <message>")
      process.exit(1)
    }
    cmdSend(to, msg)
    break
  }
  case "log":
    cmdLog(values.limit ? parseInt(values.limit as string, 10) : 20)
    break
  case "health":
    cmdHealth()
    break
  case "sessions":
    cmdSessions(!!values.all)
    break
  case "start":
    cmdStart()
    break
  case "stop":
    cmdStop()
    break
  case "reload":
    cmdReload()
    break
  case "watch":
    void cmdWatch()
    break
  default:
    console.error(`Unknown command: ${cmd}\nRun with --help to see available commands.`)
    process.exit(1)
}
