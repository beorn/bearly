/**
 * Tribe plugin system — optional capabilities that enhance tribe coordination.
 *
 * Plugins can provide:
 * - Auto-report sources (detect changes, send notifications to chief)
 * - Extra MCP tool definitions
 * - Instruction text for the system prompt
 *
 * Plugins are optional and graceful-degrade: if a plugin's dependencies aren't
 * available (e.g., no .beads/ directory), it silently disables itself.
 */

import { existsSync, statSync, readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { resolve, dirname } from "node:path"

export interface TribePlugin {
  name: string
  /** Check if plugin can activate (e.g., .beads/ exists) */
  available(): boolean
  /** Start background polling. Returns cleanup function. */
  start?(ctx: PluginContext): (() => void) | void
  /** Extra instructions to append to the MCP system prompt */
  instructions?(): string
}

export interface PluginContext {
  /** Send a message to a recipient via tribe */
  sendMessage(to: string, content: string, type?: string, beadId?: string): void
  /** Check if a chief session is alive */
  hasChief(): boolean
  /** Check if any session already sent a message with this content prefix (dedup) */
  hasRecentMessage(contentPrefix: string): boolean
  /** Current session name */
  sessionName: string
  /** Current session ID (internal tribe UUID) */
  sessionId: string
  /** Claude Code session ID (if available) */
  claudeSessionId: string | null
}

// ---------------------------------------------------------------------------
// Built-in plugin: Beads auto-reporter
// ---------------------------------------------------------------------------

export function beadsPlugin(opts: { beadsDir: string | null } = { beadsDir: null }): TribePlugin {
  return {
    name: "beads",

    available() {
      if (!opts.beadsDir) return false
      const issuesPath = resolve(opts.beadsDir, "backup/issues.jsonl")
      return existsSync(issuesPath)
    },

    start(ctx) {
      if (!opts.beadsDir) return
      const issuesPath = resolve(opts.beadsDir, "backup/issues.jsonl")
      if (!existsSync(issuesPath)) return

      let lastMtime = 0
      const reportedStates = new Map<string, string>()

      // Snapshot current state
      try {
        lastMtime = statSync(issuesPath).mtimeMs
        for (const line of readFileSync(issuesPath, "utf8").split("\n").filter(Boolean)) {
          try {
            const entry = JSON.parse(line) as { id?: string; status?: string; claimed_by?: string }
            if (!entry.id) continue
            if (entry.claimed_by?.includes(ctx.sessionName) || entry.claimed_by?.includes(ctx.claudeSessionId ?? "")) {
              reportedStates.set(entry.id, "claimed")
            }
            if (entry.status === "closed") {
              reportedStates.set(entry.id, "closed")
            }
          } catch { /* malformed */ }
        }
      } catch { /* file missing */ }

      const interval = setInterval(async () => {
        if (!ctx.hasChief()) return
        try {
          const stat = statSync(issuesPath)
          if (stat.mtimeMs === lastMtime) return
          lastMtime = stat.mtimeMs

          const content = await readFile(issuesPath, "utf8")
          for (const line of content.split("\n").filter(Boolean)) {
            try {
              const entry = JSON.parse(line) as { id?: string; title?: string; status?: string; claimed_by?: string }
              if (!entry.id) continue

              const isMyClaim = entry.claimed_by?.includes(ctx.sessionName) || entry.claimed_by?.includes(ctx.claudeSessionId ?? "")
              if (isMyClaim && reportedStates.get(entry.id) !== "claimed") {
                reportedStates.set(entry.id, "claimed")
                ctx.sendMessage("chief", `Claimed: ${entry.id} — ${entry.title}`, "status", entry.id)
              } else if (entry.status === "closed" && reportedStates.get(entry.id) !== "closed") {
                reportedStates.set(entry.id, "closed")
                ctx.sendMessage("chief", `Closed: ${entry.id} — ${entry.title}`, "status", entry.id)
              }
            } catch { /* malformed */ }
          }
        } catch { /* file error */ }
      }, 30_000)

      return () => clearInterval(interval)
    },

    instructions() {
      return "- Beads integration active: use `bd create`, `bd update`, `bd close` for task tracking"
    },
  }
}

// ---------------------------------------------------------------------------
// Built-in plugin: Git commit auto-reporter
// ---------------------------------------------------------------------------

export function gitPlugin(): TribePlugin {
  return {
    name: "git",

    available() {
      try {
        const { execSync } = require("node:child_process")
        execSync("git rev-parse HEAD", { cwd: process.cwd(), encoding: "utf8" })
        return true
      } catch {
        return false
      }
    },

    start(ctx) {
      const { execSync } = require("node:child_process")
      let lastHead = ""
      try {
        lastHead = execSync("git rev-parse HEAD", { cwd: process.cwd(), encoding: "utf8" }).trim()
      } catch { /* not a git repo */ }

      const interval = setInterval(async () => {
        if (!ctx.hasChief()) return
        try {
          const proc = Bun.spawn(["git", "log", "--oneline", "-1", "HEAD"], {
            cwd: process.cwd(),
            stdout: "pipe",
            stderr: "ignore",
          })
          const out = await new Response(proc.stdout).text()
          const line = out.trim()
          const head = line.split(" ")[0] ?? ""
          if (head && lastHead && head !== lastHead) {
            // Deduplicate: skip if any session already reported this commit
            if (!ctx.hasRecentMessage(`Committed: ${head}`)) {
              ctx.sendMessage("chief", `Committed: ${line}`, "status")
            }
          }
          if (head) lastHead = head
        } catch { /* git error */ }
      }, 30_000)

      return () => clearInterval(interval)
    },
  }
}

// ---------------------------------------------------------------------------
// Plugin loader
// ---------------------------------------------------------------------------

export function loadPlugins(plugins: TribePlugin[], ctx: PluginContext): () => void {
  const cleanups: Array<() => void> = []

  for (const plugin of plugins) {
    if (!plugin.available()) {
      process.stderr.write(`[tribe] plugin ${plugin.name}: not available (skipped)\n`)
      continue
    }
    process.stderr.write(`[tribe] plugin ${plugin.name}: active\n`)
    if (plugin.start) {
      const cleanup = plugin.start(ctx)
      if (cleanup) cleanups.push(cleanup)
    }
  }

  return () => {
    for (const fn of cleanups) fn()
  }
}
