/**
 * Tribe plugin: Git commit auto-reporter.
 *
 * Polls `git log -1` every 30s and broadcasts a status message when HEAD
 * advances. Uses claimDedup so multiple plugin instances (or a restarted
 * daemon) don't re-broadcast the same commit.
 */

import { execSync } from "node:child_process"
import { createLogger } from "loggily"
import { createTimers } from "./timers.ts"
import type { TribePluginApi, TribeClientApi } from "./plugin-api.ts"

const log = createLogger("tribe:git")

export const gitPlugin: TribePluginApi = {
  name: "git",

  available() {
    try {
      execSync("git rev-parse HEAD", { cwd: process.cwd(), encoding: "utf8" })
      return true
    } catch {
      return false
    }
  },

  start(api: TribeClientApi) {
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
          // Atomic dedup: first observer to claim this commit hash wins
          if (api.claimDedup(`commit:${head}`)) {
            // km-tribe.event-classification: commits are ambient — informational
            // for the tribe but no agent needs to react. Land in inbox only.
            api.broadcast(`Committed: ${line}`, "status", undefined, {
              delivery: "pull",
              responseExpected: "no",
              pluginKind: "git:commit",
            })
          }
          // Hot-reload on tribe code changes is handled by the daemon's own
          // source watcher (tribe-daemon.ts — onSourceChange). No explicit
          // trigger needed from plugins.
        }
        if (head) lastHead = head
      } catch (err) {
        log.error?.(`git poll error: ${err instanceof Error ? err.message : err}`)
      }
    }, 30_000)

    return () => ac.abort()
  },
}
