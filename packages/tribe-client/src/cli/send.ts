/**
 * Send/messaging verbs for the unified `tribe` CLI.
 *
 * Family 2 of Phase A.2 verb-port — see
 * `@km/bearly/19231-tribe-cli-unify-phase-a2-verbs`. Each verb mirrors the
 * implementation in `vendor/bearly/tools/tribe-cli.ts` (which stays canonical
 * until the Phase C atomic-delete). The handlers here are pure ports — same
 * RPCs, same flags, same output shape — with the only changes being:
 *
 *   - Import paths are intra-package (`../lib/...`) instead of
 *     `@bearly/tribe-client/lib/...` (to avoid self-import).
 *   - The `retro.ts` module was copied into `../lib/retro.ts` so this module
 *     has no `tools/` dependency. It still uses DB-direct access (read-only
 *     `bun:sqlite`) — straddles client/daemon boundary; Phase C may revisit.
 *   - The verbs are registered on a caller-supplied `Command` rather than
 *     created on a fresh `program` — the main dispatcher (`cli.ts`) calls
 *     `registerSendCommands(program)` to wire them up.
 *
 * Verbs in this family:
 *   - send          (line ~581 in tools/tribe-cli.ts)
 *   - alarm <reason>(line ~629)
 *   - alarm-status  (line ~635)
 *   - alarm-ack     (line ~641)
 *   - retro         (line ~646)
 */

import { existsSync } from "node:fs"
import { Database } from "bun:sqlite"
import type { Command } from "@silvery/commander"
import { connectToDaemon, resolveSocketPath } from "../lib/socket.ts"
import { resolveDbPath } from "../lib/config.ts"
import { formatMarkdown, generateRetro, parseDuration } from "../lib/retro.ts"

// ---------------------------------------------------------------------------
// Daemon connection (shared shape with read.ts — kept local per
// intra-module rule; Phase C may extract to ../lib/daemon-call.ts)
// ---------------------------------------------------------------------------

async function callDaemon(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const socketPath = resolveSocketPath()
  try {
    const client = await connectToDaemon(socketPath)
    try {
      const result = await client.call(method, params)
      return result
    } finally {
      client.close()
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ECONNREFUSED" || code === "ENOENT") {
      console.error(`No daemon running (socket: ${socketPath})`)
      console.error(`Start one with: tribe start`)
      process.exit(1)
    }
    throw err
  }
}

/** Thin wrapper so `retro` uses the same DB resolution as the daemon. */
function resolveDbPathFromCli(): string {
  return resolveDbPath({})
}

// ---------------------------------------------------------------------------
// Message-type contract — shared with the daemon validator (kept in lockstep
// with the legacy `tools/tribe-cli.ts` definition; do not drift).
// ---------------------------------------------------------------------------

const VALID_MESSAGE_TYPES = ["assign", "status", "query", "response", "notify", "request", "verdict"] as const
type MessageType = (typeof VALID_MESSAGE_TYPES)[number]

// ---------------------------------------------------------------------------
// Command implementations (ported verbatim from tools/tribe-cli.ts)
// ---------------------------------------------------------------------------

async function cmdSend(to: string, message: string, type: MessageType = "notify"): Promise<void> {
  await callDaemon("tribe.send", { to, message, type })
  console.log(`Sent message to ${to}`)
}

/**
 * Andon-pull alarm — `tribe alarm <reason>` sets a project-wide stop-the-line
 * flag. The chief-drain-check.sh PreToolUse hook reads it and HARD-BLOCKS
 * chief's tool calls until `tribe alarm-ack` clears it.
 * Spec: @km/all/silent-errors-enforcement/chief-silent-watchdog-relay-pattern-detection (Layer 3).
 */
async function cmdAlarmSet(reason: string, opts: { by?: string }): Promise<void> {
  const by = opts.by ?? process.env.USER ?? "anonymous"
  const result = (await callDaemon("cli_alarm_set", { reason, by })) as { ok: boolean }
  if (!result.ok) {
    console.error("tribe alarm: daemon refused")
    process.exit(1)
  }
  console.log(`ALARM SET — chief tool calls will block until 'tribe alarm-ack' is run.`)
  console.log(`  Reason: ${reason}`)
  console.log(`  By:     ${by}`)
}

