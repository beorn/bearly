#!/usr/bin/env bun
/**
 * TTY MCP Server
 *
 * Self-contained MCP server for interactive terminal testing.
 * Uses Bun PTY + xterm-headless for terminal emulation.
 * Browser is only launched lazily for screenshot rendering.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { existsSync } from "fs"
import { join, dirname } from "path"
import { $ } from "bun"
import { PlaywrightTtyBackend } from "./lib/playwright-tty/server.js"

// Browser cache location (sibling to this file)
const BROWSER_CACHE = join(dirname(import.meta.path), ".playwright-cache")
process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSER_CACHE

async function ensureBrowserInstalled(): Promise<void> {
  const cacheExists = existsSync(BROWSER_CACHE)

  if (cacheExists) {
    const { stdout } = await $`ls -d ${BROWSER_CACHE}/chromium-* 2>/dev/null || true`.quiet()
    if (stdout.toString().trim()) {
      return
    }
  }

  console.error("Installing Chromium browser (first-time setup)...")
  await $`bunx playwright install chromium`.env({
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: BROWSER_CACHE,
  })
  console.error("Chromium installed successfully")
}

// Prevent unhandled errors from crashing the MCP server process.
// The server should stay alive — individual tool calls return errors to the client.
process.on("uncaughtException", (err) => {
  console.error("[tty-mcp] uncaughtException:", err.stack ?? err.message)
})
process.on("unhandledRejection", (err) => {
  console.error("[tty-mcp] unhandledRejection:", err instanceof Error ? (err.stack ?? err.message) : err)
})

/** Wrap a tool handler so errors become MCP error responses, not process crashes */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeTool(fn: (args: any) => Promise<{ content: Array<{ type: string; [k: string]: unknown }> }>): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (args: any) => {
    try {
      return await fn(args)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[tty-mcp] tool error: ${msg}`)
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true }
    }
  }
}

/** Type-safe registerTool that bridges safeTool's return type to McpServer's expected handler type */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function register(srv: McpServer, name: string, schema: any, handler: any): void {
  srv.registerTool(name, schema, handler)
}

async function main() {
  await ensureBrowserInstalled()

  const backend = new PlaywrightTtyBackend()

  const server = new McpServer({
    name: "tty",
    version: "2.0.0",
  })

  // start - Start a terminal session with Bun PTY
  register(
    server,
    "start",
    {
      description: "Start a terminal session with a PTY and xterm-headless emulator",
      inputSchema: {
        command: z.array(z.string()).describe("Command to run (e.g. ['bun', 'km', 'view', '/path'])"),
        env: z.record(z.string(), z.string()).optional().describe("Environment variables"),
        cols: z.number().default(120).describe("Terminal columns (default: 120)"),
        rows: z.number().default(40).describe("Terminal rows (default: 40)"),
        waitFor: z
          .union([z.literal("content"), z.literal("stable"), z.string()])
          .optional()
          .describe("Wait condition: 'content', 'stable', or specific text"),
        timeout: z.number().default(5000).describe("Timeout in ms for waitFor condition (default: 5000)"),
        cwd: z.string().optional().describe("Working directory"),
      },
    },
    safeTool(async (args) => {
      const result = await backend.callTool("tty_start", args)
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }
    }),
  )

  // list - List active sessions
  register(
    server,
    "list",
    {
      description: "List all active TTY sessions",
      inputSchema: {},
    },
    safeTool(async (args) => {
      const result = await backend.callTool("tty_list", args)
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }
    }),
  )

  // stop - Close a terminal session
  register(
    server,
    "stop",
    {
      description: "Stop a TTY session and kill the process",
      inputSchema: {
        sessionId: z.string().describe("Session ID to stop"),
      },
    },
    safeTool(async (args) => {
      const result = await backend.callTool("tty_stop", args)
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }
    }),
  )

  // press - Press keyboard key(s)
  register(
    server,
    "press",
    {
      description: "Press a keyboard key (e.g. 'Enter', 'ArrowDown', 'Control+c', 'j')",
      inputSchema: {
        sessionId: z.string().describe("Session ID"),
        key: z.string().describe("Key to press (Playwright key format)"),
      },
    },
    safeTool(async (args) => {
      const result = await backend.callTool("tty_press", args)
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }
    }),
  )

  // type - Type text
  register(
    server,
    "type",
    {
      description: "Type text into the terminal",
      inputSchema: {
        sessionId: z.string().describe("Session ID"),
        text: z.string().describe("Text to type"),
      },
    },
    safeTool(async (args) => {
      const result = await backend.callTool("tty_type", args)
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }
    }),
  )

  // screenshot - Capture screenshot
  register(
    server,
    "screenshot",
    {
      description: "Capture a screenshot of the terminal (launches browser for rendering)",
      inputSchema: {
        sessionId: z.string().describe("Session ID"),
        outputPath: z.string().optional().describe("File path to save (returns base64 if omitted)"),
      },
    },
    safeTool(async (args) => {
      const result = (await backend.callTool("tty_screenshot", args)) as {
        path?: string
        data?: string
        mimeType: "image/png"
      }

      if (result.data) {
        return {
          content: [
            {
              type: "image" as const,
              data: result.data,
              mimeType: result.mimeType,
            },
          ],
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }
    }),
  )

  // text - Get terminal text content
  register(
    server,
    "text",
    {
      description: "Get the text content of the terminal",
      inputSchema: {
        sessionId: z.string().describe("Session ID"),
      },
    },
    safeTool(async (args) => {
      const result = await backend.callTool("tty_text", args)
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }
    }),
  )

  // wait - Wait for text/stability
  register(
    server,
    "wait",
    {
      description: "Wait for specific text or terminal stability",
      inputSchema: {
        sessionId: z.string().describe("Session ID"),
        for: z.string().optional().describe("Text to wait for"),
        stable: z.number().optional().describe("Wait for terminal stability (milliseconds)"),
        timeout: z.number().default(30000).describe("Timeout in milliseconds"),
      },
    },
    safeTool(async (args) => {
      const result = await backend.callTool("tty_wait", args)
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }
    }),
  )

  // Handle shutdown
  process.on("SIGINT", () => {
    void backend.shutdown().then(() => process.exit(0))
  })

  process.on("SIGTERM", () => {
    void backend.shutdown().then(() => process.exit(0))
  })

  // Connect to stdio transport
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
