import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createServer, type Server, type Socket } from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createLineParser } from "../src/parser.ts"
import { isRequest, makeNotification, makeResponse } from "../src/rpc.ts"
import { MAX_REPLAY_EVENTS } from "../src/lib/replay-cap.ts"

const ADAPTER = resolve(dirname(fileURLToPath(import.meta.url)), "../src/stdio-adapter.ts")
const BUN_BIN = process.versions.bun ? process.execPath : "bun"

type FakeDaemon = {
  readonly server: Server
  readonly clients: Socket[]
  readonly requests: Record<string, unknown>[]
}

function spawnFakeDaemon(
  socketPath: string,
  opts: { fetchEvents?: Array<Record<string, unknown>> } = {},
): Promise<FakeDaemon> {
  const clients: Socket[] = []
  const requests: Record<string, unknown>[] = []
  return new Promise((resolveServer) => {
    const server = createServer((socket) => {
      clients.push(socket)
      const parse = createLineParser((msg) => {
        if (!isRequest(msg)) return
        requests.push(msg as Record<string, unknown>)
        if (msg.method === "register") {
          socket.write(makeResponse(msg.id, { sessionId: "daemon-s1", name: "@agent/test", role: "member", chief: "" }))
          return
        }
        if (msg.method === "tribe.members") {
          socket.write(makeResponse(msg.id, { content: [{ type: "text", text: JSON.stringify({ sessions: [] }) }] }))
          return
        }
        if (msg.method === "tribe.join") {
          socket.write(
            makeResponse(msg.id, {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    joined: true,
                    name: "@agent/test",
                    role: "member",
                    domains: ["silvercode"],
                    delivery: "push",
                  }),
                },
              ],
            }),
          )
          return
        }
        if (msg.method === "tribe.fetch") {
          socket.write(
            makeResponse(msg.id, {
              content: [{ type: "text", text: JSON.stringify({ events: opts.fetchEvents ?? [] }) }],
            }),
          )
          return
        }
        socket.write(makeResponse(msg.id, { ok: true }))
      })
      socket.on("data", parse)
      socket.on("error", () => {
        /* ignore test socket teardown */
      })
    })
    server.listen(socketPath, () => resolveServer({ server, clients, requests }))
  })
}

