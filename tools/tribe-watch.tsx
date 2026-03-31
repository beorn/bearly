#!/usr/bin/env bun
/**
 * Tribe Watch — Live TUI dashboard for tribe coordination.
 *
 * Keys: j/k navigate sessions, q/Esc quit
 */

import React, { useState, useEffect, useCallback } from "react"
import {
  createTerm,
  render,
  Box,
  Text,
  H1,
  Muted,
  Small,
  Divider,
  Table,
  useApp,
  useInput,
  type Column,
} from "@silvery/ag-react"
import {
  resolveSocketPath,
  createReconnectingClient,
  TRIBE_PROTOCOL_VERSION,
  type DaemonClient,
} from "./lib/tribe/socket.ts"
import { resolveProjectName, resolveProjectId } from "./lib/tribe/config.ts"
import { parseArgs } from "node:util"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SessionInfo = {
  id: string
  name: string
  role: string
  domains: string[]
  pid: number
  project?: string
  projectName?: string
  projectId?: string
  peerSocket?: string | null
  uptimeMs: number
  claudeSessionId?: string | null
  source?: "daemon" | "db"
  conn?: string
  resources?: string[]
}

type DaemonInfo = {
  pid: number
  uptime: number
  clients: number
  dbPath: string
  socketPath: string
  resources?: string[]
}

