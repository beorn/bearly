/**
 * `tribe` CLI smoke tests — Phase A.MVP (see km-bearly.tribe-cli-unify-phase-a-substrate).
 *
 * Phase A.MVP ships the dispatcher with a single `mcp` subcommand. These tests
 * verify the basic surface (help, unknown-subcommand handling, exit codes)
 * without spinning up a daemon — the mcp subcommand integration with the live
 * daemon is exercised by tribe-mcp-roundtrip.slow.test.ts at the bearly root.
 */

import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../src/cli.ts")

function runCli(args: string[], opts: { timeoutMs?: number } = {}): { stdout: string; stderr: string; code: number } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 5000,
    env: { ...process.env, TRIBE_NO_AUTOSTART: "1" },
  })
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    code: res.status ?? -1,
  }
}

describe("tribe CLI — Phase A.MVP", () => {
  it("--help prints subcommand list and exits 0", () => {
    const { stdout, code } = runCli(["--help"])
    expect(code).toBe(0)
    expect(stdout).toMatch(/tribe — @bearly\/tribe-client unified CLI/)
    expect(stdout).toMatch(/Subcommands:/)
    expect(stdout).toMatch(/mcp\s+Run the stdio MCP adapter/)
  })

  it("-h prints help and exits 0", () => {
    const { stdout, code } = runCli(["-h"])
    expect(code).toBe(0)
    expect(stdout).toMatch(/tribe — @bearly\/tribe-client unified CLI/)
  })

  it("help (bare) prints help and exits 0", () => {
    const { stdout, code } = runCli(["help"])
    expect(code).toBe(0)
    expect(stdout).toMatch(/Subcommands:/)
  })

  it("no args prints help and exits 2 (usage error)", () => {
    const { stdout, code } = runCli([])
    expect(code).toBe(2)
    expect(stdout).toMatch(/Usage:/)
  })

  it("unknown subcommand prints error + help and exits 2", () => {
    const { stdout, stderr, code } = runCli(["bogus-not-a-real-subcommand"])
    expect(code).toBe(2)
    expect(stderr).toMatch(/unknown subcommand 'bogus-not-a-real-subcommand'/)
    expect(stdout).toMatch(/Usage:/)
  })

  it("mcp subcommand exists and attempts to start (verified by non-zero exit on missing daemon, not 2 'unknown subcommand')", () => {
    // mcp tries to connect to a daemon. With TRIBE_NO_AUTOSTART=1 and no
    // running daemon, it will fail to connect — but the exit code must NOT
    // be 2 (our usage-error code for unknown subcommand). We give it a short
    // timeout to avoid hanging on the stdio MCP loop.
    const res = runCli(["mcp", "--name", "@test/cli-smoke", "--socket", "/tmp/tribe-non-existent-socket.sock"], {
      timeoutMs: 2000,
    })
    // Either timeout (signalled by code === null → -1 in our normalization)
    // or non-2 exit. The negative case we're guarding: cli.ts mis-dispatched
    // as "unknown subcommand" → exit 2.
    expect(res.code).not.toBe(2)
  })
})
