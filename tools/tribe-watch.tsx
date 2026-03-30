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
  SelectList, useApp, useInput, useContentRect,
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

type DaemonInfo = {
  pid: number
  uptime: number
  clients: number
}

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

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const { exit } = useApp()
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [daemon, setDaemon] = useState<DaemonInfo | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const rect = useContentRect()

  // Quit keys
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
        const from = String(params?.from ?? "?").padEnd(14)
        const type = String(params?.type ?? "notify")
        const content = String(params?.content ?? "").slice(0, 120)
        addLog({ ts: t, text: `${from} [${type}] ${content}`, type: "message" })
      } else if (method === "session.joined") {
        addLog({ ts: t, text: `${params?.name} joined (${params?.role ?? "member"})`, type: "join" })
      } else if (method === "session.left") {
        addLog({ ts: t, text: `${params?.name} left`, type: "leave" })
      } else if (method === "reload") {
        addLog({ ts: t, text: `reload: ${params?.reason}`, type: "reload" })
      }
    })
  }, [addLog])

  // Derive
  const selected = sessions[selectedIdx] ?? null
  const items: SelectOption[] = sessions.map((s) => ({
    label: `${s.name.padEnd(16)} ${s.role.padEnd(8)} ${fmtDur(s.uptimeMs).padEnd(8)} ${s.source === "db" ? "db" : ""}`,
    value: s.name,
  }))
  const eventLines = Math.max(4, (rect?.height ?? 24) - sessions.length - 8)
  const visibleLog = log.slice(-eventLines)

  return (
    <Box flexDirection="column" width="100%" height="100%">

      {/* Header bar */}
      <Box paddingX={1} justifyContent="space-between">
        <Box gap={2}>
          <H1>Tribe Watch</H1>
          {daemon && <Small>daemon:{daemon.pid} up:{fmtDur(daemon.uptime * 1000)} clients:{daemon.clients}</Small>}
        </Box>
        <Small>j/k nav  q quit</Small>
      </Box>
      <Divider />

      {/* Sessions + detail side-by-side */}
      <Box flexDirection="row">
        <Box width="55%" flexDirection="column" borderStyle="single" borderColor="$border" paddingX={1}>
          <Text bold color="$accent">{"NAME".padEnd(16)} {"ROLE".padEnd(8)} {"UPTIME".padEnd(8)} SRC</Text>
          {items.length > 0 ? (
            <SelectList
              items={items}
              onChange={(item) => {
                const idx = sessions.findIndex((s) => s.name === item.value)
                if (idx >= 0) setSelectedIdx(idx)
              }}
            />
          ) : (
            <Muted>No sessions</Muted>
          )}
        </Box>
        <Box width="45%" flexDirection="column" borderStyle="single" borderColor="$border" paddingX={1} paddingY={1}>
          {selected ? (
            <>
              <H3>{selected.name}</H3>
              <Text><Text bold>Role     </Text><Text>{selected.role}</Text></Text>
              <Text><Text bold>PID      </Text><Text>{selected.pid || "—"}</Text></Text>
              <Text><Text bold>Uptime   </Text><Text>{fmtDur(selected.uptimeMs)}</Text></Text>
              <Text><Text bold>Domains  </Text><Text>{selected.domains?.length ? selected.domains.join(", ") : "—"}</Text></Text>
              <Text><Text bold>Source   </Text><Text>{selected.source ?? "—"}</Text></Text>
            </>
          ) : (
            <Muted>Select a session</Muted>
          )}
        </Box>
      </Box>

      {/* Event log */}
      <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor="$border" paddingX={1}>
        <Text bold color="$accent">Events</Text>
        {visibleLog.map((e, i) => (
          <Text key={i} wrap="truncate">
            <Small>{e.ts} </Small>
            {e.type === "join" && <Text color="$success">+ {e.text}</Text>}
            {e.type === "leave" && <Text color="$warning">- {e.text}</Text>}
            {e.type === "reload" && <Text color="$accent">↻ {e.text}</Text>}
            {e.type === "error" && <Text color="$error">{e.text}</Text>}
            {e.type === "message" && <Text>{e.text}</Text>}
          </Text>
        ))}
        {visibleLog.length === 0 && <Muted>Waiting for events...</Muted>}
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
