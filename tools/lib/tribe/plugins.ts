import { execSync } from "node:child_process"

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
import { createLogger } from "loggily"
import { findBeadsDir } from "./config.ts"
import { createTimers } from "./timers.ts"

const log = createLogger("tribe:plugins")

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
  /** Get current chief lease info from the leadership table (null if never held) */
  getLeaseInfo(): {
    holder_name: string
    holder_id: string
    term: number
    epoch: number
    lease_until: number
    acquired_at: number
  } | null
  /** Check if any session already sent a message with this content prefix (dedup) */
  hasRecentMessage(contentPrefix: string): boolean
  /** Atomic dedup claim — returns true if this session won the claim, false if another session already claimed it */
  claimDedup(key: string): boolean
  /** Get connected session names */
  getSessionNames(): string[]
  /** Get active sessions with their PIDs */
  getActiveSessions(): Array<{ name: string; pid: number; role: string }>
  /** Current session name */
  sessionName: string
  /** Current session ID (internal tribe UUID) */
  sessionId: string
  /** Claude Code session ID (if available) */
  claudeSessionId: string | null
  /** Trigger a hot-reload of the tribe MCP server (optional — not all hosts support it) */
  triggerReload?(reason: string): void
}

// ---------------------------------------------------------------------------
// Built-in plugin: Beads auto-reporter
// ---------------------------------------------------------------------------

export function beadsPlugin(): TribePlugin {
  const beadsDir = findBeadsDir()

  return {
    name: "beads",

    available() {
      if (!beadsDir) return false
      const issuesPath = resolve(beadsDir, "backup/issues.jsonl")
      return existsSync(issuesPath)
    },

    start(ctx) {
      if (!beadsDir) return
      const issuesPath = resolve(beadsDir, "backup/issues.jsonl")
      if (!existsSync(issuesPath)) return

      const ac = new AbortController()
      const timers = createTimers(ac.signal)

      let lastMtime = 0
      const reportedStates = new Map<string, string>()

      // Snapshot current state
      try {
        lastMtime = statSync(issuesPath).mtimeMs
        for (const line of readFileSync(issuesPath, "utf8").split("\n").filter(Boolean)) {
          try {
            const entry = JSON.parse(line) as { id?: string; status?: string; claimed_by?: string }
            if (!entry.id) continue
            const matchesName = !!ctx.sessionName && !!entry.claimed_by?.includes(ctx.sessionName)
            const matchesSession = !!ctx.claudeSessionId && !!entry.claimed_by?.includes(ctx.claudeSessionId)
            if (matchesName || matchesSession) {
              reportedStates.set(entry.id, "claimed")
            }
            if (entry.status === "closed") {
              reportedStates.set(entry.id, "closed")
            }
          } catch {
            /* malformed */
          }
        }
      } catch {
        /* file missing */
      }

      timers.setInterval(async () => {
        try {
          const stat = statSync(issuesPath)
          if (stat.mtimeMs === lastMtime) return
          lastMtime = stat.mtimeMs

          const content = await readFile(issuesPath, "utf8")
          for (const line of content.split("\n").filter(Boolean)) {
            try {
              const entry = JSON.parse(line) as {
                id?: string
                title?: string
                status?: string
                claimed_by?: string
                priority?: string
                notes?: string
              }
              if (!entry.id) continue

              const prevState = reportedStates.get(entry.id)
              const currentState = entry.claimed_by ? `claimed:${entry.claimed_by}` : (entry.status ?? "open")

              // Skip if nothing changed
              if (prevState === currentState) continue
              reportedStates.set(entry.id, currentState)

              // Skip initial snapshot (first run captures existing state)
              if (!prevState && currentState === (entry.status ?? "open")) continue

              // Broadcast all bead changes
              if (!prevState) {
                // New bead
                if (ctx.claimDedup(`new:${entry.id}`)) {
                  ctx.sendMessage(
                    "*",
                    `New bead: ${entry.id} — ${entry.title} (${entry.priority ?? "?"})`,
                    "bead:new",
                    entry.id,
                  )
                }
              } else if (currentState.startsWith("claimed:")) {
                if (ctx.claimDedup(`claimed:${entry.id}`)) {
                  const actor = entry.claimed_by ?? ""
                  ctx.sendMessage("*", `Claimed: ${entry.id} — ${entry.title} [by:${actor}]`, "bead:claimed", entry.id)
                }
              } else if (entry.status === "closed") {
                if (ctx.claimDedup(`closed:${entry.id}`)) {
                  ctx.sendMessage("*", `Closed: ${entry.id} — ${entry.title}`, "bead:closed", entry.id)
                }
              } else if (entry.status === "in_progress") {
                if (ctx.claimDedup(`progress:${entry.id}`)) {
                  ctx.sendMessage("*", `In progress: ${entry.id} — ${entry.title}`, "bead:progress", entry.id)
                }
              } else {
                // Status change (open, deferred, etc.)
                if (ctx.claimDedup(`status:${entry.id}:${entry.status}`)) {
                  ctx.sendMessage("*", `Bead ${entry.id} → ${entry.status}`, "bead:status", entry.id)
                }
              }
            } catch {
              /* malformed */
            }
          }
        } catch (err) {
          log.error?.(`beads poll error: ${err instanceof Error ? err.message : err}`)
        }
      }, 30_000)

      return () => ac.abort()
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
      } catch {
        /* not a git repo */
      }

      const ac = new AbortController()
      const timers = createTimers(ac.signal)

      timers.setInterval(async () => {
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
            // Atomic dedup: first session to claim this commit hash wins
            if (ctx.claimDedup(`commit:${head}`)) {
              ctx.sendMessage("*", `Committed: ${line}`, "status")
            }
            // Auto-reload if tribe code changed in this commit
            try {
              const diffProc = Bun.spawn(["git", "diff", "--name-only", lastHead, head], {
                cwd: process.cwd(),
                stdout: "pipe",
                stderr: "ignore",
              })
              const diffOut = await new Response(diffProc.stdout).text()
              if (
                diffOut.includes("tools/tribe-proxy.ts") ||
                diffOut.includes("tools/tribe-daemon.ts") ||
                diffOut.includes("tools/lib/tribe/")
              ) {
                log.info?.(`tribe code changed in ${head}, auto-reloading`)
                ctx.triggerReload?.(`tribe code changed in ${head}`)
              }
            } catch {
              /* diff failed, skip */
            }
          }
          if (head) lastHead = head
        } catch (err) {
          log.error?.(`git poll error: ${err instanceof Error ? err.message : err}`)
        }
      }, 30_000)

      return () => ac.abort()
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
      log.info?.(`plugin ${plugin.name}: not available (skipped)`)
      continue
    }
    log.info?.(`plugin ${plugin.name}: active`)
    if (plugin.start) {
      const cleanup = plugin.start(ctx)
      if (cleanup) cleanups.push(cleanup)
    }
  }

  return () => {
    for (const fn of cleanups) fn()
  }
}
