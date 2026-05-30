/**
 * Tribe MCP round-trip smoke tests.
 *
 * This is the post-consolidation boundary test: every host should talk to the
 * same bearly daemon through the same MCP adapter, not through host-specific
 * backends. The test boots a real daemon, spawns real bundled stdio MCP
 * adapters (`plugins/tribe/server.ts`), and also calls the daemon-native MCP
 * methods over the Unix socket. Both surfaces must see the same members and
 * message journal.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, realpathSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Database } from "bun:sqlite"
import { resolveProjectId } from "@bearly/tribe-client/lib/config"
import { connectToDaemon, type DaemonClient } from "@bearly/tribe-client/lib/socket"

const BEARLY_ROOT = fileURLToPath(new URL("..", import.meta.url))
const DAEMON_SCRIPT = resolve(BEARLY_ROOT, "tools/tribe-daemon.ts")
const MCP_SERVER = resolve(BEARLY_ROOT, "plugins/tribe/server.ts")

type ToolResult = { content?: Array<{ type: string; text: string }>; isError?: boolean }

function parseToolText<T = Record<string, unknown>>(result: unknown): T {
  const text = (result as ToolResult).content?.[0]?.text
  if (typeof text !== "string") throw new Error(`Tool response missing text: ${JSON.stringify(result)}`)
  return JSON.parse(text) as T
}

async function waitFor(fn: () => boolean | Promise<boolean>, timeout = 8000, interval = 50): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await fn()) return
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(`waitFor timed out after ${timeout}ms`)
}

function killProcess(proc: ChildProcess | null, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (!proc || proc.exitCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL")
      } catch {
        /* ignore */
      }
      resolve()
    }, 3000)
    proc.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
    try {
      proc.kill(signal)
    } catch {
      clearTimeout(timer)
      resolve()
    }
  })
}

function spawnDaemon(socketPath: string, dbPath: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    // @km/agent/15071 — bumped off `-1` to clean up daemons after test crashes.
    [DAEMON_SCRIPT, "--socket", socketPath, "--db", dbPath, "--quit-timeout", "120"],
    {
      cwd: BEARLY_ROOT,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        TRIBE_DB: dbPath,
        TRIBE_NO_PLUGINS: "1",
        TRIBE_NO_SUPPRESS: "1",
        TRIBE_ACTIVITY_LOG: "off",
      },
    },
  )
  return waitFor(() => existsSync(socketPath), 8000).then(() => child)
}

type JsonRpcResponse = {
  jsonrpc: "2.0"
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

function createStdioMcpClient(opts: {
  name: string
  socketPath: string
  cwd: string
  logPath: string
  delivery?: "push" | "pull"
}): {
  readonly proc: ChildProcess
  readonly stderr: () => string
  request(method: string, params?: Record<string, unknown>): Promise<unknown>
  callTool<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>
  listTools(): Promise<Array<{ name: string }>>
  close(): Promise<void>
} {
  const proc = spawn(process.execPath, [MCP_SERVER], {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      DEBUG: "tribe:*,tribe-client:*",
      DEBUG_LOG: opts.logPath,
      TRIBE_SOCKET: opts.socketPath,
      TRIBE_NAME: opts.name,
      TRIBE_ROLE: "member",
      TRIBE_DOMAINS: "roundtrip,test",
      TRIBE_DELIVERY: opts.delivery ?? "pull",
      TRIBE_ACTIVITY_LOG: "off",
    },
  })

  let nextId = 1
  let stdoutBuffer = ""
  let stderr = ""
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()

  proc.stdout.setEncoding("utf8")
  proc.stderr.setEncoding("utf8")
  proc.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk
    while (true) {
      const index = stdoutBuffer.indexOf("\n")
      if (index === -1) break
      const line = stdoutBuffer.slice(0, index).trim()
      stdoutBuffer = stdoutBuffer.slice(index + 1)
      if (!line) continue
      const msg = JSON.parse(line) as JsonRpcResponse | { jsonrpc: "2.0"; method: string; params?: unknown }
      if (!("id" in msg)) continue
      const waiter = pending.get(msg.id)
      if (!waiter) continue
      pending.delete(msg.id)
      clearTimeout(waiter.timer)
      if (msg.error) waiter.reject(new Error(msg.error.message))
      else waiter.resolve(msg.result)
    }
  })
  proc.stderr.on("data", (chunk: string) => {
    stderr += chunk
  })
  proc.on("exit", () => {
    for (const [id, waiter] of pending) {
      pending.delete(id)
      clearTimeout(waiter.timer)
      waiter.reject(new Error(`MCP server exited before response ${id}: ${stderr}`))
    }
  })

  function request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = nextId++
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`MCP request timed out (${method}); stderr=${stderr}`))
      }, 8000)
      pending.set(id, { resolve, reject, timer })
      proc.stdin.write(payload)
    })
  }

  return {
    proc,
    stderr: () => stderr,
    request,
    async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      return (await request("tools/call", { name, arguments: args })) as T
    },
    async listTools(): Promise<Array<{ name: string }>> {
      const result = (await request("tools/list")) as { tools: Array<{ name: string }> }
      return result.tools
    },
    async close(): Promise<void> {
      for (const [id, waiter] of pending) {
        pending.delete(id)
        clearTimeout(waiter.timer)
        waiter.reject(new Error(`MCP client closed before response ${id}`))
      }
      await killProcess(proc)
    },
  }
}

