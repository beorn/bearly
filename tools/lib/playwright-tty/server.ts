/**
 * TTY MCP Backend - manages terminal sessions and implements tool handlers
 *
 * Uses termless (PTY + xterm.js backend) for terminal emulation.
 * Browser is only launched lazily for screenshots (rendering SVG to PNG).
 *
 * Robustness features:
 * - Per-tool timeouts prevent hanging on stale sessions
 * - Dead session auto-cleanup
 */

import type { Browser } from "playwright"
import type { Terminal } from "termless"
import { createTerminal } from "termless"
import { createXtermBackend } from "termless-xtermjs"
import {
  TtyStartInputSchema,
  TtyStopInputSchema,
  TtyPressInputSchema,
  TtyTypeInputSchema,
  TtyScreenshotInputSchema,
  TtyTextInputSchema,
  TtyWaitInputSchema,
  TtyListInputSchema,
  type TtyStartOutput,
  type TtyListOutput,
  type TtyStopOutput,
  type TtyPressOutput,
  type TtyTypeOutput,
  type TtyScreenshotOutput,
  type TtyTextOutput,
  type TtyWaitOutput,
} from "./types.js"
import { writeFile } from "fs/promises"

// Per-tool timeout in ms. Prevents any tool from hanging forever.
const TOOL_TIMEOUTS: Record<string, number> = {
  tty_list: 2_000,
  tty_stop: 10_000,
  tty_press: 5_000,
  tty_type: 5_000,
  tty_screenshot: 15_000, // may need to launch browser
  tty_text: 5_000,
}

const POLL_INTERVAL = 50

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer!))
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10)
}

/** Wait for terminal to have any non-empty content */
async function waitForContent(term: Terminal, timeout: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const content = term.getText().trim()
    if (content.length > 0) return
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
  }
  throw new Error(`Timeout: no terminal content after ${timeout}ms`)
}

interface TtySession {
  id: string
  command: string[]
  createdAt: Date
  terminal: Terminal
}

type ToolOutput =
  | TtyStartOutput
  | TtyListOutput
  | TtyStopOutput
  | TtyPressOutput
  | TtyTypeOutput
  | TtyScreenshotOutput
  | TtyTextOutput
  | TtyWaitOutput

export class PlaywrightTtyBackend {
  private sessions = new Map<string, TtySession>()
  private browser: Browser | null = null

