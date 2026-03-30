#!/usr/bin/env bun
/**
 * Tribe Watch — Live TUI dashboard for tribe coordination.
 *
 * Keys: j/k navigate sessions, q/Esc quit
 */

import React, { useState, useEffect, useCallback } from "react"
import {
  createTerm, render,
  Box, Text, H1, H3, Muted, Small, Divider,
  SelectList, useApp, useInput,
  type SelectOption,
} from "@silvery/ag-react"
import { resolveSocketPath, connectOrStart, type DaemonClient } from "./lib/tribe/socket.ts"
import { parseArgs } from "node:util"

// ---------------------------------------------------------------------------
// Args & connect
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: { socket: { type: "string" } },
  strict: false,
})

const SOCKET_PATH = resolveSocketPath(values.socket as string | undefined)

let client: DaemonClient
try {
  client = await connectOrStart(SOCKET_PATH)
} catch (err) {
  process.stderr.write(`Failed to connect to daemon: ${err instanceof Error ? err.message : err}\n`)
  process.exit(1)
}

await client.call("register", {
  name: `watch-${process.pid}`,
  role: "member",
  domains: [],
  project: process.cwd(),
  pid: process.pid,
})

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

type DaemonInfo = { pid: number; uptime: number; clients: number }

type LogEntry = {
  ts: string
  text: string
  type: "message" | "join" | "leave" | "reload" | "error"
}

// ---------------------------------------------------------------------------
// Helpers
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

function ts(): string {
  return new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

const EVENT_COLORS: Record<LogEntry["type"], string | undefined> = {
  join: "$success",
  leave: "$warning",
  reload: "$info",
  error: "$error",
  message: undefined,
}

const EVENT_PREFIX: Record<LogEntry["type"], string> = {
  join: "+ ",
  leave: "- ",
  reload: "↻ ",
  error: "",
  message: "",
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Field({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Box width={10}><Text bold>{label}</Text></Box>
      <Text>{value}</Text>
    </Box>
  )
}

function EventEntry({ entry }: { entry: LogEntry }) {
  const color = EVENT_COLORS[entry.type]
  const prefix = EVENT_PREFIX[entry.type]
  return (
    <Text wrap="truncate">
      <Small>{entry.ts} </Small>
      <Text color={color}>{prefix}{entry.text}</Text>
    </Text>
  )
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const { exit } = useApp()
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [daemon, setDaemon] = useState<DaemonInfo | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      client.close()
      exit()
    }
  })

  const addLog = useCallback((entry: LogEntry) => {
    setLog((prev) => [...prev.slice(-200), entry])
  }, [])

  // Periodic status refresh
  useEffect(() => {
    const poll = async () => {
      try {
        const s = (await client.call("cli_status")) as { sessions: SessionInfo[]; daemon: DaemonInfo }
        setSessions(s.sessions.filter((x) => !x.name.startsWith("watch-")))
        setDaemon(s.daemon)
      } catch (err) {
        addLog({ ts: ts(), text: `fetch failed: ${err}`, type: "error" })
      }
    }
    void poll()
    const id = setInterval(() => void poll(), 5000)
    return () => clearInterval(id)
  }, [addLog])

  // Live notifications
  useEffect(() => {
    void client.call("subscribe").catch(() => {})
    client.onNotification((method, params) => {
      const t = ts()
      if (method === "channel") {
        const from = String(params?.from ?? "?")
        const type = String(params?.type ?? "notify")
        const content = String(params?.content ?? "").slice(0, 120)
        addLog({ ts: t, text: `${from}  [${type}] ${content}`, type: "message" })
      } else if (method === "session.joined") {
        addLog({ ts: t, text: `${params?.name} joined (${params?.role ?? "member"})`, type: "join" })
      } else if (method === "session.left") {
        addLog({ ts: t, text: `${params?.name} left`, type: "leave" })
      } else if (method === "reload") {
        addLog({ ts: t, text: `reload: ${params?.reason}`, type: "reload" })
      }
    })
  }, [addLog])

  const selected = sessions[selectedIdx] ?? null
  const items: SelectOption[] = sessions.map((s) => ({
    label: s.name,
    value: s.name,
  }))

  return (
    <Box flexDirection="column" width="100%" height="100%">

      {/* Header */}
      <Box paddingX={1} justifyContent="space-between">
        <Box gap={2} alignItems="center">
          <H1>Tribe Watch</H1>
          {daemon && <Small>daemon:{daemon.pid} up:{fmtDur(daemon.uptime * 1000)} clients:{daemon.clients}</Small>}
        </Box>
        <Box alignItems="center">
          <Small>j/k nav  q quit</Small>
        </Box>
      </Box>
      <Divider />

      {/* Sessions + detail */}
      <Box flexDirection="row">
        <Box flexGrow={3} flexDirection="column" borderStyle="single" borderColor="$border" paddingX={1}>
          <Box>
            <Box width={18}><Text bold>NAME</Text></Box>
            <Box width={10}><Text bold>ROLE</Text></Box>
            <Box width={10}><Text bold>UPTIME</Text></Box>
            <Text bold>SRC</Text>
          </Box>
          {items.length > 0 ? (
            <SelectList
              items={items}
              renderItem={(item) => {
                const s = sessions.find((x) => x.name === item.value)
                if (!s) return <Text>{item.label}</Text>
                return (
                  <Box>
                    <Box width={18}><Text bold={s.role === "chief"} color={s.role === "chief" ? "$primary" : undefined}>{s.name}</Text></Box>
                    <Box width={10}><Muted>{s.role}</Muted></Box>
                    <Box width={10}><Text>{fmtDur(s.uptimeMs)}</Text></Box>
                    <Muted>{s.source === "db" ? "db" : ""}</Muted>
                  </Box>
                )
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
        <Box flexGrow={2} flexDirection="column" borderStyle="single" borderColor="$border" paddingX={1} paddingY={1}>
          {selected ? (
            <>
              <H3>{selected.name}</H3>
              <Field label="Role" value={selected.role} />
              <Field label="PID" value={String(selected.pid || "—")} />
              <Field label="Uptime" value={fmtDur(selected.uptimeMs)} />
              <Field label="Domains" value={selected.domains?.length ? selected.domains.join(", ") : "—"} />
              <Field label="Source" value={selected.source ?? "—"} />
            </>
          ) : (
            <Muted>Select a session</Muted>
          )}
        </Box>
      </Box>

      {/* Event log — overflow=scroll handles height + indicators */}
      <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor="$border" paddingX={1} overflow="scroll">
        <Text bold>Events</Text>
        {log.length > 0
          ? log.map((e, i) => <EventEntry key={i} entry={e} />)
          : <Muted>Waiting for events...</Muted>
        }
      </Box>

    </Box>
  )
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

using term = createTerm()
const { waitUntilExit } = await render(<App />, term)
await waitUntilExit()
client.close()
