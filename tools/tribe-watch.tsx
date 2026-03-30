#!/usr/bin/env bun
/**
 * Tribe Watch — Live TUI dashboard for tribe coordination.
 *
 * Connects to the tribe daemon socket and displays:
 * - Session list (name, role, domains, uptime)
 * - Live event log (messages, joins, leaves, reloads)
 * - Daemon status bar
 *
 * Usage:
 *   bun tribe-watch.tsx                    # Auto-discover daemon
 *   bun tribe-watch.tsx --socket /path     # Explicit socket path
 *
 * Keys: q/Esc/Ctrl+C to quit
 */

import React, { useState, useEffect, useCallback } from "react"
import { createTerm, render, Box, Text, H1, H2, Muted, Small, Divider, useInput, useContentRect } from "@silvery/ag-react"
import { resolveSocketPath, connectOrStart, type DaemonClient } from "./lib/tribe/socket.ts"
import { parseArgs } from "node:util"

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: { socket: { type: "string" } },
  strict: false,
})

const SOCKET_PATH = resolveSocketPath(values.socket as string | undefined)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SessionInfo = {
  name: string
  role: string
  domains: string[]
  pid: number
  uptimeMs: number
}

type DaemonInfo = {
  pid: number
  uptime: number
  clients: number
  dbPath: string
  socketPath: string
}

type LogEntry = {
  ts: string
  text: string
  type: "message" | "join" | "leave" | "reload" | "error"
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

function nowTs(): string {
  return new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function SessionPanel({ sessions }: { sessions: SessionInfo[] }) {
  return (
    <Box flexDirection="column" padding={1}>
      <H2>Sessions ({sessions.length})</H2>
      <Muted>{"NAME".padEnd(20) + "ROLE".padEnd(10) + "UPTIME"}</Muted>
      {sessions.filter((s) => !s.name.startsWith("watch-")).map((s) => (
        <Text key={s.name}>
          <Text bold={s.role === "chief"} color={s.role === "chief" ? "$primary" : undefined}>
            {s.name.padEnd(20)}
          </Text>
          <Muted>{s.role.padEnd(10)}</Muted>
          {fmtDur(s.uptimeMs)}
        </Text>
      ))}
      {sessions.filter((s) => !s.name.startsWith("watch-")).length === 0 && (
        <Muted>No sessions connected</Muted>
      )}
    </Box>
  )
}

function EventLog({ entries }: { entries: LogEntry[] }) {
  const rect = useContentRect()
  const maxLines = Math.max(3, (rect?.height ?? 20) - 3)
  const visible = entries.slice(-maxLines)

  return (
    <Box flexDirection="column" padding={1} flexGrow={1}>
      <H2>Events</H2>
      {visible.map((e, i) => (
        <Text key={i} wrap="truncate">
          <Small>{e.ts} </Small>
          {e.type === "join" && <Text color="$success">+ {e.text}</Text>}
          {e.type === "leave" && <Text color="$warning">- {e.text}</Text>}
          {e.type === "reload" && <Text color="$accent">↻ {e.text}</Text>}
          {e.type === "error" && <Text color="$error">{e.text}</Text>}
          {e.type === "message" && <Text>{e.text}</Text>}
        </Text>
      ))}
      {visible.length === 0 && <Muted>Waiting for events...</Muted>}
    </Box>
  )
}

function StatusBar({ daemon, exit }: { daemon: DaemonInfo | null; exit: () => void }) {
  useInput((input, key) => {
    if (input === "q" || key.escape) exit()
  })

  if (!daemon) return <Muted>  Connecting to daemon...</Muted>
  return (
    <Box paddingX={1}>
      <Small>
        daemon:{daemon.pid} up:{fmtDur(daemon.uptime * 1000)} clients:{daemon.clients} | q/Esc to quit
      </Small>
    </Box>
  )
}

function App({ client, exit }: { client: DaemonClient; exit: () => void }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [daemon, setDaemon] = useState<DaemonInfo | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])

  const addLog = useCallback((entry: LogEntry) => {
    setLog((prev) => [...prev.slice(-200), entry])
  }, [])

  // Periodic status refresh
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const status = (await client.call("cli_status")) as {
          sessions: SessionInfo[]
          daemon: DaemonInfo
        }
        setSessions(status.sessions)
        setDaemon(status.daemon)
      } catch (err) {
        addLog({ ts: nowTs(), text: `fetch failed: ${err}`, type: "error" })
      }
    }
    void fetchStatus()
    const interval = setInterval(() => void fetchStatus(), 5000)
    return () => clearInterval(interval)
  }, [client, addLog])

  // Live notification stream
  useEffect(() => {
    void client.call("subscribe").catch(() => {})

    client.onNotification((method, params) => {
      const ts = nowTs()
      switch (method) {
        case "channel": {
          const from = String(params?.from ?? "?")
          const type = String(params?.type ?? "notify")
          const content = String(params?.content ?? "").slice(0, 120)
          addLog({ ts, text: `${from.padEnd(14)} [${type}] ${content}`, type: "message" })
          break
        }
        case "session.joined":
          addLog({ ts, text: `${params?.name} joined (${params?.role ?? "member"})`, type: "join" })
          break
        case "session.left":
          addLog({ ts, text: `${params?.name} left`, type: "leave" })
          break
        case "reload":
          addLog({ ts, text: `reload: ${params?.reason}`, type: "reload" })
          break
      }
    })
  }, [client, addLog])

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Box paddingX={1}>
        <H1>Tribe Watch</H1>
      </Box>
      <Divider />
      <Box flexDirection="row" flexGrow={1}>
        <Box width={44} borderStyle="single" borderColor="$border">
          <SessionPanel sessions={sessions} />
        </Box>
        <Box flexGrow={1} borderStyle="single" borderColor="$border">
          <EventLog entries={log} />
        </Box>
      </Box>
      <Divider />
      <StatusBar daemon={daemon} exit={exit} />
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

process.stderr.write(`[tribe-watch] Connecting to daemon at ${SOCKET_PATH}...\n`)

let client: DaemonClient
try {
  client = await connectOrStart(SOCKET_PATH)
  process.stderr.write(`[tribe-watch] Connected.\n`)
} catch (err) {
  process.stderr.write(`[tribe-watch] Failed: ${err instanceof Error ? err.message : err}\n`)
  process.exit(1)
}

// Register as a watch client (not a real session)
await client.call("register", {
  name: `watch-${process.pid}`,
  role: "member",
  domains: [],
  project: process.cwd(),
  pid: process.pid,
})

using term = createTerm()

function exit() {
  client.close()
  term[Symbol.dispose]()
  process.exit(0)
}

process.on("SIGINT", exit)
process.on("SIGTERM", exit)

await render(<App client={client} exit={exit} />, term)
