/**
 * withMCPServer — native MCP-spec surface on the tribe daemon.
 *
 * Exercises `initialize`, `tools/list`, and `tools/call` directly through the
 * dispatcher's `handleRequest` path (no proxy in the loop). The tests assert
 * the daemon natively answers MCP frames over its Unix socket interface, so a
 * future MCP-over-Unix-socket client can connect without going through the
 * stdio adapter.
 */

import { describe, expect, it, afterEach } from "vitest"
import { existsSync, unlinkSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { createScope, pipe, withTool, withTools, type Tool } from "../packages/tribe-client/src/index.ts"
import {
  createBaseTribe,
  messagingTools,
  withBroadcast,
  withClientRegistry,
  withConfig,
  withDaemonContext,
  withDatabase,
  withDispatcher,
  withIdleQuit,
  withLore,
  withMCPServer,
  withProjectRoot,
  withSocketServer,
} from "../tools/lib/tribe/compose/index.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cleanupPaths: string[] = []
function tmpDb(): string {
  const path = `/tmp/tribe-mcp-test-${randomUUID().slice(0, 8)}.db`
  cleanupPaths.push(path)
  return path
}
function tmpSock(): string {
  const path = `/tmp/tribe-mcp-test-${randomUUID().slice(0, 8)}.sock`
  cleanupPaths.push(path)
  return path
}

afterEach(() => {
  for (const p of cleanupPaths.splice(0)) {
    try {
      if (existsSync(p)) unlinkSync(p)
    } catch {
      /* ignore */
    }
  }
})

function bootShape() {
  return pipe(
    createBaseTribe({ scope: createScope("test"), daemonVersion: "9.9.9" }),
    withConfig({
      override: {
        socketPath: tmpSock(),
        dbPath: tmpDb(),
        loreDbPath: tmpDb(),
        quitTimeoutSec: -1,
        inheritFd: null,
        focusPollMs: 1000,
        summaryPollMs: 2000,
        summarizerMode: "off" as const,
        loreEnabled: false,
      },
    }),
    withProjectRoot("/test"),
    withDatabase(),
    withDaemonContext(),
    withLore(),
    withTools(),
    withTool(messagingTools()),
    withClientRegistry(),
    withBroadcast(),
  )
}

function withRpcStack() {
  const partial = bootShape()
  const sock = withSocketServer<typeof partial>()(partial)
  const idle = withIdleQuit<typeof sock>({ triggerShutdown: () => {} })(sock)
  return withDispatcher<typeof idle>({})(idle)
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number | string
  result?: unknown
  error?: { code: number; message: string }
}

async function callJsonRpc(
  dispatcher: ReturnType<typeof withRpcStack>["dispatcher"],
  method: string,
  params: Record<string, unknown> = {},
  id: number | string = 1,
): Promise<JsonRpcResponse> {
  const line = await dispatcher.handleRequest(
    { jsonrpc: "2.0" as const, id, method, params },
    "test-conn",
  )
  return JSON.parse(line.trimEnd()) as JsonRpcResponse
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("withMCPServer — initialize", () => {
  it("answers initialize with serverInfo + capabilities + protocolVersion", async () => {
    const stack = withRpcStack()
    const t = withMCPServer<typeof stack>({})(stack)

    const resp = await callJsonRpc(t.dispatcher, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    })

    expect(resp.error).toBeUndefined()
    expect(resp.result).toMatchObject({
      protocolVersion: "2025-03-26",
      serverInfo: { name: "tribe", version: "9.9.9" },
      capabilities: { tools: {} },
    })
    await t.scope[Symbol.asyncDispose]()
  })

  it("uses caller-supplied serverInfo + protocolVersion + capabilities", async () => {
    const stack = withRpcStack()
    const t = withMCPServer<typeof stack>({
      serverInfo: { name: "custom", version: "0.1.0" },
      protocolVersion: "2099-01-01",
      capabilities: { tools: {}, experimental: { foo: {} } },
      instructions: "be silent",
    })(stack)

    const resp = await callJsonRpc(t.dispatcher, "initialize")

    expect(resp.result).toMatchObject({
      protocolVersion: "2099-01-01",
      serverInfo: { name: "custom", version: "0.1.0" },
      capabilities: { tools: {}, experimental: { foo: {} } },
      instructions: "be silent",
    })
    await t.scope[Symbol.asyncDispose]()
  })

  it("exposes mcpServer handle with tool snapshot", async () => {
    const stack = withRpcStack()
    const t = withMCPServer<typeof stack>({})(stack)

    expect(t.mcpServer.serverInfo.name).toBe("tribe")
    expect(t.mcpServer.protocolVersion).toBe("2025-03-26")
    expect(t.mcpServer.toolNames).toContain("tribe.send")
    expect(t.mcpServer.toolNames).toContain("tribe.broadcast")
    await t.scope[Symbol.asyncDispose]()
  })
})

describe("withMCPServer — tools/list", () => {
  it("emits the registered tools as MCP-shaped entries", async () => {
    const stack = withRpcStack()
    const t = withMCPServer<typeof stack>({})(stack)

    const resp = await callJsonRpc(t.dispatcher, "tools/list")

    expect(resp.error).toBeUndefined()
    const tools = (resp.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools
    const names = tools.map((entry) => entry.name)
    expect(names).toContain("tribe.send")
    expect(names).toContain("tribe.broadcast")
    // Every entry must carry an inputSchema object.
    for (const entry of tools) {
      expect(entry.inputSchema).toBeDefined()
    }
    await t.scope[Symbol.asyncDispose]()
  })

  it("uses opts.metadata to enrich tools without registry-native description", async () => {
    const stack = withRpcStack()
    const t = withMCPServer<typeof stack>({
      metadata: [
        {
          name: "tribe.send",
          description: "from-metadata description",
          inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
        },
      ],
    })(stack)

    const resp = await callJsonRpc(t.dispatcher, "tools/list")
    const tools = (resp.result as { tools: Array<{ name: string; description?: string; inputSchema: unknown }> }).tools
    const sendTool = tools.find((entry) => entry.name === "tribe.send")
    expect(sendTool).toBeDefined()
    expect(sendTool?.description).toBe("from-metadata description")
    expect(sendTool?.inputSchema).toMatchObject({ type: "object", required: ["to"] })
    await t.scope[Symbol.asyncDispose]()
  })

  it("late-registered tools appear in tools/list (registry read at call time)", async () => {
    const stack = withRpcStack()
    const t = withMCPServer<typeof stack>({})(stack)

    // Register a tool AFTER the MCP factory ran. tools/list reads live, so
    // it must show up.
    const lateTool: Tool = {
      name: "tribe.late",
      description: "added after the pipe",
      schema: { type: "object" },
      handler: () => "late",
    }
    t.tools.set(lateTool.name, lateTool)

    const resp = await callJsonRpc(t.dispatcher, "tools/list")
    const tools = (resp.result as { tools: Array<{ name: string }> }).tools
    expect(tools.some((entry) => entry.name === "tribe.late")).toBe(true)
    await t.scope[Symbol.asyncDispose]()
  })
})

describe("withMCPServer — tools/call", () => {
  it("returns isError result for unknown tools (no dispatch, no registry hit)", async () => {
    const stack = withRpcStack()
    const t = withMCPServer<typeof stack>({})(stack)

    const resp = await callJsonRpc(t.dispatcher, "tools/call", {
      name: "tribe.does-not-exist",
      arguments: {},
    })

    expect(resp.error).toBeUndefined()
    const result = resp.result as { content: Array<{ type: string; text: string }>; isError?: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toMatch(/Unknown tool/)
    await t.scope[Symbol.asyncDispose]()
  })

  it("dispatches via opts.dispatch when the tool is dispatcher-mounted", async () => {
    const stack = withRpcStack()
    const dispatchCalls: Array<{ name: string; args: Record<string, unknown> }> = []
    const t = withMCPServer<typeof stack>({
      dispatch: async (name, args) => {
        dispatchCalls.push({ name, args })
        // Return MCP-shaped result so the wrapper passes it through verbatim.
        return { content: [{ type: "text", text: `dispatched-${name}` }] }
      },
    })(stack)

    const resp = await callJsonRpc(t.dispatcher, "tools/call", {
      name: "tribe.broadcast",
      arguments: { message: "hello" },
    })

    expect(dispatchCalls).toHaveLength(1)
    expect(dispatchCalls[0]).toEqual({ name: "tribe.broadcast", args: { message: "hello" } })
    const result = resp.result as { content: Array<{ type: string; text: string }> }
    expect(result.content[0]?.text).toBe("dispatched-tribe.broadcast")
    await t.scope[Symbol.asyncDispose]()
  })

  it("falls back to registry handler when opts.dispatch returns undefined", async () => {
    const stack = withRpcStack()
    // Register a custom tool whose handler returns plain JSON (will be wrapped).
    stack.tools.set("test.echo", {
      name: "test.echo",
      handler: (args: Record<string, unknown>) => ({ echoed: args }),
    })

    const t = withMCPServer<typeof stack>({
      dispatch: () => undefined, // Signal "not dispatcher-mounted"
    })(stack)

    const resp = await callJsonRpc(t.dispatcher, "tools/call", {
      name: "test.echo",
      arguments: { hello: "world" },
    })

    const result = resp.result as { content: Array<{ type: string; text: string }>; isError?: boolean }
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0]!.text)).toEqual({ echoed: { hello: "world" } })
    await t.scope[Symbol.asyncDispose]()
  })

  it("registry-handler path passes ctx.connId + buildContext result as ctx.extra", async () => {
    const stack = withRpcStack()
    let observed: { connId: string; extra: unknown } | null = null
    stack.tools.set("test.context", {
      name: "test.context",
      handler: (_args, ctx) => {
        observed = { connId: ctx.connId ?? "", extra: ctx.extra }
        return { ok: true }
      },
    })

    const t = withMCPServer<typeof stack>({
      buildContext: (connId, toolName) => ({ source: "buildContext", toolName, conn: connId }),
    })(stack)

    await callJsonRpc(t.dispatcher, "tools/call", { name: "test.context", arguments: {} })

    expect(observed).not.toBeNull()
    expect(observed!.connId).toBe("test-conn")
    expect(observed!.extra).toEqual({ source: "buildContext", toolName: "test.context", conn: "test-conn" })
    await t.scope[Symbol.asyncDispose]()
  })

  it("registry-handler errors surface as isError result with message", async () => {
    const stack = withRpcStack()
    stack.tools.set("test.boom", {
      name: "test.boom",
      handler: () => {
        throw new Error("kaboom")
      },
    })

    const t = withMCPServer<typeof stack>({})(stack)

    const resp = await callJsonRpc(t.dispatcher, "tools/call", { name: "test.boom", arguments: {} })

    const result = resp.result as { content: Array<{ type: string; text: string }>; isError?: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toMatch(/kaboom/)
    await t.scope[Symbol.asyncDispose]()
  })
})

describe("withMCPServer — dispatcher integration", () => {
  it("re-registering an MCP method on the same dispatcher throws", async () => {
    const stack = withRpcStack()
    const t = withMCPServer<typeof stack>({})(stack)

    expect(() => t.dispatcher.register("initialize", () => ({}))).toThrow(/already registered/)
    await t.scope[Symbol.asyncDispose]()
  })

  it("dispatcher.register is callable for arbitrary methods (not MCP-only)", async () => {
    const stack = withRpcStack()
    // Don't apply withMCPServer — just check the dispatcher's API.
    stack.dispatcher.register("custom.method", (params) => ({
      seen: params,
    }))

    const resp = await callJsonRpc(stack.dispatcher, "custom.method", { hi: 1 })

    expect(resp.error).toBeUndefined()
    expect(resp.result).toEqual({ seen: { hi: 1 } })
    await stack.scope[Symbol.asyncDispose]()
  })

  it("explicit dispatcher cases (tribe.*) still win over late-bound handlers", async () => {
    const stack = withRpcStack()
    // Try to register a late handler for an explicit dispatcher case; it
    // should NOT shadow the explicit case (default branch only runs when
    // no explicit case matches). The explicit case is `tribe.health`, which
    // resolves through handleToolCall and returns a real result.
    expect(() => stack.dispatcher.register("tribe.health", () => "shadow")).not.toThrow()
    const resp = await callJsonRpc(stack.dispatcher, "tribe.health")
    expect(resp.result).not.toBe("shadow")
    expect(resp.error).toBeUndefined()
    await stack.scope[Symbol.asyncDispose]()
  })
})