  /** Lazy-launch browser only for screenshots */
  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && !this.browser.isConnected()) {
      this.browser = null
    }
    if (!this.browser) {
      const { chromium } = await import("playwright")
      const launching = chromium.launch({ headless: true })
      try {
        this.browser = await withTimeout(launching, 15_000, "chromium.launch")
      } catch (err) {
        launching.then((b) => b.close()).catch(() => {})
        throw err
      }
    }
    return this.browser
  }

  private async closeBrowser(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close()
      } catch {
        // Browser may already be disconnected
      }
      this.browser = null
    }
  }

  private getSession(sessionId: string): TtySession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      const active = Array.from(this.sessions.keys()).join(", ") || "none"
      throw new Error(`Session not found: ${sessionId}. Active sessions: ${active}`)
    }
    if (!session.terminal.alive) {
      const info = session.terminal.exitInfo ? ` (${session.terminal.exitInfo})` : ""
      session.terminal.close().catch(() => {})
      this.sessions.delete(sessionId)
      throw new Error(`Session ${sessionId} is dead (process exited${info}). It has been removed.`)
    }
    return session
  }

  private cleanupStaleSessions(): void {
    for (const [id, session] of this.sessions) {
      if (!session.terminal.alive) {
        session.terminal.close().catch(() => {})
        this.sessions.delete(id)
      }
    }
  }

  async callTool(name: string, args: unknown): Promise<ToolOutput> {
    let timeoutMs = TOOL_TIMEOUTS[name] ?? 10_000

    if (name === "tty_start") {
      try {
        const parsed = TtyStartInputSchema.parse(args)
        timeoutMs = parsed.timeout + 10_000
      } catch {
        timeoutMs = 15_000
      }
    } else if (name === "tty_wait") {
      try {
        const parsed = TtyWaitInputSchema.parse(args)
        timeoutMs = parsed.timeout + 5_000
      } catch {
        timeoutMs = 35_000
      }
    }

    try {
      return await withTimeout(this.handleTool(name, args), timeoutMs, name)
    } catch (err) {
      if (err instanceof Error && err.message.includes("timed out")) {
        this.cleanupStaleSessions()
      }
      throw err
    }
  }

  private async handleTool(name: string, args: unknown): Promise<ToolOutput> {
    switch (name) {
      case "tty_start": {
        const input = TtyStartInputSchema.parse(args)
        const id = generateId()
        const cols = input.cols ?? 120
        const rows = input.rows ?? 40

        const terminal = createTerminal({
          backend: createXtermBackend({ cols, rows }),
          cols,
          rows,
        })

        await terminal.spawn(input.command, {
          env: input.env as Record<string, string> | undefined,
          cwd: input.cwd,
        })

        // Wait for initial content
        try {
          const waitFor = input.waitFor ?? "content"
          if (waitFor === "content") {
            await waitForContent(terminal, input.timeout)
          } else if (waitFor === "stable") {
            await terminal.waitForStable(500, input.timeout)
          } else {
            await terminal.waitFor(waitFor, input.timeout)
          }
        } catch {
          // Don't fail start if wait times out — session is still usable
        }

        this.sessions.set(id, {
          id,
          command: input.command,
          createdAt: new Date(),
          terminal,
        })
        return { sessionId: id }
      }

      case "tty_list": {
        TtyListInputSchema.parse(args)
        this.cleanupStaleSessions()
        const sessions = Array.from(this.sessions.values()).map((s) => ({
          id: s.id,
          command: s.command,
          createdAt: s.createdAt.toISOString(),
        }))
        return { sessions }
      }

      case "tty_stop": {
        const input = TtyStopInputSchema.parse(args)
        const session = this.getSession(input.sessionId)
        await session.terminal.close()
        this.sessions.delete(input.sessionId)

        // Close browser if no more sessions
        if (this.sessions.size === 0) {
          await this.closeBrowser()
        }

        return { success: true }
      }

      case "tty_press": {
        const input = TtyPressInputSchema.parse(args)
        const session = this.getSession(input.sessionId)
        session.terminal.press(input.key)
        return { success: true }
      }

      case "tty_type": {
        const input = TtyTypeInputSchema.parse(args)
        const session = this.getSession(input.sessionId)
        session.terminal.type(input.text)
        return { success: true }
      }

      case "tty_screenshot": {
        const input = TtyScreenshotInputSchema.parse(args)
        const session = this.getSession(input.sessionId)
        const svg = session.terminal.screenshotSvg()

        // Launch browser lazily for rendering SVG to PNG
        const browser = await this.ensureBrowser()
        const context = await browser.newContext()
        const page = await context.newPage()
        try {
          await page.setContent(`<!DOCTYPE html><html><body style="margin:0;background:#000">${svg}</body></html>`, {
            waitUntil: "load",
          })
          const buffer = await page.screenshot()

          if (input.outputPath) {
            await writeFile(input.outputPath, buffer)
            return { path: input.outputPath, mimeType: "image/png" }
          }

          return { data: buffer.toString("base64"), mimeType: "image/png" }
        } finally {
          await context.close()
        }
      }

      case "tty_text": {
        const input = TtyTextInputSchema.parse(args)
        const session = this.getSession(input.sessionId)
        const content = session.terminal.getText()
        return { content }
      }

      case "tty_wait": {
        const input = TtyWaitInputSchema.parse(args)
        const session = this.getSession(input.sessionId)

        try {
          if (input.for) {
            await session.terminal.waitFor(input.for, input.timeout)
          } else if (input.stable) {
            await session.terminal.waitForStable(input.stable, input.timeout)
          } else {
            await waitForContent(session.terminal, input.timeout)
          }
          return { success: true }
        } catch (err) {
          if (err instanceof Error && err.message.includes("Timeout")) {
            return { success: false, timedOut: true }
          }
          throw err
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      try {
        await session.terminal.close()
      } catch {
        // Best-effort cleanup
      }
    }
    this.sessions.clear()
    await this.closeBrowser()
  }
}
