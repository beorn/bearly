import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createServer, type Server, type Socket } from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createLineParser } from "../src/parser.ts"
import { isRequest, makeNotification, makeResponse } from "../src/rpc.ts"

const ADAPTER = resolve(dirname(fileURLToPath(import.meta.url)), "../src/stdio-adapter.ts")

type FakeDaemon = {
  readonly server: Server
  readonly clients: Socket[]
}

function spawnFakeDaemon(socketPath: string): Promise<FakeDaemon> {
  const clients: Socket[] = []
  return new Promise((resolveServer) => {
    const server = createServer((socket) => {
      clients.push(socket)
      const parse = createLineParser((msg) => {
        if (!isRequest(msg)) return
        if (msg.method === "register") {
          socket.write(makeResponse(msg.id, { sessionId: "daemon-s1", name: "@agent/test", role: "member", chief: "" }))
          return
        }
        if (msg.method === "tribe.members") {
          socket.write(makeResponse(msg.id, { content: [{ type: "text", text: JSON.stringify({ sessions: [] }) }] }))
          return
        }
        socket.write(makeResponse(msg.id, { ok: true }))
      })
      socket.on("data", parse)
      socket.on("error", () => {
        /* ignore test socket teardown */
      })
    })
    server.listen(socketPath, () => resolveServer({ server, clients }))
  })
}

function waitForLine(
  child: ChildProcessWithoutNullStreams,
  predicate: (line: Record<string, unknown>) => boolean,
  opts: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = opts.timeoutMs ?? 2_000
  const seen: string[] = []
  let carry = ""
  return new Promise((resolveLine, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for adapter stdout line; saw: ${seen.join(" | ")}`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off("data", onData)
      child.off("exit", onExit)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(new Error(`adapter exited before expected line: code=${code} signal=${signal}; saw: ${seen.join(" | ")}`))
    }
    const onData = (chunk: Buffer | string) => {
      const lines = (carry + chunk.toString()).split(/\r?\n/u)
      carry = lines.pop() ?? ""
      for (const raw of lines) {
        if (raw.length === 0) continue
        seen.push(raw)
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>
        } catch {
          continue
        }
        if (predicate(parsed)) {
          cleanup()
          resolveLine(parsed)
          return
        }
      }
    }
    child.stdout.on("data", onData)
    child.on("exit", onExit)
  })
}

function collectStdoutJson(child: ChildProcessWithoutNullStreams): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = []
  let carry = ""
  child.stdout.on("data", (chunk: Buffer | string) => {
    const parts = (carry + chunk.toString()).split(/\r?\n/u)
    carry = parts.pop() ?? ""
    for (const raw of parts) {
      if (raw.length === 0) continue
      try {
        lines.push(JSON.parse(raw) as Record<string, unknown>)
      } catch {
        /* ignore non-json test noise */
      }
    }
  })
  return lines
}

function writeJson(child: ChildProcessWithoutNullStreams, payload: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(payload)}\n`)
}

function initializePayload(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "tribe-client-test", version: "0" },
    },
  }
}

function toolsListPayload(id: number): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "tools/list", params: {} }
}

describe("stdio adapter delivery modes", () => {
  let tmpDir: string
  let daemon: FakeDaemon | undefined
  let child: ChildProcessWithoutNullStreams | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-client-stdio-"))
  })

  afterEach(async () => {
    child?.kill("SIGTERM")
    child = undefined
    for (const socket of daemon?.clients ?? []) socket.destroy()
    if (daemon) await new Promise<void>((resolveClose) => daemon!.server.close(() => resolveClose()))
    daemon = undefined
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("pull delivery does not advertise or emit Claude-only channel notifications", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath)
    child = spawn(process.execPath, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "pull",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout = collectStdoutJson(child)

    writeJson(child, initializePayload(1))
    const init = await waitForLine(child, (line) => line.id === 1)
    expect(JSON.stringify(init)).not.toContain("claude/channel")

    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    writeJson(child, toolsListPayload(2))
    await waitForLine(child, (line) => line.id === 2)

    daemon.clients[0]?.write(makeNotification("channel", { from: "chief", type: "request", content: "status?" }))
    await new Promise((resolveTick) => setTimeout(resolveTick, 250))

    expect(stdout.some((line) => line.method === "notifications/claude/channel")).toBe(false)
  })
})
