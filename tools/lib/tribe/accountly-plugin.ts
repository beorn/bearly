/**
 * Tribe plugin: Accountly — monitors Claude Max subscription quotas and
 * auto-switches accounts when utilization exceeds thresholds.
 *
 * Warns when accounts need re-login (unavailable).
 *
 * Adaptive polling: checks less frequently when utilization is low,
 * more frequently as it approaches the threshold.
 *
 * Config via env vars:
 *   ACCOUNTLY_THRESHOLD_5HOUR   — 5-hour window % trigger (default: 95)
 *   ACCOUNTLY_THRESHOLD_7DAY    — 7-day window % trigger (default: 98)
 *   ACCOUNTLY_THRESHOLD_MONTHLY — monthly window % trigger (default: 95)
 */

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { createLogger } from "loggily"
import { createTimers } from "./timers.ts"
import type { TribePlugin, PluginContext } from "./plugins.ts"

const log = createLogger("tribe:accountly")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AccountlyThresholds {
  fiveHour: number
  sevenDay: number
  monthly: number
}

export interface AccountlyQuota {
  accountName: string
  provider: string
  available: boolean
  windows: Array<{ name: string; utilization: number; resetsAt?: string }>
  error?: string
}

export interface AccountlyStatus {
  active: string | undefined
  quotas: AccountlyQuota[]
}

// ---------------------------------------------------------------------------
// Pure functions (exported for testing)
// ---------------------------------------------------------------------------

export function getThresholds(): AccountlyThresholds {
  return {
    fiveHour: Number(process.env.ACCOUNTLY_THRESHOLD_5HOUR) || 95,
    sevenDay: Number(process.env.ACCOUNTLY_THRESHOLD_7DAY) || 98,
    monthly: Number(process.env.ACCOUNTLY_THRESHOLD_MONTHLY) || 95,
  }
}

/** Map a window name to its configured threshold */
export function getWindowThreshold(windowName: string, thresholds: AccountlyThresholds): number | undefined {
  const name = windowName.toLowerCase()
  if (name.includes("5-hour") || name.includes("5hour")) return thresholds.fiveHour
  if (name.includes("7-day") || name.includes("7day") || name.includes("weekly")) return thresholds.sevenDay
  if (name.includes("month")) return thresholds.monthly
  return undefined
}

/** Check if active account exceeds any window threshold */
export function shouldSwitch(
  status: AccountlyStatus,
  thresholds: AccountlyThresholds,
): { switch: boolean; reason?: string } {
  if (!status.active) return { switch: false }

  const activeQuota = status.quotas.find((q) => q.accountName === status.active)
  if (!activeQuota) return { switch: false }
  if (activeQuota.error) return { switch: false }

  for (const window of activeQuota.windows) {
    const threshold = getWindowThreshold(window.name, thresholds)
    if (threshold !== undefined && window.utilization >= threshold) {
      return {
        switch: true,
        reason: `${status.active}: ${window.name} at ${Math.round(window.utilization)}% (threshold: ${threshold}%)`,
      }
    }
  }

  return { switch: false }
}

/** Find accounts that are unavailable (need re-login or have errors) */
export function findUnavailable(status: AccountlyStatus): Array<{ name: string; error: string }> {
  return status.quotas
    .filter((q) => q.error || !q.available)
    .map((q) => ({ name: q.accountName, error: q.error ?? "unavailable — may need re-login" }))
}

/**
 * Adaptive poll interval based on how close the active account is to its threshold.
 * Polls less when far away, more when approaching the limit.
 * Minimum 60s to avoid rate-limiting the usage API (3 accounts = 3 calls per poll).
 */
export function computePollInterval(maxUtilization: number): number {
  if (maxUtilization >= 90) return 60_000 // 1 min — close to threshold
  if (maxUtilization >= 70) return 180_000 // 3 min
  if (maxUtilization >= 50) return 300_000 // 5 min
  return 600_000 // 10 min — plenty of headroom
}

