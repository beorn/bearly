#!/usr/bin/env bun
/**
 * recall.ts - Unified CLI for Claude Code session history
 *
 * Searches indexed sessions using FTS5 with optional LLM synthesis.
 * Replaces both the old `recall.ts` and `history.ts` CLIs.
 *
 * Usage:
 *   recall <query>                    # Search + LLM synthesis (default)
 *   recall <query> --raw              # Raw search results
 *   recall index [--incremental]      # Build/rebuild FTS5 index
 *   recall status                     # Dashboard: activity + stats + index health
 *   recall sessions [id]              # List sessions or show details
 *   recall files [pattern]            # List/search file writes
 *   recall files --restore <file>     # Recover file content
 *
 * Internal (hook system):
 *   recall hook                       # UserPromptSubmit (stdin JSON)
 *   recall remember                   # SessionEnd (stdin JSON)
 */

import { Command, CommanderError, int, uint } from "@silvery/commander"
import { cmdSearch, type SearchOptions } from "./recall/search"
import { cmdStatus } from "./recall/status"
import { cmdSessions, cmdIndex } from "./recall/sessions"
import { cmdFiles } from "./recall/files"
import { cmdHook, cmdRemember } from "./recall/hooks"
import { cmdSummarize, cmdWeekly, cmdShow } from "./recall/summarize-daily"

// ============================================================================
// CLI
// ============================================================================

const SUBCOMMANDS = new Set([
  "index",
  "status",
  "sessions",
  "files",
  "hook",
  "remember",
  "summarize",
  "weekly",
  "show",
  "help",
  "--help",
  "-h",
  "--version",
  "-V",
])

const program = new Command()

program
  .name("recall")
  .description("Search and manage Claude Code session history")
  .version("1.0.0")
  .exitOverride()
  .configureOutput({
    writeErr: (str) => console.error(str.trimEnd()),
  })

// ── Default: search ─────────────────────────────────────────────────────
program
  .command("search", { hidden: true })
  .description("Search and synthesize session history")
  .argument("<query>", "Search query")
  .option("--raw", "Skip LLM synthesis, show raw results")
  .option("--json", "JSON output")
  .option("-s, --since <time>", "Time filter: 1h, 1d, 1w, today, yesterday (default: 30d)")
  .option("-n, --limit <num>", "Max results (default: 10)", int)
  .option("--timeout <ms>", "LLM timeout in ms (default: 4000)", uint)
  .option("-p, --project <glob>", "Project filter")
  .option("-g, --grep", "Regex mode (slower, scans files)")
  .option("-q, --question", "User messages only (implies --raw)")
  .option("-r, --response", "Assistant messages only (implies --raw)")
  .option("-t, --tool <name>", "Tool filter: Write, Bash, etc. (implies --raw)")
  .option("--session <id>", "Specific session (implies --raw)")
  .option("-i, --include <types>", "Content types: p,m,s,t,f,b,e,d,c (implies --raw)")
  .option("--agent", "LLM query-planner mode: plan → fan out → rerank → synthesize")
  .option("--round2 <mode>", "Round 2 mode: auto|wider|deeper|off (default auto)")
  .option("--max-rounds <n>", "Cap agent rounds (1 or 2, default 2)", int)
  .option("--debug-plan", "Print full planner output each round (implies --agent)")
  .option("--plan-timeout <ms>", "Planner per-call timeout (default 2500)", uint)
  .actionMerged(async (opts) => {
    const searchOpts = opts as unknown as SearchOptions & { query: string }
    await cmdSearch(searchOpts.query, searchOpts)
  })

// ── index ───────────────────────────────────────────────────────────────
program
  .command("index")
  .description("Build/rebuild FTS5 index")
  .option("--incremental", "Only index new sessions")
  .option("--project-root <path>", "Project root for indexing project sources (beads, docs, memory)")
  .action(async (opts: { incremental?: boolean; projectRoot?: string }) => {
    await cmdIndex(opts)
  })

// ── status ──────────────────────────────────────────────────────────────
program
  .command("status")
  .description("Dashboard: activity, stats, index health, hook config")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    await cmdStatus(opts)
  })

// ── sessions ────────────────────────────────────────────────────────────
program
  .command("sessions")
  .argument("[id]", "Session ID to show details for")
  .description("List sessions or show session details")
  .option("-p, --project <glob>", "Project filter")
  .actionMerged(async (opts: { id?: string; project?: string }) => {
    await cmdSessions(opts.id, opts)
  })

// ── files ───────────────────────────────────────────────────────────────
program
  .command("files")
  .argument("[pattern]", "File pattern to search for")
  .description("List/search file writes or restore content")
  .option("--restore <file>", "Restore file content")
  .option("--date <date>", "Filter by date (e.g., 2026-02)")
  .actionMerged(async (opts: { pattern?: string; restore?: string; date?: string }) => {
    await cmdFiles(opts.pattern, opts)
  })

// ── hook (internal) ─────────────────────────────────────────────────────
program
  .command("hook", { hidden: true })
  .description("UserPromptSubmit hook (reads stdin JSON)")
  .action(async () => {
    await cmdHook()
  })

// ── remember (internal) ─────────────────────────────────────────────────
program
  .command("remember", { hidden: true })
  .description("SessionEnd hook (reads stdin JSON)")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    await cmdRemember(opts)
  })

// ── summarize ─────────────────────────────────────────────────────────
program
  .command("summarize")
  .argument("[date]", "Date to summarize (default: all unprocessed days)")
  .description("Daily summary across all sessions (default: all unprocessed days)")
  .option("-p, --project <glob>", "Project filter")
  .actionMerged(async (opts: { date?: string; project?: string }) => {
    await cmdSummarize(opts.date, { verbose: true, project: opts.project })
  })

// ── show ────────────────────────────────────────────────────────────
program
  .command("show")
  .argument("[date]", "Date or 'week' (default: list recent)")
  .description("Show existing summaries (default: list recent; YYYY-MM-DD: that day; 'week': latest weekly)")
  .actionMerged(async (opts: { date?: string }) => {
    await cmdShow(opts.date)
  })

// ── weekly ──────────────────────────────────────────────────────────
program
  .command("weekly")
  .argument("[date]", "Any day in the target week (default: last week)")
  .description("Weekly summary from daily summaries (date = any day in the target week, default: last week)")
  .actionMerged(async (opts: { date?: string }) => {
    await cmdWeekly(opts.date)
  })

// ============================================================================
// Entry point
// ============================================================================

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  // No args → show help (Step 0: fix exitOverride crash)
  if (argv.length === 0) {
    try {
      program.help()
    } catch (e) {
      if (e instanceof CommanderError && e.exitCode === 0) {
        process.exit(0)
      }
      throw e
    }
    return
  }

  // If first arg isn't a known subcommand, treat as `search <query> [opts]`
  if (!SUBCOMMANDS.has(argv[0]!)) {
    argv = ["search", ...argv]
  }

  try {
    await program.parseAsync(["node", "recall", ...argv])
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.exitCode === 0) {
        process.exit(0)
      }
      // Commander already printed the error
      process.exit(e.exitCode)
    }
    throw e
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (e) {
    console.error(`[recall] FATAL: ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}`)
    process.exit(1)
  }
}
