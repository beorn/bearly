import { afterEach, describe, expect, it } from "vitest"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { connectToDaemon, type DaemonClient } from "@bearly/tribe-client/lib/socket"

const BEARLY_ROOT = fileURLToPath(new URL("..", import.meta.url))
const DAEMON_SCRIPT = resolve(BEARLY_ROOT, "tools/tribe-daemon.ts")
const BUN_BIN = process.versions.bun ? process.execPath : "bun"

type ToolResult = { content?: Array<{ type: string; text: string }> }

function parseToolText<T>(result: unknown): T {
  const text = (result as ToolResult).content?.[0]?.text
  if (typeof text !== "string") throw new Error(`Tool response missing text: ${JSON.stringify(result)}`)
  return JSON.parse(text) as T
}

async function waitFor(fn: () => boolean | Promise<boolean>, timeout = 5000, interval = 50): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await fn()) return
    await new Promise((resolveWait) => setTimeout(resolveWait, interval))
  }
  throw new Error(`waitFor timed out after ${timeout}ms`)
}

function killProcess(proc: ChildProcess | null, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (!proc || proc.exitCode !== null) return Promise.resolve()
  return new Promise((resolveKill) => {
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL")
      } catch {
        /* ignore */
      }
      resolveKill()
    }, 3000)
    proc.once("exit", () => {
      clearTimeout(timer)
      resolveKill()
    })
    try {
      proc.kill(signal)
    } catch {
      clearTimeout(timer)
      resolveKill()
    }
  })
}

