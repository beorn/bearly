#!/usr/bin/env bun
/**
 * `tribe` — unified CLI binary for the @bearly/tribe-client package.
 *
 * Phase A.MVP (@km/bearly/tribe-cli-unify-phase-a-substrate): ships the
 * subcommand dispatcher with `mcp` only. The full verb migration (status,
 * sessions, send, log, retro, install, etc.) lands in Phase A.2 — see
 * follow-up bead. Until then, the legacy `bun tools/tribe-cli.ts <verb>`
 * surface stays canonical for non-mcp verbs.
 *
 * Subcommands today:
 *
 *   tribe mcp [--name <name>] [--role <role>] [--socket <path>]
 *             [--account <id>] [--provider <id>] [--domains <list>]
 *
 *   Runs the stdio MCP adapter that bridges Claude Code stdio to the tribe
 *   daemon's Unix socket. Same flag surface + env-var fallbacks as the
 *   underlying stdio-adapter (parseTribeArgs in lib/config.ts).
 *
 * Why this is a tiny dispatcher rather than a full port: stdio-adapter is
 * already published in this package (since 0.3.0); cli.ts just makes it
 * invocable as `tribe mcp` from the bin entry. Verb migration adds ~6
 * transitive deps from the bearly tools/ directory (retro, install,
 * activity-watch, hook-dispatch, autostart-config, hooks/index) that some
 * straddle daemon/client boundary — that work is its own bead.
 */

const SUBCOMMANDS = ["mcp"] as const
type Subcommand = (typeof SUBCOMMANDS)[number]

function printUsage(): void {
  process.stdout.write(`tribe — @bearly/tribe-client unified CLI

Usage:
  tribe <subcommand> [options...]

Subcommands:
  mcp     Run the stdio MCP adapter (bridges Claude Code stdio to tribe daemon)

For mcp options, see: bun packages/tribe-client/src/stdio-adapter.ts --help
Or set TRIBE_NAME / TRIBE_ROLE / TRIBE_SOCKET / TRIBE_ACCOUNT / TRIBE_PROVIDER
in the environment.

Phase A.MVP — non-mcp verbs (status, sessions, send, log, retro, install, …)
are still served by the legacy: bun tools/tribe-cli.ts <verb>
Verb-migration is tracked at the A.2 follow-up bead.
`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const sub = argv[0]

  if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
    printUsage()
    process.exit(sub ? 0 : 2)
  }

  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
    process.stderr.write(`tribe: unknown subcommand '${sub}'\n\n`)
    printUsage()
    process.exit(2)
  }

  switch (sub as Subcommand) {
    case "mcp":
      // stdio-adapter parses its own argv via parseTribeArgs (strict: false).
      // The subcommand token 'mcp' sits at argv[2] and is silently ignored as
      // an extra positional; named flags (--name etc.) are picked up normally.
      // The hot-reload self-restart at stdio-adapter.ts:599 uses
      // `process.argv.slice(1)` which preserves the cli.ts entry — re-exec
      // re-enters this dispatcher cleanly.
      await import("./stdio-adapter.ts")
      return
  }
}

await main()
