/**
 * Tribe daemon — integration tests
 *
 * Tests the daemon via Unix socket IPC using the socket client library.
 * Each test spawns a fresh daemon on a temporary socket, connects via
 * connectToDaemon/makeRequest, and verifies JSON-RPC responses.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { existsSync, unlinkSync } from "node:fs"
import { createConnection, type Socket } from "node:net"
import { spawn, type ChildProcess } from "node:child_process"
import { resolve, dirname } from "node:path"
import {
  resolveSocketPath,
  resolvePidPath,
  makeRequest,
  makeResponse,
  makeError,
  makeNotification,
  createLineParser,
  isRequest,
  isResponse,
  isNotification,
  connectToDaemon,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type DaemonClient,
} from "../tools/lib/tribe/socket.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAEMON_SCRIPT = resolve(dirname(new URL(import.meta.url).pathname), "../tools/tribe-daemon.ts")

function tmpSocketPath(): string {
  return `/tmp/tribe-test-${randomUUID().slice(0, 8)}.sock`
}

/** Wait for a condition to become true, polling every `interval` ms */
async function waitFor(fn: () => boolean | Promise<boolean>, timeout = 5000, interval = 50): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`waitFor timed out after ${timeout}ms`)
}

/** Spawn a daemon process on the given socket path, wait for it to be connectable */
async function spawnDaemon(socketPath: string, extraArgs: string[] = []): Promise<ChildProcess> {
  const child = spawn(process.execPath, [DAEMON_SCRIPT, "--socket", socketPath, "--quit-timeout", "2", ...extraArgs], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      // Prevent daemon from picking up project's .beads/ — tests are self-contained
      TRIBE_DB: `/tmp/tribe-test-${randomUUID().slice(0, 8)}.db`,
      // Disable join/leave broadcast suppression window so tests see notifications immediately
      TRIBE_NO_SUPPRESS: "1",
    },
  })

  // Wait for socket to appear (daemon is listening)
  await waitFor(() => existsSync(socketPath), 5000)

  return child
}

// ---------------------------------------------------------------------------
// 1. Socket utilities (pure functions, no daemon needed)
// ---------------------------------------------------------------------------

