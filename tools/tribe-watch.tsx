#!/usr/bin/env bun
/**
 * Tribe Watch — Live TUI dashboard for tribe coordination.
 *
 * Layout:
 *   ┌─ Sessions (navigable) ──────────┬─ Session Detail ─────────┐
 *   │  > chief-cwn  chief  1h 15m     │  Name: chief-cwn         │
 *   │    member-1   member 3d 18h     │  Role: chief             │
 *   │    member-2   member 1d 18h     │  PID: 62036              │
 *   │                                 │  Domains: silvery        │
 *   ├─ Events ────────────────────────┴──────────────────────────┤
 *   │  13:40  member-1  [status] Committed abc123...             │
 *   │  13:41  + member-3 joined (member)                         │
 *   ├────────────────────────────────────────────────────────────┤
 *   │  daemon:67261 up:6m clients:3 | q/Esc quit  s:send  r:reload │
 *   └────────────────────────────────────────────────────────────┘
 *
 * Keys: j/k navigate sessions, q/Esc quit, s send message, r reload daemon
 */

import React, { useState, useEffect, useCallback } from "react"
import {
  createTerm, render,
  Box, Text, H1, H2, H3, Muted, Small, Divider,
  SelectList, useInput, useContentRect,
  type SelectOption,
} from "@silvery/ag-react"
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
  claudeSessionId?: string | null
  source?: "daemon" | "db"
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

function SessionDetail({ session }: { session: SessionInfo | null }) {
  if (!session) return <Muted>No session selected</Muted>

  return (
    <Box flexDirection="column" padding={1}>
      <H3>{session.name}</H3>
      <Text><Text bold>Role    </Text>{session.role}</Text>
      <Text><Text bold>PID     </Text>{session.pid || "—"}</Text>
      <Text><Text bold>Uptime  </Text>{fmtDur(session.uptimeMs)}</Text>
      <Text><Text bold>Domains </Text>{session.domains?.length ? session.domains.join(", ") : "—"}</Text>
      <Text><Text bold>Source  </Text>{session.source ?? "unknown"}</Text>
      {session.claudeSessionId && (
        <Text><Text bold>Claude  </Text><Small>{session.claudeSessionId}</Small></Text>
      )}
    </Box>
  )
}

function EventLog({ entries }: { entries: LogEntry[] }) {
  const rect = useContentRect()
  const maxLines = Math.max(3, (rect?.height ?? 12) - 2)
  const visible = entries.slice(-maxLines)

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Text bold>Events</Text>
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

function App({ client, exit }: { client: DaemonClient; exit: () => void }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [daemon, setDaemon] = useState<DaemonInfo | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)

  const addLog = useCallback((entry: LogEntry) => {
    setLog((prev) => [...prev.slice(-200), entry])
  }, [])

  // Exit keys
  useInput((input, key) => {
    if (input === "q" || key.escape) exit()
  })

  // Periodic status refresh
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const status = (await client.call("cli_status")) as {
          sessions: SessionInfo[]
          daemon: DaemonInfo
        }
        setSessions(status.sessions.filter((s) => !s.name.startsWith("watch-")))
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

  const selectedSession = sessions[selectedIdx] ?? null
  const sessionItems: SelectOption[] = sessions.map((s) => ({
    label: `${s.name.padEnd(18)} ${s.role.padEnd(8)} ${fmtDur(s.uptimeMs)}`,
    value: s.name,
  }))

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {/* Header */}
      <Box paddingX={1}>
        <H1>Tribe Watch</H1>
        {daemon && (
          <Box marginLeft={2}>
            <Muted>{daemon.clients} sessions</Muted>
          </Box>
        )}
      </Box>
      <Divider />

      {/* Sessions (navigable) + Detail pane */}
      <Box flexDirection="row" height={Math.min(sessions.length + 4, 12)}>
        <Box width="50%" borderStyle="single" borderColor="$border" flexDirection="column" paddingX={1}>
          <Text bold>{"NAME".padEnd(18)} {"ROLE".padEnd(8)} UPTIME</Text>
          {sessionItems.length > 0 ? (
            <SelectList
              items={sessionItems}
              onSelect={(item) => {
                const idx = sessions.findIndex((s) => s.name === item.value)
                if (idx >= 0) setSelectedIdx(idx)
              }}
              onChange={(item) => {
                const idx = sessions.findIndex((s) => s.name === item.value)
                if (idx >= 0) setSelectedIdx(idx)
              }}
            />
          ) : (
            <Muted>No sessions</Muted>
          )}
        </Box>
        <Box width="50%" borderStyle="single" borderColor="$border">
          <SessionDetail session={selectedSession} />
        </Box>
      </Box>

      {/* Event log */}
      <Box flexGrow={1} borderStyle="single" borderColor="$border">
        <EventLog entries={log} />
      </Box>

      {/* Status bar */}
      <Box paddingX={1}>
        <Small>
          {daemon
            ? `daemon:${daemon.pid} up:${fmtDur(daemon.uptime * 1000)} | j/k:navigate  q/Esc:quit`
            : "connecting..."}
        </Small>
      </Box>
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