describe("tribe MCP round-trip against one daemon protocol", () => {
  let tmp: string
  let socketPath: string
  let dbPath: string
  let daemon: ChildProcess | null = null
  let raw: DaemonClient | null = null
  const mcpClients: Array<ReturnType<typeof createStdioMcpClient>> = []

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tribe-mcp-roundtrip-"))
    socketPath = join(tmp, "tribe.sock")
    dbPath = join(tmp, "tribe.db")
  })

  afterEach(async () => {
    for (const client of mcpClients.splice(0)) await client.close()
    try {
      raw?.close()
    } catch {
      /* ignore */
    }
    raw = null
    await killProcess(daemon)
    daemon = null
    if (existsSync(socketPath)) unlinkSync(socketPath)
    rmSync(tmp, { recursive: true, force: true })
  })

  it("round-trips messages between stdio MCP adapters and daemon-native MCP", async () => {
    daemon = await spawnDaemon(socketPath, dbPath)
    const projectCwd = mkdtempSync(join(tmp, "project-"))
    const projectRealpath = realpathSync(projectCwd)
    raw = await connectToDaemon(socketPath)
    await raw.call("register", {
      name: "raw-mcp",
      role: "member",
      project: projectRealpath,
      projectId: resolveProjectId(projectCwd),
      delivery: "pull",
    })

    const alice = createStdioMcpClient({
      name: "adapter-alice",
      socketPath,
      cwd: projectCwd,
      logPath: join(tmp, "alice-mcp.log"),
      delivery: "pull",
    })
    const bob = createStdioMcpClient({
      name: "adapter-bob",
      socketPath,
      cwd: projectCwd,
      logPath: join(tmp, "bob-mcp.log"),
      delivery: "pull",
    })
    mcpClients.push(alice, bob)

    await Promise.all([
      alice.request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      }),
      bob.request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      }),
    ])
    await Promise.all([
      alice.callTool("join", { name: "adapter-alice", domains: ["roundtrip", "test"] }),
      bob.callTool("join", { name: "adapter-bob", domains: ["roundtrip", "test"] }),
    ])

    const adapterTools = (await alice.listTools()).map((tool) => tool.name)
    expect(adapterTools).toContain("send")
    expect(adapterTools).toContain("fetch")
    expect(adapterTools).toContain("members")
    expect(adapterTools).not.toContain("tribe_send")
    expect(adapterTools).not.toContain("tribe.broadcast")

    const daemonMcpTools = ((await raw.call("tools/list")) as { tools: Array<{ name: string }> }).tools.map(
      (tool) => tool.name,
    )
    expect(daemonMcpTools).toContain("tribe.send")
    expect(daemonMcpTools).toContain("tribe.fetch")
    expect(daemonMcpTools).not.toContain("tribe.broadcast")

    let lastMembers: unknown = null
    await waitFor(async () => {
      const members = parseToolText<{ sessions: Array<{ name: string; cwd: string; domains: string[] }> }>(
        await alice.callTool("members", {}),
      )
      lastMembers = members
      const names = members.sessions.map((session) => session.name)
      const bobSession = members.sessions.find((session) => session.name === "adapter-bob")
      return names.includes("raw-mcp") && names.includes("adapter-alice") && bobSession?.cwd === projectRealpath
    }).catch((err) => {
      throw new Error(`${err instanceof Error ? err.message : String(err)}; lastMembers=${JSON.stringify(lastMembers)}`)
    })

    await bob.callTool("fetch", { limit: 100 })

    const fromAdapter = `adapter broadcast ${randomUUID()}`
    await alice.callTool("send", { to: "*", message: fromAdapter, type: "status" })
    await waitFor(async () => {
      const fetched = parseToolText<{ events: Array<{ from: string; to: string; content: string }> }>(
        await bob.callTool("fetch", { limit: 100, advance: false }),
      )
      return fetched.events.some(
        (event) => event.from === "adapter-alice" && event.to === "*" && event.content === fromAdapter,
      )
    })

    const fromDaemonNativeMcp = `daemon-native mcp broadcast ${randomUUID()}`
    await raw.call("tools/call", {
      name: "tribe.send",
      arguments: { to: "*", message: fromDaemonNativeMcp, type: "status" },
    })
    await waitFor(async () => {
      const fetched = parseToolText<{ events: Array<{ from: string; to: string; content: string }> }>(
        await bob.callTool("fetch", { limit: 100, advance: false }),
      )
      return fetched.events.some(
        (event) => event.from === "raw-mcp" && event.to === "*" && event.content === fromDaemonNativeMcp,
      )
    })

    expect(alice.stderr()).toBe("")
    expect(bob.stderr()).toBe("")
  }, 30_000)

  it("persists the DM body row in the daemon journal when the recipient is connected", async () => {
    // Regression: km-tribe DM-body-drop. The stdio adapter used to have a
    // peer-direct fast path (`trySendDirect` → `sendDirect` → recipient's peer
    // socket) that delivered a DM socket-to-socket and only logged an
    // `event.message.sent` audit pointer to the daemon — the actual body row
    // was NEVER written to `messages`. A recipient that read the log later
    // (pull / reconnect) saw nothing. Broadcasts persisted; DMs to a connected
    // peer did not. The fix removes the peer-direct path so every send routes
    // through the daemon, which both persists the row AND fans it out.
    //
    // Invariant: after one connected adapter sends a DM to another connected
    // adapter, the daemon's `messages` table has a `kind='direct'` row
    // carrying the full body addressed to the recipient.
    daemon = await spawnDaemon(socketPath, dbPath)
    const projectCwd = mkdtempSync(join(tmp, "project-"))

    const alice = createStdioMcpClient({
      name: "dm-alice",
      socketPath,
      cwd: projectCwd,
      logPath: join(tmp, "dm-alice-mcp.log"),
      delivery: "pull",
    })
    const bob = createStdioMcpClient({
      name: "dm-bob",
      socketPath,
      cwd: projectCwd,
      logPath: join(tmp, "dm-bob-mcp.log"),
      delivery: "pull",
    })
    mcpClients.push(alice, bob)

    await Promise.all([
      alice.request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      }),
      bob.request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      }),
    ])
    await Promise.all([alice.callTool("join", { name: "dm-alice" }), bob.callTool("join", { name: "dm-bob" })])

    // Wait until both adapters are registered and mutually visible — this is
    // the exact condition under which the old peer-direct path would have
    // engaged (recipient connected with an advertised peer socket).
    await waitFor(async () => {
      const members = parseToolText<{ sessions: Array<{ name: string }> }>(await alice.callTool("members", {}))
      const names = members.sessions.map((s) => s.name)
      return names.includes("dm-alice") && names.includes("dm-bob")
    })

    const dmBody = `dm-body-must-persist ${randomUUID()}`
    const sendResult = parseToolText<{ sent?: boolean }>(
      await alice.callTool("send", { to: "dm-bob", message: dmBody, type: "query" }),
    )
    expect(sendResult.sent).toBe(true)

    // The body row must be in the durable journal — query SQLite directly.
    await waitFor(() => {
      const db = new Database(dbPath, { readonly: true })
      try {
        const row = db
          .prepare("SELECT id FROM messages WHERE kind = 'direct' AND recipient = ? AND content = ?")
          .get("dm-bob", dmBody)
        return row !== null
      } finally {
        db.close()
      }
    }, 8000)

    // Assert the full shape of the persisted row.
    const db = new Database(dbPath, { readonly: true })
    try {
      const row = db
        .prepare("SELECT kind, type, sender, recipient, content FROM messages WHERE content = ?")
        .get(dmBody) as { kind: string; type: string; sender: string; recipient: string; content: string } | null
      expect(row, "DM body row missing from daemon journal").not.toBeNull()
      expect(row!.kind).toBe("direct")
      expect(row!.sender).toBe("dm-alice")
      expect(row!.recipient).toBe("dm-bob")
      expect(row!.content).toBe(dmBody)
    } finally {
      db.close()
    }

    // And it is pull-readable by the recipient via tribe.fetch.
    await waitFor(async () => {
      const fetched = parseToolText<{ events: Array<{ from: string; content: string }> }>(
        await bob.callTool("fetch", { limit: 100, advance: false }),
      )
      return fetched.events.some((e) => e.from === "dm-alice" && e.content === dmBody)
    }, 8000)

    expect(alice.stderr()).toBe("")
    expect(bob.stderr()).toBe("")
  }, 30_000)
})