describe("socket utilities", () => {
  describe("resolveSocketPath", () => {
    it("returns explicit path when provided", () => {
      expect(resolveSocketPath("/tmp/my.sock")).toBe("/tmp/my.sock")
    })

    it("uses TRIBE_SOCKET env var when no arg", () => {
      const original = process.env.TRIBE_SOCKET
      try {
        process.env.TRIBE_SOCKET = "/tmp/env.sock"
        expect(resolveSocketPath()).toBe("/tmp/env.sock")
      } finally {
        if (original !== undefined) process.env.TRIBE_SOCKET = original
        else delete process.env.TRIBE_SOCKET
      }
    })
  })

  describe("resolvePidPath", () => {
    it("puts .pid next to socket", () => {
      expect(resolvePidPath("/tmp/tribe.sock")).toBe("/tmp/tribe.pid")
      expect(resolvePidPath("/var/run/test/daemon.sock")).toBe("/var/run/test/tribe.pid")
    })
  })

  describe("makeRequest / makeResponse / makeError / makeNotification", () => {
    it("makeRequest produces valid JSON-RPC 2.0 with newline", () => {
      const raw = makeRequest(1, "test_method", { foo: "bar" })
      expect(raw.endsWith("\n")).toBe(true)
      const parsed = JSON.parse(raw)
      expect(parsed).toEqual({
        jsonrpc: "2.0",
        id: 1,
        method: "test_method",
        params: { foo: "bar" },
      })
    })

    it("makeRequest works without params", () => {
      const parsed = JSON.parse(makeRequest(42, "no_params")) as JsonRpcRequest
      expect(parsed.params).toBeUndefined()
      expect(parsed.id).toBe(42)
    })

    it("makeResponse produces valid response", () => {
      const parsed = JSON.parse(makeResponse(1, { ok: true }))
      expect(parsed).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } })
    })

    it("makeError produces error response", () => {
      const parsed = JSON.parse(makeError(1, -32601, "Method not found"))
      expect(parsed).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "Method not found" },
      })
    })

    it("makeNotification has no id", () => {
      const parsed = JSON.parse(makeNotification("event.fired", { detail: 1 })) as JsonRpcMessage
      expect(parsed.jsonrpc).toBe("2.0")
      expect((parsed as JsonRpcRequest).method).toBe("event.fired")
      expect((parsed as JsonRpcResponse).id).toBeUndefined()
    })
  })

  describe("type guards", () => {
    it("isRequest identifies requests", () => {
      const req: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "foo" }
      expect(isRequest(req)).toBe(true)
      expect(isResponse(req)).toBe(false)
      expect(isNotification(req)).toBe(false)
    })

    it("isResponse identifies responses", () => {
      const res: JsonRpcMessage = { jsonrpc: "2.0", id: 1, result: {} }
      expect(isRequest(res)).toBe(false)
      expect(isResponse(res)).toBe(true)
      expect(isNotification(res)).toBe(false)
    })

    it("isNotification identifies notifications", () => {
      const notif: JsonRpcMessage = { jsonrpc: "2.0", method: "ping" }
      expect(isRequest(notif)).toBe(false)
      expect(isResponse(notif)).toBe(false)
      expect(isNotification(notif)).toBe(true)
    })
  })

  describe("createLineParser", () => {
    it("parses complete lines", () => {
      const messages: JsonRpcMessage[] = []
      const parse = createLineParser((msg) => messages.push(msg))

      parse(Buffer.from(makeRequest(1, "hello")))
      expect(messages).toHaveLength(1)
      expect((messages[0] as JsonRpcRequest).method).toBe("hello")
    })

    it("handles chunked input across multiple calls", () => {
      const messages: JsonRpcMessage[] = []
      const parse = createLineParser((msg) => messages.push(msg))

      const full = makeRequest(1, "chunked")
      const mid = Math.floor(full.length / 2)

      parse(Buffer.from(full.slice(0, mid)))
      expect(messages).toHaveLength(0) // incomplete line

      parse(Buffer.from(full.slice(mid)))
      expect(messages).toHaveLength(1)
      expect((messages[0] as JsonRpcRequest).method).toBe("chunked")
    })

    it("handles multiple messages in one chunk", () => {
      const messages: JsonRpcMessage[] = []
      const parse = createLineParser((msg) => messages.push(msg))

      const combined = makeRequest(1, "first") + makeRequest(2, "second")
      parse(Buffer.from(combined))
      expect(messages).toHaveLength(2)
      expect((messages[0] as JsonRpcRequest).method).toBe("first")
      expect((messages[1] as JsonRpcRequest).method).toBe("second")
    })

    it("ignores empty lines", () => {
      const messages: JsonRpcMessage[] = []
      const parse = createLineParser((msg) => messages.push(msg))

      parse(Buffer.from("\n\n" + makeRequest(1, "ok") + "\n\n"))
      expect(messages).toHaveLength(1)
    })

    it("handles invalid JSON without crashing", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {})
      const messages: JsonRpcMessage[] = []
      const parse = createLineParser((msg) => messages.push(msg))

      // Invalid JSON followed by valid
      parse(Buffer.from("not json\n" + makeRequest(1, "valid")))
      expect(messages).toHaveLength(1)
      expect((messages[0] as JsonRpcRequest).method).toBe("valid")
    })
  })
})

// ---------------------------------------------------------------------------
// 2-5. Daemon integration tests (spawn real daemon, connect via socket)
// ---------------------------------------------------------------------------

