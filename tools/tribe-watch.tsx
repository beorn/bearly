#!/usr/bin/env bun
/**
 * Tribe Watch — Live TUI dashboard for tribe coordination.
 *
 * Connects to the tribe daemon socket and displays:
 * - Session list (name, role, domains, uptime)
 * - Live event log (messages, joins, leaves, reloads)
 * - Daemon status (uptime, clients, DB path)
 *
 * Usage:
 *   bun tribe-watch.tsx                    # Auto-discover daemon
 *   bun tribe-watch.tsx --socket /path     # Explicit socket path
 */

import React, { useState, useEffect, useCallback } from "react"
import { createTerm, render, Box, Text } from "@silvery/ag-react"
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
    <Box flexDirection="column" borderStyle="single" borderColor="$muted" padding={1}>
      <Text $primary bold>Sessions ({sessions.length})</Text>
      <Text $muted>{"  " + "NAME".padEnd(18) + "ROLE".padEnd(10) + "UPTIME"}</Text>
      {sessions.map((s) => (
        <Text key={s.name}>
          {"  "}
          <Text bold={s.role === "chief"} $success={s.role === "chief"}>
            {s.name.padEnd(18)}
          </Text>
          <Text $muted>{s.role.padEnd(10)}</Text>
          <Text>{fmtDur(s.uptimeMs)}</Text>
        </Text>
      ))}
      {sessions.length === 0 && <Text $muted>  No sessions connected</Text>}
    </Box>
  )
}

function EventLog({ entries, maxLines = 20 }: { entries: LogEntry[]; maxLines?: number }) {
  const visible = entries.slice(-maxLines)
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="$muted" padding={1} flexGrow={1}>
      <Text $primary bold>Event Log</Text>
      {visible.map((e, i) => (
        <Text key={i}>
          <Text $muted>{e.ts}  </Text>
          {e.type === "join" && <Text $success>+ {e.text}</Text>}
          {e.type === "leave" && <Text $warning>- {e.text}</Text>}
          {e.type === "reload" && <Text $info>↻ {e.text}</Text>}
          {e.type === "error" && <Text $danger>{e.text}</Text>}
          {e.type === "message" && <Text>{e.text}</Text>}
        </Text>
      ))}
      {visible.length === 0 && <Text $muted>  Waiting for events...</Text>}
    </Box>
  )
}

function StatusBar({ daemon }: { daemon: DaemonInfo | null }) {
  if (!daemon) return <Text $danger>  Connecting to daemon...</Text>
  return (
    <Box paddingX={1}>
      <Text $muted>
        Daemon pid={daemon.pid} uptime={fmtDur(daemon.uptime * 1000)} clients={daemon.clients} | {daemon.socketPath} | Ctrl+C to quit
      </Text>
    </Box>
  )
}

function App({ client }: { client: DaemonClient }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [daemon, setDaemon] = useState<DaemonInfo | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])

  const addLog = useCallback((entry: LogEntry) => {
    setLog((prev) => [...prev.slice(-100), entry])
  }, [])

  // Initial fetch + periodic refresh
  useEffect(() => {
    const fetch = async () => {
      try {
        const status = (await client.call("cli_status")) as {
          sessions: SessionInfo[]
          daemon: DaemonInfo
        }
        setSessions(status.sessions)
        setDaemon(status.daemon)
      } catch (err) {
        addLog({ ts: nowTs(), text: `Status fetch failed: ${err}`, type: "error" })
      }
    }
    void fetch()
    const interval = setInterval(() => void fetch(), 5000)
    return () => clearInterval(interval)
  }, [client, addLog])

  // Subscribe to live notifications
  useEffect(() => {
    void client.call("subscribe").catch(() => {})

    client.onNotification((method, params) => {
      const ts = nowTs()
      switch (method) {
        case "channel": {
          const from = String(params?.from ?? "?")
          const type = String(params?.type ?? "notify")
          const content = String(params?.content ?? "").slice(0, 100)
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
    <Box flexDirection="column" width="100%">
      <Box>
        <Text bold $primary> TRIBE WATCH </Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        <Box width={50}>
          <SessionPanel sessions={sessions} />
        </Box>
        <EventLog entries={log} />
      </Box>
      <StatusBar daemon={daemon} />
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

using term = createTerm()
await render(<App client={client} />, term)
