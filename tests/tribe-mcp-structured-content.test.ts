/**
 * tribe MCP — structuredContent + outputSchema contract (15623).
 *
 * Spec: `@km/infra/15623-mcp-tools-structuredcontent`. The user complaint:
 * tribe MCP results were JSON-wrapped-in-JSON when expanded — the MCP
 * envelope `[{type:"text",text:"…"}]` with an escaped JSON string inside.
 * Fix: every tribe tool MUST now ALSO carry a `structuredContent` object
 * (typed JSON payload) so structuredContent-aware hosts render it natively,
 * and the tool MUST declare its `outputSchema` in `tools/list`.
 *
 * This test pins three claims:
 *
 * 1. Every TOOLS_LIST entry declares an outputSchema.
 * 2. tools/list response surfaces outputSchema alongside inputSchema.
 * 3. tools/call result for a registry handler that returns a raw payload
 *    is auto-wrapped with BOTH `content` (backward-compat) AND
 *    `structuredContent` (the 15623 surface).
 *
 * Pure handler invocation also asserted in `handlers.ts` consumers — this
 * test focuses on the wire-shape contract that the user-cited screenshot
 * was about: an MCP tool result, expanded, should expose a clean
 * structuredContent rather than only the escaped-string content envelope.
 */

import { afterEach, describe, expect, it } from "vitest"
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
  withRecall,
  withMCPServer,
  withProjectRoot,
  withSocketServer,
} from "../tools/lib/tribe/compose/index.ts"
import { TOOLS_LIST } from "../tools/lib/tribe/tools-list.ts"

const cleanupPaths: string[] = []
function tmpDb(): string {
  const path = `/tmp/tribe-mcp-structured-${randomUUID().slice(0, 8)}.db`
  cleanupPaths.push(path)
  return path
}
function tmpSock(): string {
  const path = `/tmp/tribe-mcp-structured-${randomUUID().slice(0, 8)}.sock`
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
        recallDbPath: tmpDb(),
        quitTimeoutSec: -1,
        inheritFd: null,
        focusPollMs: 1000,
        summaryPollMs: 2000,
        summarizerMode: "off" as const,
        recallEnabled: false,
      },
    }),
    withProjectRoot("/test"),
    withDatabase(),
    withDaemonContext(),
    withRecall(),
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
  const line = await dispatcher.handleRequest({ jsonrpc: "2.0" as const, id, method, params }, "test-conn")
  return JSON.parse(line.trimEnd()) as JsonRpcResponse
}

// ───────────────────────────────────────────────────────────────────────────
// (1) TOOLS_LIST contract — every tool declares an outputSchema
// ───────────────────────────────────────────────────────────────────────────

describe("TOOLS_LIST — every tool declares outputSchema (15623 contract)", () => {
  for (const tool of TOOLS_LIST) {
    it(`tool "${tool.name}" declares an outputSchema`, () => {
      // Bead 15623 acceptance: "Every tool on every MCP server we own
      // returns structuredContent for structured payloads + declares an
      // outputSchema." A missing outputSchema means a new tool was added
      // post-15623 without the contract.
      expect(tool, `${tool.name} entry must include outputSchema`).toHaveProperty("outputSchema")
      const schema = (tool as { outputSchema?: { type?: string; properties?: unknown } }).outputSchema
      expect(schema?.type, `${tool.name} outputSchema must be { type: "object" }`).toBe("object")
    })
  }
})

// ───────────────────────────────────────────────────────────────────────────
// (2) tools/list — outputSchema is surfaced over the wire
// ───────────────────────────────────────────────────────────────────────────