async function spawnDaemon(socketPath: string, dbPath: string): Promise<ChildProcess> {
  let stderr = ""
  // @km/agent/15071 — bumped off `-1` to clean up daemons after test crashes.
  const child = spawn(BUN_BIN, [DAEMON_SCRIPT, "--socket", socketPath, "--db", dbPath, "--quit-timeout", "120"], {
    cwd: BEARLY_ROOT,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      TRIBE_DB: dbPath,
      TRIBE_NO_PLUGINS: "1",
      TRIBE_NO_SUPPRESS: "1",
      TRIBE_ACTIVITY_LOG: "off",
    },
  })
  child.stderr?.on("data", (chunk: string | Buffer) => {
    stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8")
  })
  child.once("exit", (code, signal) => {
    if (!existsSync(socketPath)) {
      stderr += `\ndaemon exited before socket appeared (code=${code}, signal=${signal})`
    }
  })
  await waitFor(() => existsSync(socketPath), 8000).catch((err) => {
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${stderr}`)
  })
  return child
}

describe("tribe channel bus", () => {
  const cleanupPaths: string[] = []
  let daemon: ChildProcess | null = null
  const clients: DaemonClient[] = []

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      try {
        client.close()
      } catch {
        /* ignore */
      }
    }
    await killProcess(daemon)
    daemon = null
    for (const path of cleanupPaths.splice(0)) {
      if (path.endsWith(".sock") && existsSync(path)) {
        try {
          unlinkSync(path)
        } catch {
          /* ignore */
        }
        continue
      }
      rmSync(path, { recursive: true, force: true })
    }
  })

  it("resets adopted session delivery offsets to the log tail", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tribe-channel-bus-"))
    cleanupPaths.push(tmp)
    const socketPath = join(tmp, "tribe.sock")
    const dbPath = join(tmp, "tribe.db")
    daemon = await spawnDaemon(socketPath, dbPath)

    const project = join(tmp, "project")
    const receiverPid = 424_242

    const firstReceiver = await connectToDaemon(socketPath)
    clients.push(firstReceiver)
    await firstReceiver.call("register", {
      name: "receiver",
      role: "member",
      project,
      pid: receiverPid,
      delivery: "push",
    })
    firstReceiver.close()
    clients.pop()

    const sender = await connectToDaemon(socketPath)
    clients.push(sender)
    await sender.call("register", { name: "sender", role: "chief", project: join(tmp, "sender"), delivery: "push" })
    await sender.call("tribe.send", { to: "receiver", message: "stale-before-reconnect", type: "notify" })

    const adoptedReceiver = await connectToDaemon(socketPath)
    clients.push(adoptedReceiver)
    await adoptedReceiver.call("register", {
      role: "member",
      project,
      pid: receiverPid,
      delivery: "push",
    })

    const afterAdoption = parseToolText<{ events: Array<{ content: string }> }>(
      await adoptedReceiver.call("tribe.fetch", { limit: 50, advance: false }),
    )
    expect(afterAdoption.events.map((event) => event.content)).not.toContain("stale-before-reconnect")

    await sender.call("tribe.send", { to: "receiver", message: "fresh-after-reconnect", type: "notify" })
    await waitFor(async () => {
      const fetched = parseToolText<{ events: Array<{ content: string }> }>(
        await adoptedReceiver.call("tribe.fetch", { limit: 50, advance: false }),
      )
      return fetched.events.some((event) => event.content === "fresh-after-reconnect")
    })
  }, 15_000)

  it("pushes wakeups while message content stays in the fetch log", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tribe-channel-bus-wakeup-"))
    cleanupPaths.push(tmp)
    const socketPath = join(tmp, "tribe.sock")
    const dbPath = join(tmp, "tribe.db")
    daemon = await spawnDaemon(socketPath, dbPath)

    const project = join(tmp, "project")
    const receiver = await connectToDaemon(socketPath)
    clients.push(receiver)
    const notifications: Array<{ method: string; params?: Record<string, unknown> }> = []
    receiver.onNotification((method, params) => notifications.push({ method, params }))
    await receiver.call("register", { name: "receiver", role: "member", project, delivery: "push" })

    const sender = await connectToDaemon(socketPath)
    clients.push(sender)
    await sender.call("register", { name: "sender", role: "chief", project: join(tmp, "sender"), delivery: "push" })
    await sender.call("tribe.send", { to: "receiver", message: "fetch-me-after-wakeup", type: "notify" })

    await waitFor(() => notifications.some((note) => note.method === "wakeup"))
    expect(notifications.map((note) => note.method)).not.toContain("channel")
    const wakeup = notifications.find((note) => note.method === "wakeup")!
    expect(wakeup.params).toMatchObject({ count: 1 })
    expect(wakeup.params).not.toHaveProperty("content")

    const fetched = parseToolText<{ events: Array<{ content: string }> }>(
      await receiver.call("tribe.fetch", { limit: 50 }),
    )
    expect(fetched.events.map((event) => event.content)).toContain("fetch-me-after-wakeup")
  }, 15_000)

  it("delivers direct messages to pull-only MCP clients via fetch", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tribe-channel-bus-pull-"))
    cleanupPaths.push(tmp)
    const socketPath = join(tmp, "tribe.sock")
    const dbPath = join(tmp, "tribe.db")
    daemon = await spawnDaemon(socketPath, dbPath)

    const receiver = await connectToDaemon(socketPath)
    clients.push(receiver)
    const notifications: Array<{ method: string; params?: Record<string, unknown> }> = []
    receiver.onNotification((method, params) => notifications.push({ method, params }))
    await receiver.call("register", {
      name: "codex-mcp",
      role: "member",
      project: join(tmp, "receiver"),
      delivery: "pull",
    })

    const sender = await connectToDaemon(socketPath)
    clients.push(sender)
    await sender.call("register", { name: "chief", role: "chief", project: join(tmp, "sender"), delivery: "push" })
    await sender.call("tribe.send", { to: "codex-mcp", message: "pull-mode-dm", type: "notify" })

    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    expect(notifications).toEqual([])
    const fetched = parseToolText<{ events: Array<{ content: string; from: string }> }>(
      await receiver.call("tribe.fetch", { limit: 50 }),
    )
    expect(fetched.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: "pull-mode-dm", from: "chief" })]),
    )
  }, 15_000)

  it("resets the inbox-pull cursor to tail when a pull-only MCP client reconnects", async () => {
    // Codex-style: a delivery="pull" client (no wakeup) reconnects via the
    // (pid, cwd) adoption path. The adopted row carries a stale
    // last_inbox_pull_seq; without a reset the reconnected session would
    // re-deliver week-old DMs (or, if the seq ran ahead, silently skip new
    // ones). tribe.fetch keys off last_inbox_pull_seq, so a clean fetch that
    // omits the pre-reconnect DM proves both offset columns were reset.
    const tmp = mkdtempSync(join(tmpdir(), "tribe-channel-bus-pull-adopt-"))
    cleanupPaths.push(tmp)
    const socketPath = join(tmp, "tribe.sock")
    const dbPath = join(tmp, "tribe.db")
    daemon = await spawnDaemon(socketPath, dbPath)

    const project = join(tmp, "codex-project")
    const codexPid = 515_151

    const firstCodex = await connectToDaemon(socketPath)
    clients.push(firstCodex)
    await firstCodex.call("register", {
      name: "codex-mcp",
      role: "member",
      project,
      pid: codexPid,
      delivery: "pull",
    })
    firstCodex.close()
    clients.pop()

    const chief = await connectToDaemon(socketPath)
    clients.push(chief)
    await chief.call("register", { name: "chief", role: "chief", project: join(tmp, "chief"), delivery: "push" })
    await chief.call("tribe.send", { to: "codex-mcp", message: "stale-dm-before-reconnect", type: "notify" })

    const adoptedCodex = await connectToDaemon(socketPath)
    clients.push(adoptedCodex)
    await adoptedCodex.call("register", {
      role: "member",
      project,
      pid: codexPid,
      delivery: "pull",
    })

    const afterAdoption = parseToolText<{ events: Array<{ content: string }> }>(
      await adoptedCodex.call("tribe.fetch", { limit: 50 }),
    )
    expect(afterAdoption.events.map((event) => event.content)).not.toContain("stale-dm-before-reconnect")

    await chief.call("tribe.send", { to: "codex-mcp", message: "fresh-dm-after-reconnect", type: "notify" })
    await waitFor(async () => {
      const fetched = parseToolText<{ events: Array<{ content: string }> }>(
        await adoptedCodex.call("tribe.fetch", { limit: 50 }),
      )
      return fetched.events.some((event) => event.content === "fresh-dm-after-reconnect")
    })
  }, 15_000)

  it("archives expired messages before trimming the hot log", () => {
    const tmp = mkdtempSync(join(tmpdir(), "tribe-channel-bus-archive-"))
    cleanupPaths.push(tmp)
    const dbPath = join(tmp, "tribe.db")
    const script = `
      import { openDatabase, createStatements } from "./tools/lib/tribe/database.ts"
      import { createTribeContext } from "./tools/lib/tribe/context.ts"
      import { cleanupOldData } from "./tools/lib/tribe/session.ts"

      const db = openDatabase(${JSON.stringify(dbPath)})
      const stmts = createStatements(db)
      const ctx = createTribeContext({
        db,
        stmts,
        sessionId: "daemon",
        sessionRole: "daemon",
        initialName: "daemon",
        domains: [],
        claudeSessionId: null,
        claudeSessionName: null,
      })

      const oldTs = Date.now() - 8 * 24 * 60 * 60 * 1000
      const freshTs = Date.now()
      stmts.insertMessage.run({
        $id: "old-message",
        $type: "notify",
        $sender: "alice",
        $recipient: "bob",
        $kind: "direct",
        $content: "archived content",
        $bead_id: null,
        $ref: null,
        $ts: oldTs,
        $delivery: "push",
        $topic: null,
        $room_id: null,
      })
      stmts.insertMessage.run({
        $id: "fresh-message",
        $type: "notify",
        $sender: "alice",
        $recipient: "bob",
        $kind: "direct",
        $content: "hot content",
        $bead_id: null,
        $ref: null,
        $ts: freshTs,
        $delivery: "push",
        $topic: null,
        $room_id: null,
      })

      cleanupOldData(ctx)

      const hotRows = db.prepare("SELECT id FROM messages ORDER BY id").all()
      const archivedRows = db.prepare("SELECT id, content FROM messages_archive ORDER BY id").all()
      db.close()
      console.log(JSON.stringify({ hotRows, archivedRows }))
    `
    const result = spawnSync(BUN_BIN, ["--eval", script], {
      cwd: BEARLY_ROOT,
      encoding: "utf8",
      env: { ...process.env, TRIBE_ACTIVITY_LOG: "off" },
    })
    expect(result.status, result.stderr).toBe(0)
    const jsonLine = result.stdout
      .trim()
      .split("\n")
      .findLast((line) => line.trim().startsWith("{"))
    if (!jsonLine)
      throw new Error(`child script produced no JSON\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    const parsed = JSON.parse(jsonLine) as {
      hotRows: Array<{ id: string }>
      archivedRows: Array<{ id: string; content: string }>
    }
    expect(parsed.hotRows).toEqual([{ id: "fresh-message" }])
    expect(parsed.archivedRows).toEqual([{ id: "old-message", content: "archived content" }])
  })
})
