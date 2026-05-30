/**
 * Regression guard for the tribe MCP server's Claude Code *channel-source*
 * contract (Mode 2 of the three-host tribe-delivery design — km epic 15409).
 *
 * Claude Code's channel feature is purely an MCP capability — there is no
 * `--channels` CLI flag in Claude Code 2.1.145. A server becomes a channel
 * source by:
 *
 *   1. declaring `capabilities.experimental["claude/channel"]` in its
 *      `initialize` response, and
 *   2. emitting `notifications/claude/channel` notifications.
 *
 * Both must hold in BOTH the source
 * (`packages/tribe-client/src/stdio-adapter.ts`) and the bundled artifact
 * Claude Code actually loads (`plugins/tribe/server.mjs`). Testing the
 * bundle catches stale-build drift — the bundle is rebuilt via
 * `plugins/tribe/package.json` `build` and can fall behind source.
 *
 * Channel-delivered content is untrusted external text (another agent, or an
 * external adapter such as the github plugin). It MUST route through
 * `defangModelInput` before reaching the MCP wire. This suite asserts the
 * single `sendChannel` chokepoint applies the defang and that no
 * `notifications/claude/channel` emission bypasses it.
 */

import { describe, test, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const ADAPTER_SRC = resolve(here, "../packages/tribe-client/src/stdio-adapter.ts")
const SERVER_BUNDLE = resolve(here, "../plugins/tribe/server.mjs")

const CHANNEL_CAPABILITY = `"claude/channel"`
const CHANNEL_NOTIFICATION = "notifications/claude/channel"

describe("tribe MCP server — Claude Code channel-source contract (epic 15409 Mode 2)", () => {
  const src = readFileSync(ADAPTER_SRC, "utf-8")

  test("source declares experimental['claude/channel'] capability", () => {
    expect(src).toContain(CHANNEL_CAPABILITY)
    // The capability sits inside the MCP Server() construction's `experimental` block.
    expect(src).toMatch(/experimental:\s*\{\s*"claude\/channel":\s*\{\}/)
  })

  test("source emits notifications/claude/channel", () => {
    expect(src).toContain(CHANNEL_NOTIFICATION)
  })

  test("all notifications/claude/channel emissions route through sendChannel (the defang chokepoint)", () => {
    // The MCP-wire emission of a channel notification must happen in exactly
    // one place — the `sendChannel` helper — so the defang is unbypassable.
    const wireEmissions = src
      .split("\n")
      .filter((line) => line.includes(CHANNEL_NOTIFICATION) && line.includes("mcp.notification"))
    expect(wireEmissions.length).toBe(1)
  })

  test("sendChannel defangs content before the MCP wire", () => {
    // The single emission line lives inside sendChannel, which must call
    // defangModelInput on the content first.
    const sendChannelBody = src.slice(src.indexOf("function sendChannel"), src.indexOf("function sendChannel") + 600)
    expect(sendChannelBody).toContain("defangModelInput")
    // defang must be applied to `content` and the defanged value is what ships.
    expect(sendChannelBody).toMatch(/defangModelInput\(content\)/)
    expect(sendChannelBody).toMatch(/content:\s*safeContent/)
  })

  test("stdio-adapter imports defangModelInput", () => {
    expect(src).toMatch(/import\s*\{\s*defangModelInput\s*\}/)
  })
})

describe("tribe MCP server — bundled artifact stays in sync (no stale-build drift)", () => {
  // The bundle is the file Claude Code actually loads (see plugins/tribe/.mcp.json).
  // Skip gracefully if a standalone checkout hasn't built it yet.
  const hasBundle = existsSync(SERVER_BUNDLE)
  const bundle = hasBundle ? readFileSync(SERVER_BUNDLE, "utf-8") : ""

  test.skipIf(!hasBundle)("bundle declares the claude/channel capability", () => {
    expect(bundle).toContain(CHANNEL_CAPABILITY)
  })

  test.skipIf(!hasBundle)("bundle emits notifications/claude/channel", () => {
    expect(bundle).toContain(CHANNEL_NOTIFICATION)
  })

  test.skipIf(!hasBundle)("bundle still defangs channel content", () => {
    // Bundlers strip comments but keep identifiers — the defang call survives.
    expect(bundle).toContain("defangModelInput")
  })
})
