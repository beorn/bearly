/**
 * withConfig — parse CLI args + env, resolve socket/db/lore paths, decide quit
 * timeout and inherited fd. Pure: returns a `config` field on the daemon value.
 *
 * Owns the boundary between "command line / env" and "structured options the
 * rest of the pipe consumes." Tests may bypass `parseArgs` entirely by passing
 * a fully-formed `TribeConfig`.
 */

import { parseArgs } from "node:util"
import { resolveSocketPath } from "../socket.ts"
import { parseTribeArgs, resolveDbPath } from "../config.ts"
import { resolveLoreDbPath } from "../../../../plugins/tribe/lore/lib/config.ts"
import { resolveSummarizerMode, type SummarizerMode } from "../../../../plugins/tribe/lore/lib/summarizer.ts"
import type { BaseTribe } from "./base.ts"

export interface TribeConfig {
  readonly socketPath: string
  readonly dbPath: string
  readonly loreDbPath: string
  /** Quit timeout in seconds. -1 disables auto-quit, 0 quits immediately on idle. */
  readonly quitTimeoutSec: number
  /** Inherit an already-bound listening fd (set by the SIGHUP re-exec). */
  readonly inheritFd: number | null
  readonly focusPollMs: number
  readonly summaryPollMs: number
  readonly summarizerMode: SummarizerMode
  readonly loreEnabled: boolean
}

export interface WithConfig {
  readonly config: TribeConfig
}

export interface ConfigOpts {
  /** Skip parseArgs and use this config directly (tests). */
  override?: TribeConfig
  /** Argv to parse (defaults to process.argv.slice(2)). */
  argv?: string[]
}

export function withConfig<T extends BaseTribe>(opts: ConfigOpts = {}): (t: T) => T & WithConfig {
  return (t) => {
    if (opts.override) return { ...t, config: opts.override }

    const { values: daemonArgs } = parseArgs({
      args: opts.argv,
      options: {
        socket: { type: "string" },
        db: { type: "string" },
        fd: { type: "string" },
        "quit-timeout": { type: "string", default: "1800" },
        foreground: { type: "boolean", default: false },
        "lore-db": { type: "string" },
        "focus-poll-ms": { type: "string", default: process.env.TRIBE_FOCUS_POLL_MS ?? "60000" },
        "summary-poll-ms": { type: "string", default: process.env.TRIBE_SUMMARY_POLL_MS ?? "120000" },
        "summarizer-model": { type: "string", default: process.env.TRIBE_SUMMARIZER_MODEL ?? "off" },
        "no-lore": { type: "boolean", default: false },
      },
      strict: false,
    })

    const tribeArgs = parseTribeArgs()
    if (daemonArgs.db) tribeArgs.db = daemonArgs.db as string

    const config: TribeConfig = {
      socketPath: resolveSocketPath(daemonArgs.socket as string | undefined),
      dbPath: String(resolveDbPath(tribeArgs)),
      loreDbPath: resolveLoreDbPath(daemonArgs["lore-db"] as string | undefined),
      quitTimeoutSec: parseInt(String(daemonArgs["quit-timeout"]), 10),
      inheritFd: daemonArgs.fd ? parseInt(String(daemonArgs.fd), 10) : null,
      focusPollMs: Math.max(100, parseInt(String(daemonArgs["focus-poll-ms"]), 10) || 60_000),
      summaryPollMs: Math.max(500, parseInt(String(daemonArgs["summary-poll-ms"]), 10) || 120_000),
      summarizerMode: resolveSummarizerMode(String(daemonArgs["summarizer-model"])),
      loreEnabled: !daemonArgs["no-lore"],
    }

    return { ...t, config }
  }
}
