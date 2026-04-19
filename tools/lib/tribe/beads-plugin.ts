/**
 * Tribe plugin: Beads auto-reporter.
 *
 * Watches `.beads/backup/issues.jsonl` for changes and broadcasts bead state
 * transitions (new / claimed / closed / in-progress / status-change).
 *
 * Observer semantics: runs in the daemon (or any single in-process slot),
 * snapshots current state on start so historical beads are not re-broadcast,
 * then polls the issues file every 30s for deltas.
 */

import { existsSync, statSync, readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createLogger } from "loggily"
import { findBeadsDir } from "./config.ts"
import { createTimers } from "./timers.ts"
import type { TribePluginApi, TribeClientApi } from "./plugin-api.ts"

const log = createLogger("tribe:beads")

export const beadsPlugin: TribePluginApi = {
  name: "beads",

  available() {
    const beadsDir = findBeadsDir()
    if (!beadsDir) return false
    return existsSync(resolve(beadsDir, "backup/issues.jsonl"))
  },

  start(api: TribeClientApi) {
    const beadsDir = findBeadsDir()
    if (!beadsDir) return
    const issuesPath = resolve(beadsDir, "backup/issues.jsonl")
    if (!existsSync(issuesPath)) return

    const ac = new AbortController()
    const timers = createTimers(ac.signal)

    let lastMtime = 0
    const reportedStates = new Map<string, string>()

    // Snapshot current state — on startup, mark every existing bead with its
    // current status so we don't broadcast historical transitions. (When the
    // plugin becomes an out-of-process observer, it no longer has any notion
    // of "my claims" — the daemon/daemon_observer simply ignores initial state.)
    try {
      lastMtime = statSync(issuesPath).mtimeMs
      for (const line of readFileSync(issuesPath, "utf8").split("\n").filter(Boolean)) {
        try {
          const entry = JSON.parse(line) as { id?: string; status?: string; claimed_by?: string }
          if (!entry.id) continue
          if (entry.claimed_by) {
            reportedStates.set(entry.id, `claimed:${entry.claimed_by}`)
          } else {
            reportedStates.set(entry.id, entry.status ?? "open")
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

            // Broadcast all bead state transitions
            if (!prevState) {
              // New bead
              if (api.claimDedup(`new:${entry.id}`)) {
                api.broadcast(
                  `New bead: ${entry.id} — ${entry.title} (${entry.priority ?? "?"})`,
                  "bead:new",
                  entry.id,
                )
              }
            } else if (currentState.startsWith("claimed:")) {
              if (api.claimDedup(`claimed:${entry.id}`)) {
                const actor = entry.claimed_by ?? ""
                api.broadcast(`Claimed: ${entry.id} — ${entry.title} [by:${actor}]`, "bead:claimed", entry.id)
              }
            } else if (entry.status === "closed") {
              if (api.claimDedup(`closed:${entry.id}`)) {
                api.broadcast(`Closed: ${entry.id} — ${entry.title}`, "bead:closed", entry.id)
              }
            } else if (entry.status === "in_progress") {
              if (api.claimDedup(`progress:${entry.id}`)) {
                api.broadcast(`In progress: ${entry.id} — ${entry.title}`, "bead:progress", entry.id)
              }
            } else {
              // Status change (open, deferred, etc.)
              if (api.claimDedup(`status:${entry.id}:${entry.status}`)) {
                api.broadcast(`Bead ${entry.id} → ${entry.status}`, "bead:status", entry.id)
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
