#!/usr/bin/env bun
/**
 * TTY CLI — one-shot terminal capture operations
 *
 * Stateless CLI for compound TTY operations:
 * - Start a process, wait for content, press keys, capture text/screenshot
 * - No daemon needed — runs the full lifecycle in one process
 *
 * @example
 * ```bash
 * # Text + screenshot
 * bun tools/tty.ts capture --command "bun km view /path" --keys "j,j,Enter" --screenshot /tmp/out.png --text
 *
 * # Text-only (no Chromium needed)
 * bun tools/tty.ts capture --command "bun km view /path" --wait-for "BOARD" --text
 * ```
 */

import { Command } from "commander"
import { createTerminal } from "termless"
import { createXtermBackend } from "termless-xtermjs"

const POLL_INTERVAL = 50

/** Wait for terminal to have any non-empty content */
async function waitForContent(term: ReturnType<typeof createTerminal>, timeout: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const content = term.getText().trim()
    if (content.length > 0) return
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
  }
  throw new Error(`Timeout: no terminal content after ${timeout}ms`)
}

const program = new Command().name("tty").description("One-shot terminal capture operations")

program
  .command("capture")
  .description("Start a process, interact, and capture output")
  .requiredOption("--command <cmd>", "Command to run")
  .option("--keys <keys>", "Comma-separated key names to press")
  .option("--wait-for <text>", "Wait for text before pressing keys (default: any content)")
  .option("--screenshot <path>", "Save screenshot to path")
  .option("--text", "Print terminal text to stdout")
  .option("--cols <n>", "Terminal columns", "120")
  .option("--rows <n>", "Terminal rows", "40")
  .option("--timeout <ms>", "Wait timeout in ms", "5000")
  .action(async (opts) => {
    const cols = Number.parseInt(opts.cols, 10)
    const rows = Number.parseInt(opts.rows, 10)
    const timeout = Number.parseInt(opts.timeout, 10)
    const command = opts.command.split(/\s+/)

    const term = createTerminal({
      backend: createXtermBackend({ cols, rows }),
      cols,
      rows,
    })

    await term.spawn(command)

    try {
      // Wait for initial content
      if (opts.waitFor) {
        await term.waitFor(opts.waitFor, timeout)
      } else {
        await waitForContent(term, timeout)
      }

      // Press keys if specified
      if (opts.keys) {
        const keys = opts.keys.split(",").map((k: string) => k.trim())
        for (const key of keys) {
          term.press(key)
          // Small delay between keys for rendering
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        // Wait for content to settle after key presses
        await term.waitForStable(200, timeout)
      }

      // Capture screenshot if requested
      if (opts.screenshot) {
        const svg = term.screenshotSvg()
        // Lazy-load Playwright only when screenshot is needed
        const { chromium } = await import("playwright")
        const browser = await chromium.launch()
        const page = await browser.newPage()
        await page.setContent(
          `<!DOCTYPE html><html><body style="margin:0;background:#000">${svg}</body></html>`,
          { waitUntil: "load" },
        )
        await page.waitForTimeout(50)
        const buffer = await page.screenshot({ fullPage: true })
        const { writeFile } = await import("node:fs/promises")
        await writeFile(opts.screenshot, buffer)
        await browser.close()
        console.error(`Screenshot saved: ${opts.screenshot}`)
      }

      // Print text if requested
      if (opts.text) {
        console.log(term.getText())
      }
    } finally {
      await term.close()
    }
  })

program.parse()