describe("tools/list — outputSchema flows through composer to wire (15623)", () => {
  it("an entry whose metadata supplies outputSchema surfaces it in the tools/list response", async () => {
    const stack = withRpcStack()
    const t = withMCPServer<typeof stack>({
      metadata: [
        {
          name: "tribe.send",
          description: "from-metadata description",
          inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
          outputSchema: {
            type: "object",
            properties: {
              sent: { type: "boolean" },
              id: { type: "string" },
            },
            additionalProperties: true,
          },
        },
      ],
    })(stack)

    const resp = await callJsonRpc(t.dispatcher, "tools/list")
    const tools = (
      resp.result as { tools: Array<{ name: string; inputSchema: unknown; outputSchema?: unknown }> }
    ).tools
    const sendTool = tools.find((entry) => entry.name === "tribe.send")
    expect(sendTool).toBeDefined()
    expect(sendTool?.outputSchema).toMatchObject({
      type: "object",
      properties: { sent: { type: "boolean" }, id: { type: "string" } },
    })
    await t.scope[Symbol.asyncDispose]()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// (3) tools/call — registry results auto-wrap into content + structuredContent
// ───────────────────────────────────────────────────────────────────────────

describe("tools/call — auto-wrap emits both content AND structuredContent (15623)", () => {
  it("registry handler returning a raw object surfaces it as structuredContent", async () => {
    const stack = withRpcStack()
    // Register a custom tool returning a plain payload (NOT pre-wrapped
    // in MCP { content } shape). The composer's tools/call fallback must
    // auto-wrap this with both backward-compat content AND new
    // structuredContent.
    const lateTool: Tool = {
      name: "tribe.test-raw",
      description: "returns a raw payload",
      schema: { type: "object" },
      handler: () => ({ ok: true, count: 7 }),
    }
    stack.tools.set(lateTool.name, lateTool)

    const t = withMCPServer<typeof stack>({})(stack)
    const resp = await callJsonRpc(t.dispatcher, "tools/call", {
      name: "tribe.test-raw",
      arguments: {},
    })

    expect(resp.error).toBeUndefined()
    const result = resp.result as {
      content?: Array<{ type: string; text: string }>
      structuredContent?: Record<string, unknown>
    }
    // Both halves present — old hosts get content, new hosts get structuredContent.
    expect(result.content?.[0]?.text).toBe(JSON.stringify({ ok: true, count: 7 }))
    expect(result.structuredContent).toEqual({ ok: true, count: 7 })
    await t.scope[Symbol.asyncDispose]()
  })

  it("registry handler returning an array gets wrapped under `items`", async () => {
    // MCP `CallToolResult.structuredContent` is restricted to an OBJECT.
    // Arrays + primitives must be wrapped — the composer wraps arrays
    // under `items` so structuredContent stays a valid record.
    const stack = withRpcStack()
    const arrTool: Tool = {
      name: "tribe.test-array",
      description: "returns an array",
      schema: { type: "object" },
      handler: () => [1, 2, 3],
    }
    stack.tools.set(arrTool.name, arrTool)

    const t = withMCPServer<typeof stack>({})(stack)
    const resp = await callJsonRpc(t.dispatcher, "tools/call", {
      name: "tribe.test-array",
      arguments: {},
    })

    const result = resp.result as { structuredContent?: Record<string, unknown> }
    expect(result.structuredContent).toEqual({ items: [1, 2, 3] })
    await t.scope[Symbol.asyncDispose]()
  })

  it("MCP-shaped handler results (already wrapping content) pass through unchanged", async () => {
    // Pre-shaped results must not be double-wrapped — the composer's
    // isMcpContentResult guard returns them verbatim, preserving any
    // structuredContent the handler emitted directly (the canonical path
    // used by tribe handlers post-15623 via the `jsonResult` helper).
    const stack = withRpcStack()
    const preShaped: Tool = {
      name: "tribe.test-pre-shaped",
      description: "returns a preshaped MCP envelope with structuredContent",
      schema: { type: "object" },
      handler: () => ({
        content: [{ type: "text" as const, text: "{\"ok\":true}" }],
        structuredContent: { ok: true },
      }),
    }
    stack.tools.set(preShaped.name, preShaped)

    const t = withMCPServer<typeof stack>({})(stack)
    const resp = await callJsonRpc(t.dispatcher, "tools/call", {
      name: "tribe.test-pre-shaped",
      arguments: {},
    })

    const result = resp.result as {
      content?: Array<{ type: string; text: string }>
      structuredContent?: Record<string, unknown>
    }
    expect(result.content?.[0]?.text).toBe('{"ok":true}')
    expect(result.structuredContent).toEqual({ ok: true })
    await t.scope[Symbol.asyncDispose]()
  })
})