function waitForLine(
  child: ChildProcessWithoutNullStreams,
  predicate: (line: Record<string, unknown>) => boolean,
  opts: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = opts.timeoutMs ?? 2_000
  const seen: string[] = []
  const stderr: string[] = []
  let carry = ""
  return new Promise((resolveLine, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(
        new Error(`timed out waiting for adapter stdout line; saw: ${seen.join(" | ")}; stderr: ${stderr.join(" | ")}`),
      )
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off("data", onData)
      child.stderr.off("data", onStderr)
      child.off("exit", onExit)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(
        new Error(
          `adapter exited before expected line: code=${code} signal=${signal}; saw: ${seen.join(" | ")}; stderr: ${stderr.join(" | ")}`,
        ),
      )
    }
    const onStderr = (chunk: Buffer | string) => {
      stderr.push(chunk.toString().trim())
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
    child.stderr.on("data", onStderr)
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

function waitForStdout(
  child: ChildProcessWithoutNullStreams,
  lines: Record<string, unknown>[],
  predicate: () => boolean,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 2_000
  return new Promise((resolveWait, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for stdout condition; saw ${lines.length} json line(s)`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off("data", onData)
      child.off("exit", onExit)
    }
    const check = () => {
      if (!predicate()) return
      cleanup()
      resolveWait()
    }
    const onData = () => check()
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(new Error(`adapter exited while waiting for stdout condition: code=${code} signal=${signal}`))
    }
    child.stdout.on("data", onData)
    child.on("exit", onExit)
    check()
  })
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

function callToolPayload(id: number, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }
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
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
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

  it("pull delivery forces tribe.join to pull even when the model requests push", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath)
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "pull",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    writeJson(child, initializePayload(1))
    await waitForLine(child, (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    writeJson(child, toolsListPayload(2))
    await waitForLine(child, (line) => line.id === 2)

    writeJson(child, callToolPayload(3, "join", { name: "@agent/test", delivery: "push" }))
    await waitForLine(child, (line) => line.id === 3)

    const joinRequest = daemon.requests.find((msg) => msg.method === "tribe.join") as
      | { params?: { delivery?: string } }
      | undefined
    expect(joinRequest?.params?.delivery).toBe("pull")
  })

  it("push delivery registers pull and suppresses channel notifications until tribe.join", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath)
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "push",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout = collectStdoutJson(child)

    writeJson(child, initializePayload(1))
    const init = await waitForLine(child, (line) => line.id === 1)
    expect(JSON.stringify(init)).toContain("claude/channel")

    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    writeJson(child, toolsListPayload(2))
    await waitForLine(child, (line) => line.id === 2)

    const register = daemon.requests.find((msg) => msg.method === "register") as
      | { params?: { name?: string; delivery?: string } }
      | undefined
    expect(register?.params?.name).toBeUndefined()
    expect(register?.params?.delivery).toBe("pull")

    daemon.clients[0]?.write(makeNotification("channel", { from: "chief", type: "request", content: "before" }))
    await new Promise((resolveTick) => setTimeout(resolveTick, 250))
    expect(stdout.some((line) => line.method === "notifications/claude/channel")).toBe(false)

    writeJson(child, callToolPayload(3, "join", { name: "@agent/test" }))
    await waitForLine(child, (line) => line.id === 3)
    const joinRequest = daemon.requests.find((msg) => msg.method === "tribe.join") as
      | { params?: { delivery?: string } }
      | undefined
    expect(joinRequest?.params?.delivery).toBe("push")

    daemon.clients[0]?.write(makeNotification("channel", { from: "chief", type: "request", content: "after" }))
    const channel = await waitForLine(child, (line) => line.method === "notifications/claude/channel")
    expect(JSON.stringify(channel)).toContain("after")
  })

  it("bounds a connect-time channel-push burst to the cap (km 19442 push-path backstop)", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    daemon = await spawnFakeDaemon(socketPath)
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "push",
        TRIBE_NO_AUTOSTART: "1",
        // Tiny cap + a wide window so the whole burst lands inside one connect window.
        TRIBE_CHANNEL_REPLAY_MAX: "3",
        TRIBE_CHANNEL_REPLAY_WINDOW_MS: "60000",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout = collectStdoutJson(child)

    writeJson(child, initializePayload(1))
    await waitForLine(child, (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    writeJson(child, toolsListPayload(2))
    await waitForLine(child, (line) => line.id === 2)

    // Join so push-mode channel forwarding is enabled.
    writeJson(child, callToolPayload(3, "join", { name: "@agent/test" }))
    await waitForLine(child, (line) => line.id === 3)

    // Simulate a stale daemon dumping a 12-event message-BODY backlog on connect.
    for (let i = 0; i < 12; i++) {
      daemon.clients[0]?.write(makeNotification("channel", { from: "chief", type: "notify", content: `burst-${i}` }))
    }
    // Wait for the first forwarded burst event, then let the rest settle.
    await waitForLine(
      child,
      (line) => line.method === "notifications/claude/channel" && JSON.stringify(line).includes("burst-"),
    )
    await new Promise((resolveTick) => setTimeout(resolveTick, 400))

    const forwarded = stdout.filter(
      (line) => line.method === "notifications/claude/channel" && JSON.stringify(line).includes("burst-"),
    )
    // Cap=3 → exactly 3 of the 12 surface; the other 9 are dropped (still durable in
    // the daemon journal, fetchable via tribe.fetch). Without the gate, all 12 flood in.
    expect(forwarded.length).toBe(3)
  })

  it("bounds wakeup drain replay to recent capped events", async () => {
    const socketPath = join(tmpDir, "tribe.sock")
    const now = Date.now()
    const oldTs = new Date(now - 25 * 60 * 60 * 1000).toISOString()
    const recentTs = new Date(now - 1_000).toISOString()
    const fetchEvents = [
      { id: "old", type: "request", from: "chief", content: "old-stale", ts: oldTs },
      ...Array.from({ length: MAX_REPLAY_EVENTS + 5 }, (_, i) => ({
        id: `fresh-${i}`,
        type: "request",
        from: "chief",
        content: `fresh-${i}`,
        ts: recentTs,
      })),
    ]
    daemon = await spawnFakeDaemon(socketPath, { fetchEvents })
    child = spawn(BUN_BIN, [ADAPTER, "--socket", socketPath, "--name", "@agent/test"], {
      cwd: tmpDir,
      env: {
        ...process.env,
        TRIBE_DELIVERY: "push",
        TRIBE_NO_AUTOSTART: "1",
        DEBUG_LOG: join(tmpDir, "adapter.log"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout = collectStdoutJson(child)

    writeJson(child, initializePayload(1))
    await waitForLine(child, (line) => line.id === 1)
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    writeJson(child, callToolPayload(2, "join", { name: "@agent/test" }))
    await waitForLine(child, (line) => line.id === 2)

    daemon.clients[0]?.write(makeNotification("wakeup", {}))

    await waitForStdout(
      child,
      stdout,
      () => stdout.filter((line) => line.method === "notifications/claude/channel").length === MAX_REPLAY_EVENTS,
    )

    const channels = stdout.filter((line) => line.method === "notifications/claude/channel")
    const payloads = channels.map((line) => JSON.stringify(line))
    expect(payloads.some((payload) => payload.includes("old-stale"))).toBe(false)
    expect(payloads.some((payload) => payload.includes("fresh-0"))).toBe(true)
    expect(payloads.some((payload) => payload.includes(`fresh-${MAX_REPLAY_EVENTS - 1}`))).toBe(true)
    expect(payloads.some((payload) => payload.includes(`fresh-${MAX_REPLAY_EVENTS}`))).toBe(false)

    const fetchRequest = daemon.requests.find((msg) => msg.method === "tribe.fetch") as
      | { params?: { limit?: number } }
      | undefined
    expect(fetchRequest?.params?.limit).toBe(500)
  })
})
