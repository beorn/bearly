import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type Server, type Socket } from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { connectToDaemon } from "../src/client.ts"
import { createLineParser } from "../src/parser.ts"
import { isRequest, makeNotification, makeResponse } from "../src/rpc.ts"

/**
 * Spin up a tiny in-memory daemon that echoes calls and pushes notifications.
 * No file paths, no process spawn — just a Unix domain socket server.
 */
function spawnFakeDaemon(socketPath: string): Promise<{ server: Server; clients: Socket[] }> {
  const clients: Socket[] = []
  return new Promise((resolveServer) => {
    const server = createServer((socket) => {
      clients.push(socket)
      const parse = createLineParser((msg) => {
        if (isRequest(msg)) {
          if (msg.method === "echo") {
            socket.write(makeResponse(msg.id, { echoed: msg.params }))
          } else if (msg.method === "ping") {
            socket.write(makeResponse(msg.id, { pong: true }))
            socket.write(makeNotification("pushed", { from: "ping" }))
          } else {
            socket.write(makeResponse(msg.id, null))
          }
        }
      })
      socket.on("data", parse)
      socket.on("error", () => {
        /* ignore */
      })
    })
    server.listen(socketPath, () => resolveServer({ server, clients }))
  })
}

describe("connectToDaemon", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tribe-client-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("connects, sends a request, and resolves with the response result", async () => {
    const sock = join(tmpDir, "d.sock")
    const { server } = await spawnFakeDaemon(sock)
    try {
      const client = await connectToDaemon(sock)
      const result = await client.call("echo", { hello: "world" })
      expect(result).toEqual({ echoed: { hello: "world" } })
      client.close()
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it("delivers server-pushed notifications to the registered handler", async () => {
    const sock = join(tmpDir, "d.sock")
    const { server } = await spawnFakeDaemon(sock)
    try {
      const client = await connectToDaemon(sock)
      const seen: Array<{ method: string; params?: Record<string, unknown> }> = []
      client.onNotification((method, params) => {
        seen.push({ method, params })
      })
      await client.call("ping")
      // Give the server a tick to flush the notification.
      await new Promise<void>((r) => setTimeout(r, 50))
      expect(seen).toHaveLength(1)
      expect(seen[0]!.method).toBe("pushed")
      expect(seen[0]!.params).toEqual({ from: "ping" })
      client.close()
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it("rejects with ENOENT when the socket file does not exist", async () => {
    const missing = join(tmpDir, "nope.sock")
    await expect(connectToDaemon(missing)).rejects.toMatchObject({ code: "ENOENT" })
  })
})