type LogEntry = {
  ts: string
  text: string
  type: "message" | "join" | "leave" | "reload" | "error"
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOME = process.env.HOME ?? ""
const shortPath = (p: string) => (HOME && p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p)

/** Show just the socket filename */
function shortSocket(p: string): string {
  return p.split("/").pop() ?? p
}

const sessionColumns: Column<SessionInfo>[] = [
  { header: "NAME", key: "name" },
  { header: "ROLE", key: "role" },
  { header: "PROJECT", render: (s) => fmtProject(s) },
  { header: "PID", render: (s) => String(s.pid || "") },
  { header: "UP", render: (s) => fmtDur(s.uptimeMs) },
  { header: "CONNECTION", render: (s) => shortSocket(s.peerSocket ?? s.conn ?? "") },
  { header: "RESOURCES", render: (s) => s.resources?.join(",") ?? "", grow: true },
]

function fmtProject(s: SessionInfo): string {
  if (!s.project) return ""
  const id = s.projectId ? `(${s.projectId}) ` : ""
  return `${id}${shortPath(s.project)}`
}

function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const TIME_FMT = { hour: "2-digit", minute: "2-digit", second: "2-digit" } as const
function now(): string {
  return new Date().toLocaleTimeString("en-GB", TIME_FMT)
}
function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", TIME_FMT)
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

function EventEntry({ entry }: { entry: LogEntry }) {
  return (
    <Text>
      <Small>{entry.ts} </Small>
      <Text color={EVENT_COLORS[entry.type]}>
        {EVENT_PREFIX[entry.type]}
        {entry.text}
      </Text>
    </Text>
  )
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

type ConnectionEvent = { ts: string; text: string; type: LogEntry["type"] }
const connectionEvents: ConnectionEvent[] = []

function App({ client, ac }: { client: DaemonClient; ac: AbortController }) {
  const { exit } = useApp()
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [daemon, setDaemon] = useState<DaemonInfo | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])

  useInput((input, key) => {
    if (input === "q" || key.escape || (key.ctrl && input === "c")) {
      ac.abort()
      exit()
    }
  })

  const addLog = useCallback((entry: LogEntry) => {
    setLog((prev) => [...prev.slice(-200), entry])
  }, [])

  // Seed with recent messages from DB
  useEffect(() => {
    void (async () => {
      try {
        const result = (await client.call("cli_log", { limit: 100 })) as {
          messages: Array<{ sender: string; recipient: string; type: string; content: string; ts: number }>
        }
        const seed: LogEntry[] = (result.messages ?? []).map((m) => {
          const t = fmtTime(m.ts)
          const to = m.recipient === "*" ? "all" : m.recipient
          return { ts: t, text: `${m.sender} → ${to} [${m.type}] ${m.content}`, type: "message" as const }
        })
        if (seed.length > 0) setLog(seed)
      } catch {
        /* best effort */
      }
    })()
  }, [])

  // Periodic status refresh + drain connection events
  useEffect(() => {
    const { signal } = ac
    const poll = async () => {
      if (signal.aborted) return
      // Drain any connection events from the reconnecting client
      while (connectionEvents.length > 0) addLog(connectionEvents.shift()!)
      try {
        const s = (await client.call("cli_status")) as { sessions: SessionInfo[]; daemon: DaemonInfo }
        if (signal.aborted) return
        // Inject daemon as a session row
        const daemonSession: SessionInfo = {
          id: "daemon",
          name: "daemon",
          role: "daemon",
          pid: s.daemon.pid,
          projectName: "",
          domains: [],
          uptimeMs: s.daemon.uptime * 1000,
          source: "daemon",
          peerSocket: s.daemon.socketPath,
          resources: s.daemon.resources ?? [],
        }
        const members = s.sessions
          .filter((x) => !x.name.startsWith("watch-"))
          .sort((a, b) => (a.project ?? "").localeCompare(b.project ?? "") || a.name.localeCompare(b.name))
        setSessions([daemonSession, ...members])
        setDaemon(s.daemon)
      } catch (err) {
        if (!signal.aborted)
          addLog({ ts: now(), text: `status fetch failed: ${err instanceof Error ? err.message : err}`, type: "error" })
      }
    }
    void poll()
    const id = setInterval(() => void poll(), 5000)
    signal.addEventListener("abort", () => clearInterval(id))
    return () => clearInterval(id)
  }, [ac, addLog])

  // Live notifications — client is a reconnecting proxy, so this works across reconnects
  useEffect(() => {
    const { signal } = ac
    client.onNotification((method, params) => {
      if (signal.aborted) return
      const t = now()
      if (method === "channel") {
        const from = String(params?.from ?? "?")
        const type = String(params?.type ?? "notify")
        const content = String(params?.content ?? "")
        const logType =
          type === "session" ? (content.includes("left") ? "leave" : "join") : type === "reload" ? "reload" : "message"
        addLog({ ts: t, text: `${from} [${type}] ${content}`, type: logType })
      } else if (method === "session.joined") {
        addLog({ ts: t, text: `+ ${params?.name} joined (${params?.role ?? "member"})`, type: "join" })
      } else if (method === "session.left") {
        addLog({ ts: t, text: `- ${params?.name} left`, type: "leave" })
      } else if (method === "reload") {
        addLog({ ts: t, text: `reload: ${params?.reason}`, type: "reload" })
      }
    })
  }, [ac, addLog])

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {/* Header */}
      <Box justifyContent="space-between">
        <Box gap={2} alignItems="center">
          <H1>Tribe Watch</H1>
        </Box>
        <Box alignItems="center">
          <Small>q quit</Small>
        </Box>
      </Box>

      {/* Sessions table */}
      <Divider />
      {sessions.length > 0 ? <Table data={sessions} columns={sessionColumns} /> : <Muted>No sessions</Muted>}
      <Divider />

      {/* Event log — no border for easy copy */}
      <Box flexDirection="column" flexGrow={1} overflow="scroll">
        <Text bold color="$primary">
          EVENTS
        </Text>
        <Text> </Text>
        {log.length > 0 ? log.map((e, i) => <EventEntry key={i} entry={e} />) : <Muted>Waiting for events...</Muted>}
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: { socket: { type: "string" } },
  strict: false,
})

const SOCKET_PATH = resolveSocketPath(values.socket as string | undefined)
const WATCH_NAME = `watch-${process.pid}`

await using client = Object.assign(
  await createReconnectingClient({
    socketPath: SOCKET_PATH,
    async onConnect(c) {
      await c.call("register", {
        name: WATCH_NAME,
        role: "member",
        domains: [],
        project: process.cwd(),
        projectName: resolveProjectName(),
        projectId: resolveProjectId(),
        protocolVersion: TRIBE_PROTOCOL_VERSION,
        pid: process.pid,
      })
      void c.call("subscribe").catch(() => {})
    },
    onDisconnect() {
      connectionEvents.push({ ts: now(), text: "daemon disconnected, reconnecting...", type: "error" })
    },
    onReconnect() {
      connectionEvents.push({ ts: now(), text: "reconnected to daemon", type: "join" })
    },
  }),
  {
    [Symbol.asyncDispose]: async function (this: DaemonClient) {
      this.close()
    },
  },
)

// No hot-reload for TUI apps — spawn+inherit corrupts terminal.
// Restart watch manually after code changes.

using term = createTerm()
const ac = new AbortController()
const handle = render(<App client={client} ac={ac} />, term, { patchConsole: true })
await handle.run()
ac.abort()
client.close()
client.socket.unref()