/** Get the max utilization across all windows for the active account */
export function getActiveMaxUtilization(status: AccountlyStatus): number {
  if (!status.active) return 0
  const activeQuota = status.quotas.find((q) => q.accountName === status.active)
  if (!activeQuota || activeQuota.error) return 0
  if (activeQuota.windows.length === 0) return 0
  return Math.max(...activeQuota.windows.map((w) => w.utilization))
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function accountlyPlugin(): TribePlugin {
  const configPath = resolve(homedir(), ".config/accountly/accounts.json")

  return {
    name: "accountly",

    available() {
      return existsSync(configPath)
    },

    start(ctx) {
      const ac = new AbortController()
      const timers = createTimers(ac.signal)
      const thresholds = getThresholds()
      const warnedUnavailable = new Set<string>()
      let lastSwitchTime = 0
      let lastErrorMessage = ""
      let lastErrorLoggedAt = 0
      const SWITCH_COOLDOWN = 300_000 // 5 min
      let backoffUntil = 0 // 429 backoff timestamp
      let consecutive429s = 0
      let lastStatusKey = "" // track state changes to avoid repeat broadcasts

      const check = async () => {
        let nextInterval = 300_000 // default: 5 min

        // Respect 429 backoff
        if (Date.now() < backoffUntil) {
          const remaining = Math.ceil((backoffUntil - Date.now()) / 1000)
          log.info?.(`429 backoff: ${remaining}s remaining`)
          return Math.min(backoffUntil - Date.now() + 5_000, 600_000)
        }

        try {
          const cliPath = resolve(process.cwd(), "vendor/accountly/src/cli.ts")
          if (!existsSync(cliPath)) {
            if (ctx.claimDedup("accountly:cli-missing")) {
              ctx.sendMessage("*", "accountly plugin: CLI not found, auto-rotation disabled", "health:account:error")
            }
            return nextInterval
          }

          // Check quotas via accountly CLI
          const proc = Bun.spawn(["bun", cliPath, "status", "--json"], {
            cwd: process.cwd(),
            stdout: "pipe",
            stderr: "pipe",
          })
          const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ])
          await proc.exited

          if (proc.exitCode !== 0) {
            log.warn?.(`accountly status failed (exit ${proc.exitCode}): ${stderr.trim().slice(0, 200)}`)
            return nextInterval
          }

          let status: AccountlyStatus
          try {
            status = JSON.parse(stdout) as AccountlyStatus
          } catch {
            log.warn?.(`accountly status: invalid JSON output`)
            return nextInterval
          }

          // Defensive null-check: accountly CLI output has been seen with a
          // missing or non-array `quotas` field (e.g., error envelopes, partial
          // init). Before this guard every call was crashing with
          // "TypeError: status.quotas.filter is not a function" and spamming
          // the daemon warnings channel every HEALTH_POLL_INTERVAL seconds.
          // See km-tribe.reliability-sweep-0415.
          if (!Array.isArray(status.quotas)) {
            log.debug?.(`accountly status missing quotas array — skipping cycle`)
            return nextInterval
          }

          // Broadcast status only on state change (active account, healthy count, or utilization band)
          const oauthAccounts = status.quotas.filter((q) => q.provider === "claude-oauth")
          const healthy = oauthAccounts.filter((q) => !q.error).length
          const maxUtil = getActiveMaxUtilization(status)
          const utilBand = Math.floor(maxUtil / 10) * 10 // group by 10% bands
          const statusKey = `${status.active}:${healthy}/${oauthAccounts.length}:${utilBand}`
          if (statusKey !== lastStatusKey && ctx.claimDedup(`accountly:status:${statusKey}`)) {
            lastStatusKey = statusKey
            ctx.sendMessage(
              "*",
              `accountly: ${oauthAccounts.length} accounts (${healthy} healthy), active=${status.active ?? "none"}, util=${Math.round(maxUtil)}%`,
              "health:account:status",
            )
          }

          // Detect 429 rate-limiting on the usage API
          const all429 = status.quotas
            .filter((q) => q.provider === "claude-oauth")
            .every((q) => q.error?.includes("429"))
          if (all429 && status.quotas.some((q) => q.provider === "claude-oauth")) {
            consecutive429s++
            // Exponential backoff: 2min, 4min, 8min, max 10min
            const backoffMs = Math.min(120_000 * Math.pow(2, consecutive429s - 1), 600_000)
            backoffUntil = Date.now() + backoffMs
            log.debug?.(`usage API rate-limited (429), backing off ${Math.round(backoffMs / 1000)}s`)
            if (consecutive429s === 1) {
              ctx.sendMessage(
                "*",
                `accountly: usage API rate-limited (429), backing off ${Math.round(backoffMs / 1000)}s`,
                "health:account:error",
              )
            }
            return backoffMs
          }
          consecutive429s = 0

          // Adaptive interval based on current utilization
          nextInterval = computePollInterval(maxUtil)

          // Warn about unavailable accounts (skip 429 errors — those are transient)
          const unavailable = findUnavailable(status).filter((u) => !u.error.includes("429"))
          for (const { name, error } of unavailable) {
            if (!warnedUnavailable.has(name)) {
              warnedUnavailable.add(name)
              if (ctx.claimDedup(`accountly:unavailable:${name}`)) {
                ctx.sendMessage(
                  "chief",
                  `Account "${name}" needs attention: ${error}. Run: /login then bun accountly import`,
                  "health:account:unavailable",
                )
              }
            }
          }
          // Clear warnings for recovered accounts
          for (const warned of warnedUnavailable) {
            if (!unavailable.some((u) => u.name === warned)) {
              warnedUnavailable.delete(warned)
            }
          }

          // Check if auto-switch needed
          const decision = shouldSwitch(status, thresholds)
          if (!decision.switch) return nextInterval

          // Cooldown check
          if (Date.now() - lastSwitchTime < SWITCH_COOLDOWN) {
            log.info?.(`switch needed but cooldown active: ${decision.reason}`)
            return nextInterval
          }

          log.info?.(`auto-switching: ${decision.reason}`)
          const autoProc = Bun.spawn(["bun", cliPath, "auto"], {
            cwd: process.cwd(),
            stdout: "pipe",
            stderr: "pipe",
          })
          const [autoOut, autoErr] = await Promise.all([
            new Response(autoProc.stdout).text(),
            new Response(autoProc.stderr).text(),
          ])
          await autoProc.exited

          if (autoProc.exitCode === 0) {
            lastSwitchTime = Date.now()
            ctx.sendMessage("*", `Auto-switched account — ${decision.reason}`, "health:account:switched")
          } else {
            ctx.sendMessage(
              "chief",
              `Switch needed (${decision.reason}) but failed: ${(autoErr || autoOut).trim().slice(0, 200)}`,
              "health:account:error",
            )
          }
        } catch (err) {
          // Rate-limit: only log once per unique error message per 10 minutes.
          // Previously this fired every poll (~5 min), flooding the warnings
          // channel with the same TypeError. See km-tribe.reliability-sweep-0415.
          const msg = err instanceof Error ? err.message : String(err)
          const now = Date.now()
          if (msg !== lastErrorMessage || now - lastErrorLoggedAt > 10 * 60_000) {
            log.warn?.(`accountly plugin error: ${msg}`)
            lastErrorMessage = msg
            lastErrorLoggedAt = now
          }
        }

        return nextInterval
      }

      // Recursive setTimeout for adaptive polling
      const schedule = () => {
        timers.setTimeout(async () => {
          const interval = await check()
          schedule.interval = interval
          schedule()
        }, schedule.interval)
      }
      schedule.interval = 120_000 // initial check after 2 min (gentler startup)
      schedule()

      return () => ac.abort()
    },

    instructions() {
      const t = getThresholds()
      return `- Account auto-rotation active: switches when 5h>${t.fiveHour}% or 7d>${t.sevenDay}% or month>${t.monthly}%`
    },
  }
}
