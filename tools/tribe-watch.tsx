#!/usr/bin/env bun
/**
 * Tribe Watch — Live TUI dashboard for tribe coordination.
 *
 * Keys: j/k navigate sessions, q/Esc quit
 */

import React, { useState, useEffect, useCallback, useRef } from "react"
import {
  createTerm, render,
  Box, Text, H1, H3, Muted, Small, Divider,
  SelectList, useApp, useInput,
  type SelectOption,
} from "@silvery/ag-react"
import { resolveSocketPath, connectOrStart, type DaemonClient } from "./lib/tribe/socket.ts"
import { parseArgs } from "node:util"

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

function now(): string {
  return new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

const EVENT_COLORS: Record<LogEntry["type"], string | undefined> = {
  join: "$success", leave: "$warning", reload: "$info", error: "$error", message: undefined,
}
const EVENT_PREFIX: Record<LogEntry["type"], string> = {
  join: "+ ", leave: "- ", reload: "↻ ", error: "", message: "",
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
  return (
    <Text wrap="truncate">
      <Small>{entry.ts} </Small>
      <Text color={EVENT_COLORS[entry.type]}>{EVENT_PREFIX[entry.type]}{entry.text}</Text>
    </Text>
  )
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App({ client, ac }: { client: DaemonClient; ac: AbortController }) {
  const { exit } = useApp()
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [daemon, setDaemon] = useState<DaemonInfo | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      ac.abort()
      exit()
    }
  })

  const addLog = useCallback((entry: LogEntry) => {
    setLog((prev) => [...prev.slice(-200), entry])
  }, [])

  // Periodic status refresh — abort signal cancels interval
  useEffect(() => {
    const { signal } = ac
    const poll = async () => {
      if (signal.aborted) return
      try {
        const s = (await client.call("cli_status")) as { sessions: SessionInfo[]; daemon: DaemonInfo }
        if (signal.aborted) return
        setSessions(s.sessions.filter((x) => !x.name.startsWith("watch-")))
        setDaemon(s.daemon)
      } catch {
        if (!signal.aborted) addLog({ ts: now(), text: "status fetch failed", type: "error" })
      }
    }
    void poll()
    const id = setInterval(() => void poll(), 5000)
    signal.addEventListener("abort", () => clearInterval(id))
    return () => clearInterval(id)
  }, [client, ac, addLog])

  // Live notifications
  useEffect(() => {
    const { signal } = ac
    void client.call("subscribe").catch(() => {})
    const handler = (method: string, params?: Record<string, unknown>) => {
      if (signal.aborted) return
      const t = now()
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
    }
    client.onNotification(handler)
  }, [client, ac, addLog])

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
          <Text bold>{"NAME".padEnd(16)} {"ROLE".padEnd(8)} {"UPTIME".padEnd(8)} SRC</Text>
          {items.length > 0 ? (
            <SelectList
              items={items}
              renderItem={(item) => {
                const s = sessions.find((x) => x.name === item.value)
                if (!s) return <Text>{item.label}</Text>
                return (
                  <Text>
                    <Text bold={s.role === "chief"} color={s.role === "chief" ? "$primary" : undefined}>{s.name.padEnd(16)}</Text>
                    {" "}<Muted>{s.role.padEnd(8)}</Muted>
                    {" "}{fmtDur(s.uptimeMs).padEnd(8)}
                    <Muted>{s.source === "db" ? " db" : ""}</Muted>
                  </Text>
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

      {/* Event log */}
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
// Run — async disposable lifecycle
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: { socket: { type: "string" } },
  strict: false,
})

const SOCKET_PATH = resolveSocketPath(values.socket as string | undefined)

await using client = Object.assign(await connectOrStart(SOCKET_PATH), {
  [Symbol.asyncDispose]: async function(this: DaemonClient) { this.close() },
})

await client.call("register", {
  name: `watch-${process.pid}`,
  role: "member",
  domains: [],
  project: process.cwd(),
  pid: process.pid,
})

using term = createTerm()
const ac = new AbortController()
const { waitUntilExit } = await render(<App client={client} ac={ac} />, term)
await waitUntilExit()
ac.abort() // Signal all intervals/handlers to stop
