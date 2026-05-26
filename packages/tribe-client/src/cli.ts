#!/usr/bin/env bun
/**
 * `tribe` — unified CLI binary for the @bearly/tribe-client package.
 *
 * Phase A.MVP (@km/bearly/tribe-cli-unify-phase-a-substrate): shipped
 *   `tribe mcp` (stdio adapter forwarder).
 *
 * Phase A.2 (@km/bearly/19231-tribe-cli-unify-phase-a2-verbs) round 1:
 *   ships read/inspect + send/messaging verb families. Each family
 *   registers via its own dispatcher (cli/read.ts, cli/send.ts) over
 *   `@silvery/commander`. Lifecycle / install / hooks families land in
 *   future rounds.
 *
 * Subcommands today:
 *
 *   tribe mcp [--name <name>] [--role <role>] [--socket <path>] ...
 *     Runs the stdio MCP adapter that bridges Claude Code stdio to the
 *     tribe daemon's Unix socket. argv-forwarded (NOT Commander-parsed),
 *     so the stdio-adapter's own parseTribeArgs sees the full flag set.
 *
 *   tribe status | sessions | pending | log | health | inbox-status | activity
 *     Read/inspect verbs — register via cli/read.ts (Family 1).
 *
 *   tribe send | retro | alarm | alarm-status | alarm-ack
 *     Send/messaging verbs — register via cli/send.ts (Family 2).
 *
 *   Legacy non-ported verbs (start/stop/reload/watch/lifecycle/install/
 *   uninstall/doctor/hook/session-start/prompt/session-end/pre-compact)
 *   still ship via `bun tools/tribe-cli.ts <verb>` until Phase A.2
 *   families 3-5 land.
 */

const ARGV_FORWARDED_SUBCOMMANDS = new Set(["mcp"])

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const sub = argv[0]

  // argv-forwarded subcommands run BEFORE Commander parses, so the child can
  // see its own raw flags via process.argv. (Commander's strict mode would
  // reject unknown flags like --account that stdio-adapter parses itself.)
  if (sub && ARGV_FORWARDED_SUBCOMMANDS.has(sub)) {
    switch (sub) {
      case "mcp":
        // stdio-adapter parses its own argv via parseTribeArgs (strict: false).
        // The subcommand token 'mcp' sits at argv[2] and is silently ignored
        // as an extra positional; named flags (--name etc.) are picked up
        // normally. Hot-reload self-restart at stdio-adapter.ts:599 uses
        // `process.argv.slice(1)` which preserves the cli.ts entry — re-exec
        // re-enters this dispatcher cleanly.
        await import("./stdio-adapter.ts")
        return
    }
  }

  // Commander-routed subcommands (Phase A.2 verb families).
  const { Command } = await import("@silvery/commander")
  const program = new Command("tribe")
  program.description("@bearly/tribe-client unified CLI — coordinate the tribe daemon")
  program.addHelpText(
    "after",
    `\nMCP adapter (argv-forwarded, not Commander-parsed):\n` +
      `  tribe mcp [--name X --role Y --socket /path ...]\n` +
      `    Bridges Claude Code stdio to the tribe daemon's Unix socket.\n` +
      `    See: bun packages/tribe-client/src/stdio-adapter.ts --help\n`,
  )

  const { registerReadCommands } = await import("./cli/read.ts")
  const { registerSendCommands } = await import("./cli/send.ts")
  registerReadCommands(program)
  registerSendCommands(program)

  // Defer to Commander — it handles --help, unknown-subcommand errors, and exits.
  await program.parseAsync(process.argv)
}

await main()

export {}
