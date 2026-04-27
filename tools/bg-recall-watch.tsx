#!/usr/bin/env bun
/**
 * bg-recall watch — live TUI dashboard (silvery-rendered).
 *
 * Polls the daemon every second for status + recent decisions. Color-codes
 * relevance scores, surfaces reject reasons, and pages through the recent
 * decision ring. Pause/resume + scrollback.
 *
 * Keys: j/k navigate hints, p pause, r refresh, q/Esc quit.
 */

import React, { useEffect, useState } from "react"
import {
  createTerm,
  render,
  Box,
  Text,
  H1,
  Muted,
  Small,
  Divider,
  useApp,
  useInput,
} from "@silvery/ag-react"
import { createConnection } from "node:net"
import { resolve } from "node:path"
import { createLineParser, makeRequest } from "@bearly/daemon-spine"
import type { DaemonStatus, Decision } from "@bearly/bg-recall"

type RPCCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>

function resolveBgRecallSocket(): string {
  if (process.env.BG_RECALL_SOCKET) return process.env.BG_RECALL_SOCKET
  const xdg = process.env.XDG_RUNTIME_DIR
  return xdg ? resolve(xdg, "bg-recall.sock") : resolve(process.env.HOME ?? "/tmp", ".local/share/bg-recall.sock")
}

/** Open a one-shot socket connection and dispatch a single request. */
function callOnce(socketPath: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise((res, rej) => {
    const sock = createConnection(socketPath)
    let settled = false
    const parse = createLineParser((msg) => {
      const m = msg as { id?: number | string; result?: unknown; error?: { message: string } }
      if (settled) return
      settled = true
      try { sock.end() } catch { /* ignore */ }
      if (m.error) rej(new Error(m.error.message))
      else res(m.result)
    })
    sock.on("data", parse)
    sock.on("error", (err) => {
      if (settled) return
      settled = true
      rej(err)
    })
    sock.once("connect", () => sock.write(makeRequest(1, method, params)))
    setTimeout(() => {
      if (settled) return
      settled = true
      try { sock.destroy() } catch { /* ignore */ }
      rej(new Error(`bg-recall ${method} timed out`))
    }, 3000)
  })
}

async function main(): Promise<void> {
  const sock = resolveBgRecallSocket()
  const call: RPCCall = (method, params) => callOnce(sock, method, params)
  using term = createTerm()
  const handle = render(<Watch call={call} />, term)
  await handle.run()
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})

// ---------------------------------------------------------------------------

function Watch({ call }: { call: RPCCall }): React.JSX.Element {
  const { exit } = useApp()
  const [status, setStatus] = useState<DaemonStatus | null>(null)
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [paused, setPaused] = useState(false)
  const [cursor, setCursor] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stopped = false
    async function tick(): Promise<void> {
      if (stopped || paused) return
      try {
        const s = (await call("status")) as DaemonStatus
        const d = (await call("recent-decisions", { limit: 100 })) as { decisions: Decision[] }
        if (stopped) return
        setStatus(s)
        setDecisions(d.decisions)
        setError(null)
      } catch (err) {
        if (stopped) return
        setError(err instanceof Error ? err.message : String(err))
      }
    }
    void tick()
    const handle = setInterval(() => void tick(), 1000)
    return () => {
      stopped = true
      clearInterval(handle)
    }
  }, [call, paused])

  useInput((input, key) => {
    if (input === "q" || key.escape) exit()
    else if (input === "p") setPaused((v) => !v)
    else if (input === "j") setCursor((c) => Math.min(decisions.length - 1, c + 1))
    else if (input === "k") setCursor((c) => Math.max(0, c - 1))
  })

  if (error && !status) {
    return (
      <Box flexDirection="column" padding={1}>
        <H1>bg-recall watch</H1>
        <Text color="$error">connection error: {error}</Text>
        <Muted>retrying every second…</Muted>
      </Box>
    )
  }

  if (!status) {
    return (
      <Box flexDirection="column" padding={1}>
        <H1>bg-recall watch</H1>
        <Muted>connecting to daemon…</Muted>
      </Box>
    )
  }

  const focused = decisions[cursor]

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <H1>bg-recall watch</H1>
        <Box flexGrow={1} />
        <Muted>
          {paused ? "paused" : "live"} · {status.state} · {decisions.length} decisions
        </Muted>
      </Box>
      <Small>
        sessions={status.sessions.length} · tool-calls={status.totals.toolCalls} · queries={status.totals.queries} ·
        hints={status.totals.hintsFired} · rejected={status.totals.rejected}
      </Small>

      <Divider />

      <Box flexDirection="column">
        {status.sessions.length === 0 ? (
          <Muted>no active sessions</Muted>
        ) : (
          status.sessions.map((s) => (
            <Box key={s.sessionId}>
              <Text>
                {s.sessionName.padEnd(15)} calls={String(s.toolCalls).padStart(4)} hints={String(s.hintsFired).padStart(3)} adopted=
                {s.hintsAdopted}/{s.hintsFired || 0}
              </Text>
            </Box>
          ))
        )}
      </Box>

      <Divider />

      <Text>
        recent decisions {paused ? "(paused)" : ""}
        {error ? <Muted> [last refresh failed: {error}]</Muted> : null}
      </Text>
      <Box flexDirection="column">
        {decisions.slice(0, 12).map((d, i) => {
          const isFocus = i === cursor
          const tag = d.emitted ? "FIRE" : d.rejected?.reason ?? "?"
          // Winner score: emitted hint carries .hit.score (ScoredHit); top
          // candidate carries .score directly. Tag-by-decision-shape keeps tsc happy.
          const score = d.emitted ? d.emitted.hit.score : d.candidates[0]?.score ?? 0
          return (
            <Box key={i}>
              <Text color={isFocus ? "$primary" : undefined}>
                {isFocus ? "▸ " : "  "}
                {fmtTime(d.ts)} {d.trigger.tool.padEnd(8)} {(tag as string).padEnd(15)} score={score.toFixed(2)} {trimText(d.entities.join(","), 50)}
              </Text>
            </Box>
          )
        })}
      </Box>

      <Divider />

      {focused ? (
        <Box flexDirection="column">
          <Text>focused decision</Text>
          <Small>
            ts={fmtTime(focused.ts)} session={focused.sessionId} tool={focused.trigger.tool}
          </Small>
          <Small>entities: {focused.entities.slice(0, 10).join(", ")}</Small>
          <Small>
            queries:{" "}
            {focused.queries.map((q) => `[${q.source} ${q.hits.length}/${q.durationMs}ms]`).join(" ")}
          </Small>
          {focused.emitted ? (
            <Text color="$success">emitted: {trimText(focused.emitted.content, 100)}</Text>
          ) : (
            <Text color="$warning">rejected: {focused.rejected?.reason ?? "unknown"}</Text>
          )}
        </Box>
      ) : null}

      <Divider />
      <Muted>j/k=nav · p=pause · q=quit</Muted>
    </Box>
  )
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function trimText(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + "…"
}