describe("tribe daemon integration", () => {
  let socketPath: string
  let daemon: ChildProcess | null = null
  const clients: DaemonClient[] = []

  beforeEach(() => {
    socketPath = tmpSocketPath()
  })

  afterEach(async () => {
    // Close all client connections
    for (const client of clients) {
      try {
        client.close()
      } catch {
        /* ignore */
      }
    }
    clients.length = 0

    // Kill daemon
    if (daemon && !daemon.killed) {
      daemon.kill("SIGTERM")
      // Wait for exit
      await new Promise<void>((resolve) => {
        if (!daemon || daemon.killed) return resolve()
        daemon.on("exit", () => resolve())
        setTimeout(() => resolve(), 2000)
      })
    }
    daemon = null

    // Clean up socket and related files
    for (const path of [socketPath, resolvePidPath(socketPath)]) {
      if (existsSync(path)) {
        try {
          unlinkSync(path)
        } catch {
          /* ignore */
        }
      }
    }

    // Clean up temp DB files (glob is tricky, so best-effort)
  })

  async function connect(): Promise<DaemonClient> {
    const client = await connectToDaemon(socketPath)
    clients.push(client)
    return client
  }

  // -------------------------------------------------------------------------
  // Daemon lifecycle
  // -------------------------------------------------------------------------

  describe("daemon lifecycle", () => {
    it("starts on a socket and accepts connections", async () => {
      daemon = await spawnDaemon(socketPath)

      const client = await connect()
      expect(client.socket).toBeDefined()
      expect(client.socket.destroyed).toBe(false)
    }, 10_000)

    it("creates a PID file", async () => {
      daemon = await spawnDaemon(socketPath)

      const pidPath = resolvePidPath(socketPath)
      expect(existsSync(pidPath)).toBe(true)
    }, 10_000)

    it("accepts multiple concurrent connections", async () => {
      daemon = await spawnDaemon(socketPath)

      const client1 = await connect()
      const client2 = await connect()
      const client3 = await connect()

      expect(client1.socket.destroyed).toBe(false)
      expect(client2.socket.destroyed).toBe(false)
      expect(client3.socket.destroyed).toBe(false)
    }, 10_000)

    it("auto-quits after all clients disconnect (quit-timeout=1)", async () => {
      const shortTimeoutSocket = tmpSocketPath()
      daemon = await spawnDaemon(shortTimeoutSocket, ["--quit-timeout", "1"])

      const client = await connectToDaemon(shortTimeoutSocket)
      clients.push(client)

      // Register then disconnect
      await client.call("register", { name: "ephemeral", role: "member" })
      client.close()

      // Wait for the daemon to auto-quit (1s timeout + buffer)
      const exited = await new Promise<boolean>((resolve) => {
        if (!daemon) return resolve(true)
        daemon.on("exit", () => resolve(true))
        setTimeout(() => resolve(false), 5000)
      })

      expect(exited).toBe(true)

      // Update socketPath for cleanup
      if (existsSync(shortTimeoutSocket)) {
        try {
          unlinkSync(shortTimeoutSocket)
        } catch {
          /* ignore */
        }
      }
    }, 10_000)

    it("auto-quits when no client ever connects (quit-timeout=1)", async () => {
      // Regression: a daemon spawned by a test that crashes before connecting
      // would live forever because startQuitTimer was only called on disconnect.
      const shortTimeoutSocket = tmpSocketPath()
      daemon = await spawnDaemon(shortTimeoutSocket, ["--quit-timeout", "1"])

      // Deliberately do not connect — daemon should still auto-quit.
      const exited = await new Promise<boolean>((resolve) => {
        if (!daemon) return resolve(true)
        daemon.on("exit", () => resolve(true))
        setTimeout(() => resolve(false), 5000)
      })

      expect(exited).toBe(true)

      if (existsSync(shortTimeoutSocket)) {
        try {
          unlinkSync(shortTimeoutSocket)
        } catch {
          /* ignore */
        }
      }
    }, 10_000)

    it("stays alive while a client remains connected past quit-timeout", async () => {
      // Liveness invariant: an active daemon never auto-quits.
      const sock = tmpSocketPath()
      daemon = await spawnDaemon(sock, ["--quit-timeout", "1"])

      const client = await connectToDaemon(sock)
      clients.push(client)
      await client.call("register", { name: "longterm", role: "member" })

      // Wait 3× the quit-timeout — daemon must still be alive.
      await new Promise((r) => setTimeout(r, 3000))

      expect(daemon.killed).toBe(false)
      expect(daemon.exitCode).toBeNull()
    }, 10_000)

    it("survives connect/disconnect cycles, dies after final disconnect", async () => {
      // Liveness invariant: each new connection cancels the countdown.
      const sock = tmpSocketPath()
      daemon = await spawnDaemon(sock, ["--quit-timeout", "2"])

      for (let i = 0; i < 3; i++) {
        const c = await connectToDaemon(sock)
        await c.call("register", { name: `cycle-${i}`, role: "member" })
        c.close()
        // Half the quit-timeout — countdown is running but hasn't fired
        await new Promise((r) => setTimeout(r, 1000))
        expect(daemon.exitCode).toBeNull()
      }

      // No more clients — daemon dies after the next quit-timeout window
      const exited = await new Promise<boolean>((resolve) => {
        if (!daemon) return resolve(true)
        daemon.on("exit", () => resolve(true))
        setTimeout(() => resolve(false), 5000)
      })
      expect(exited).toBe(true)
    }, 15_000)

    it("returns method-not-found for unknown methods", async () => {
      daemon = await spawnDaemon(socketPath)

      const client = await connect()
      await expect(client.call("nonexistent_method")).rejects.toThrow("Method not found: nonexistent_method")
    }, 10_000)
  })

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  describe("registration", () => {
    it("register returns session info", async () => {
      daemon = await spawnDaemon(socketPath)

      const client = await connect()
      const result = (await client.call("register", {
        name: "test-worker",
        role: "member",
        domains: ["testing"],
      })) as Record<string, unknown>

      expect(result.sessionId).toBeDefined()
      expect(typeof result.sessionId).toBe("string")
      expect(result.name).toBe("test-worker")
      expect(result.role).toBe("member")
      expect(result.daemon).toBeDefined()
      expect((result.daemon as Record<string, unknown>).pid).toBe(daemon!.pid)
    }, 10_000)

    it("register as chief returns chief role", async () => {
      daemon = await spawnDaemon(socketPath)

      const client = await connect()
      const result = (await client.call("register", {
        name: "my-chief",
        role: "chief",
        domains: ["all"],
      })) as Record<string, unknown>

      expect(result.role).toBe("chief")
      expect(result.name).toBe("my-chief")
    }, 10_000)

    it("register generates default name when none provided", async () => {
      daemon = await spawnDaemon(socketPath)

      const client = await connect()
      const result = (await client.call("register", { role: "member" })) as Record<string, unknown>

      // Should get a generated name (project name or member-<pid>)
      expect(typeof result.name).toBe("string")
      expect((result.name as string).length).toBeGreaterThan(0)
    }, 10_000)

    it("second client sees chief reference", async () => {
      daemon = await spawnDaemon(socketPath)

      // Register chief first
      const chief = await connect()
      await chief.call("register", { name: "the-chief", role: "chief" })

      // Register member — should see the chief
      const member = await connect()
      const result = (await member.call("register", {
        name: "worker-1",
        role: "member",
      })) as Record<string, unknown>

      expect(result.chief).toBe("the-chief")
    }, 10_000)

    it("broadcasts session.joined notification to other clients", async () => {
      daemon = await spawnDaemon(socketPath)

      // Register chief and set up notification listener
      const chief = await connect()
      await chief.call("register", { name: "chief", role: "chief" })

      const notifications: Array<{ method: string; params?: Record<string, unknown> }> = []
      chief.onNotification((method, params) => {
        notifications.push({ method, params })
      })

      // Register a member — chief should get a session.joined notification
      const member = await connect()
      await member.call("register", { name: "new-worker", role: "member" })

      // Wait for notification to arrive
      await waitFor(
        () => notifications.some((n) => n.method === "channel" && String(n.params?.type) === "session"),
        3000,
      )

      const joinNotif = notifications.find(
        (n) => n.method === "channel" && String(n.params?.content ?? "").includes("joined"),
      )
      expect(joinNotif).toBeDefined()
      expect(String(joinNotif!.params?.content)).toContain("new-worker")
    }, 10_000)
  })

  // -------------------------------------------------------------------------
  // Tool forwarding (tribe_sessions)
  // -------------------------------------------------------------------------

  describe("tool forwarding", () => {
    it("tribe_sessions returns list of connected sessions", async () => {
      daemon = await spawnDaemon(socketPath)

      const chief = await connect()
      await chief.call("register", { name: "chief", role: "chief" })

      const worker = await connect()
      await worker.call("register", { name: "worker-1", role: "member", domains: ["testing"] })

      // Query sessions from chief's perspective
      const result = (await chief.call("tribe_sessions")) as Record<string, unknown>

      // Result is a tool result with content array
      expect(result.content).toBeDefined()
      const content = (result.content as Array<{ type: string; text: string }>)[0]!.text
      expect(content).toContain("chief")
      expect(content).toContain("worker-1")
    }, 10_000)

    it("tribe_sessions works for unregistered client (uses daemon context)", async () => {
      daemon = await spawnDaemon(socketPath)

      // Connect without registering — should still work via daemon context
      const client = await connect()
      const result = (await client.call("tribe_sessions")) as Record<string, unknown>

      expect(result.content).toBeDefined()
    }, 10_000)
  })

  // -------------------------------------------------------------------------
  // CLI methods
  // -------------------------------------------------------------------------

  describe("CLI methods", () => {
    it("cli_status returns daemon info and connected sessions", async () => {
      daemon = await spawnDaemon(socketPath)

      const client = await connect()
      await client.call("register", { name: "status-test", role: "member" })

      const result = (await client.call("cli_status")) as Record<string, unknown>

      // Check daemon info
      const daemonInfo = result.daemon as Record<string, unknown>
      expect(daemonInfo.pid).toBe(daemon!.pid)
      expect(typeof daemonInfo.uptime).toBe("number")
      expect(daemonInfo.clients).toBeGreaterThanOrEqual(1)
      expect(daemonInfo.socketPath).toBe(socketPath)
      expect(daemonInfo.dbPath).toBeDefined()

      // Check sessions list
      const sessions = result.sessions as Array<Record<string, unknown>>
      expect(sessions.length).toBeGreaterThanOrEqual(1)
      const ourSession = sessions.find((s) => s.name === "status-test")
      expect(ourSession).toBeDefined()
      expect(ourSession!.role).toBe("member")
    }, 10_000)

    it("cli_daemon returns daemon metadata", async () => {
      daemon = await spawnDaemon(socketPath)

      const client = await connect()
      const result = (await client.call("cli_daemon")) as Record<string, unknown>

      expect(result.pid).toBe(daemon!.pid)
      expect(typeof result.uptime).toBe("number")
      expect(result.uptime).toBeGreaterThanOrEqual(0)
      expect(typeof result.clients).toBe("number")
      expect(result.socketPath).toBe(socketPath)
      expect(result.dbPath).toBeDefined()
      expect(typeof result.startedAt).toBe("number")
      expect(result.quitTimeout).toBe(2) // We set --quit-timeout 2
    }, 10_000)

    it("cli_status reflects multiple connected clients", async () => {
      daemon = await spawnDaemon(socketPath)

      const client1 = await connect()
      await client1.call("register", { name: "alpha", role: "chief" })

      const client2 = await connect()
      await client2.call("register", { name: "beta", role: "member" })

      const result = (await client1.call("cli_status")) as Record<string, unknown>
      const sessions = result.sessions as Array<Record<string, unknown>>

      const names = sessions.map((s) => s.name)
      expect(names).toContain("alpha")
      expect(names).toContain("beta")

      const daemonInfo = result.daemon as Record<string, unknown>
      expect(daemonInfo.clients).toBeGreaterThanOrEqual(2)
    }, 10_000)

    it("cli_log returns message history", async () => {
      daemon = await spawnDaemon(socketPath)

      const client = await connect()
      await client.call("register", { name: "log-test", role: "member" })

      const result = (await client.call("cli_log", { limit: 10 })) as Record<string, unknown>

      expect(result.messages).toBeDefined()
      expect(Array.isArray(result.messages)).toBe(true)
    }, 10_000)

    it("subscribe returns acknowledgment", async () => {
      daemon = await spawnDaemon(socketPath)

      const client = await connect()
      const result = (await client.call("subscribe")) as Record<string, unknown>

      expect(result.subscribed).toBe(true)
    }, 10_000)
  })

  // -------------------------------------------------------------------------
  // Disconnect handling
  // -------------------------------------------------------------------------

  describe("disconnect handling", () => {
    it("broadcasts session.left when a registered client disconnects", async () => {
      daemon = await spawnDaemon(socketPath)

      // Register chief
      const chief = await connect()
      await chief.call("register", { name: "watcher", role: "chief" })

      const notifications: Array<{ method: string; params?: Record<string, unknown> }> = []
      chief.onNotification((method, params) => {
        notifications.push({ method, params })
      })

      // Register and then disconnect a member
      const member = await connect()
      await member.call("register", { name: "leaver", role: "member" })

      // Wait for join notification first
      await waitFor(
        () => notifications.some((n) => n.method === "channel" && String(n.params?.content ?? "").includes("joined")),
        3000,
      )

      // Disconnect the member
      member.close()
      // Remove from our tracked clients so afterEach doesn't double-close
      const idx = clients.indexOf(member)
      if (idx !== -1) clients.splice(idx, 1)

      // Wait for leave notification
      await waitFor(
        () => notifications.some((n) => n.method === "channel" && String(n.params?.content ?? "").includes("left")),
        3000,
      )

      const leftNotif = notifications.find(
        (n) => n.method === "channel" && String(n.params?.content ?? "").includes("leaver"),
      )
      expect(leftNotif).toBeDefined()
      expect(String(leftNotif!.params?.content)).toContain("leaver")
    }, 10_000)

    it("cli_status reflects reduced client count after disconnect", async () => {
      daemon = await spawnDaemon(socketPath)

      const client1 = await connect()
      await client1.call("register", { name: "stayer", role: "chief" })

      const client2 = await connect()
      await client2.call("register", { name: "goer", role: "member" })

      // Verify both visible
      let status = (await client1.call("cli_status")) as Record<string, unknown>
      let sessions = status.sessions as Array<Record<string, unknown>>
      expect(sessions.length).toBeGreaterThanOrEqual(2)

      // Disconnect client2
      client2.close()
      const idx = clients.indexOf(client2)
      if (idx !== -1) clients.splice(idx, 1)

      // Give daemon time to process disconnect
      await new Promise((r) => setTimeout(r, 200))

      // Verify only stayer remains
      status = (await client1.call("cli_status")) as Record<string, unknown>
      sessions = status.sessions as Array<Record<string, unknown>>
      const names = sessions.map((s) => s.name)
      expect(names).toContain("stayer")
      expect(names).not.toContain("goer")
    }, 10_000)
  })
})