async function cmdAlarmStatus(opts: { json?: boolean }): Promise<void> {
  const result = (await callDaemon("cli_alarm_get")) as
    | { active: false }
    | { active: true; reason: string; by: string; ts: number; age_min: number }
  if (opts.json) {
    console.log(JSON.stringify(result))
    return
  }
  if (!result.active) {
    console.log("No alarm active.")
    return
  }
  console.log(`ALARM ACTIVE (${result.age_min}min):`)
  console.log(`  Reason: ${result.reason}`)
  console.log(`  By:     ${result.by}`)
}

async function cmdAlarmAck(): Promise<void> {
  const result = (await callDaemon("cli_alarm_ack")) as { ok: boolean }
  if (!result.ok) {
    console.error("tribe alarm-ack: daemon refused")
    process.exit(1)
  }
  console.log("ALARM CLEARED — chief tool calls unblocked.")
}

function cmdRetro(opts: { since?: string; format: string; db?: string }): void {
  // Use the shared resolver so retro follows the same `--db > TRIBE_DB > XDG
  // > legacy migration` priority as the daemon. Before this fix, retro
  // hardcoded `.beads/tribe.db`, which breaks on fresh installs after the
  // km-tribe.decouple-db-location migration.
  const dbPath = opts.db ?? resolveDbPathFromCli()
  if (!existsSync(dbPath)) {
    console.error(`No tribe database found at ${dbPath}`)
    process.exit(1)
  }

  const db = new Database(dbPath, { readonly: true })
  db.run("PRAGMA busy_timeout = 5000")
  let sinceMs: number | undefined
  if (opts.since) {
    try {
      sinceMs = parseDuration(opts.since)
    } catch (err) {
      console.error(String(err))
      process.exit(1)
    }
  }
  const report = generateRetro(db, sinceMs)
  console.log(opts.format === "json" ? JSON.stringify(report, null, 2) : formatMarkdown(report))
  db.close()
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register send/messaging verbs (Family 2 of Phase A.2 verb-port).
 * Each verb mirrors the implementation in `vendor/bearly/tools/tribe-cli.ts`.
 *
 * Bead: @km/bearly/19231-tribe-cli-unify-phase-a2-verbs
 */
export function registerSendCommands(program: Command): void {
  program
    .command("send")
    .description("Send a message to a session")
    .argument("<to>", "Target session name")
    .argument("<message...>", "Message text")
    .option("-t, --type <type>", `Message type: ${VALID_MESSAGE_TYPES.join("|")} (default: notify)`)
    .action((to: string, message: string[], opts: { type?: string }) => {
      const type = opts.type ?? "notify"
      if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(type)) {
        console.error(`tribe send: invalid --type '${type}' — expected one of: ${VALID_MESSAGE_TYPES.join(", ")}`)
        process.exit(2)
      }
      void cmdSend(to, message.join(" "), type as MessageType)
    })

  program
    .command("alarm <reason>")
    .description("Andon-pull stop-the-line — blocks chief tool calls until 'alarm-ack' (Layer 3)")
    .option("--by <name>", "Set the author of the alarm (default: $USER)")
    .action((reason: string, opts: { by?: string }) => void cmdAlarmSet(reason, opts))

  program
    .command("alarm-status")
    .description("Show current andon-pull alarm state (active reason + age, or 'no alarm active')")
    .option("--json", "Emit machine-readable JSON (for hooks)")
    .action((opts: { json?: boolean }) => void cmdAlarmStatus(opts))

  program
    .command("alarm-ack")
    .description("Clear the andon-pull alarm — unblocks chief tool calls")
    .action(() => void cmdAlarmAck())

  program
    .command("retro")
    .description("Generate retrospective report — metrics, timeline, coordination health")
    .option("-s, --since <duration>", "Time window (e.g. 2h, 30m, 1d)")
    .option("-f, --format <fmt>", "Output format: markdown or json", "markdown")
    .option("--db <path>", "Path to tribe.db (default: auto-detect)")
    .action((opts: { since?: string; format?: string; db?: string }) =>
      cmdRetro({ since: opts.since, format: opts.format ?? "markdown", db: opts.db }),
    )
}
