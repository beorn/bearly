/**
 * withIdleQuit — connection-as-lease idle timer.
 *
 * Liveness is a pure function of current state, not an event-driven timer:
 *
 *   - markActive() — clear the deadline (someone is using us)
 *   - markIdle()   — set the deadline (we may be done; checkLiveness decides)
 *   - checkLiveness() — runs from a 1s tick. Also expires stale pending
 *     sessions that never sent a register message (60s grace window).
 *
 * On `quitTimeoutSec < 0` the timer never fires (TRIBE_QUIT_TIMEOUT=-1). On
 * `quitTimeoutSec === 0` the daemon shuts down immediately when the registry
 * empties.
 *
 * The factory takes:
 *   - `triggerShutdown()` — what to call when the idle deadline lapses.
 *   - `tickIntervalMs` (default 1000) — how often checkLiveness runs.
 *   - `pendingExpiryMs` (default 60000) — grace for half-registered sessions.
 *
 * Cleanup: clearInterval registered on root scope.
 */

import { createLogger } from "loggily"
import type { BaseTribe } from "./base.ts"
import type { WithClientRegistry } from "./with-client-registry.ts"
import type { WithConfig } from "./with-config.ts"

const log = createLogger("tribe:idle-quit")

export interface IdleQuitOpts {
  /** Called when the idle deadline lapses. Wired to the daemon's shutdown(). */
  triggerShutdown: () => void
  /** Tick interval — how often to evaluate liveness. Default 1000ms. */
  tickIntervalMs?: number
  /** Grace window for stale pending sessions. Default 60000ms. */
  pendingExpiryMs?: number
}

export interface IdleQuit {
  markActive(): void
  markIdle(): void
  /** Currently scheduled deadline (ms epoch) or null when active. Tests inspect this. */
  getDeadline(): number | null
}

export interface WithIdleQuit {
  readonly idleQuit: IdleQuit
}

export function withIdleQuit<T extends BaseTribe & WithConfig & WithClientRegistry>(
  opts: IdleQuitOpts,
): (t: T) => T & WithIdleQuit {
  return (t) => {
    const quitTimeoutSec = t.config.quitTimeoutSec
    const tickIntervalMs = opts.tickIntervalMs ?? 1000
    const pendingExpiryMs = opts.pendingExpiryMs ?? 60_000
    const { clients, socketToClient } = t.registry

    let idleDeadline: number | null = null

    function markActive(): void {
      idleDeadline = null
    }

    function markIdle(): void {
      if (quitTimeoutSec < 0) return // -1 disables auto-quit
      if (idleDeadline !== null) return // already counting down
      idleDeadline = Date.now() + quitTimeoutSec * 1000
      log.info?.(`No clients connected. Auto-quit in ${quitTimeoutSec}s...`)
    }

    function checkLiveness(): void {
      const now = Date.now()
      // Expire pending sessions that never sent a register message
      for (const [connId, client] of clients) {
        if (client.role === "pending" && now - client.registeredAt > pendingExpiryMs) {
          log.info?.(
            `Expiring stale pending session: ${client.name} (age=${Math.floor((now - client.registeredAt) / 1000)}s)`,
          )
          clients.delete(connId)
          socketToClient.delete(client.socket)
          try {
            client.socket.destroy()
          } catch {
            /* already dead */
          }
        }
      }

      if (idleDeadline === null) return
      // Defensive: if a client snuck in, abort the countdown
      if (clients.size > 0) {
        idleDeadline = null
        return
      }
      if (now >= idleDeadline) {
        log.info?.("Auto-quit: idle deadline reached")
        opts.triggerShutdown()
      }
    }

    const interval = setInterval(checkLiveness, tickIntervalMs) as unknown as { unref?: () => void }
    interval.unref?.()
    t.scope.defer(() => clearInterval(interval as unknown as ReturnType<typeof setInterval>))

    // Begin idle countdown immediately. If a client connects before the
    // deadline, markActive() (called from withDispatcher's accept-handler)
    // clears it. This handles the case where a daemon is spawned but no client
    // ever connects (e.g. spawning test crashes).
    if (clients.size === 0) markIdle()

    return {
      ...t,
      idleQuit: { markActive, markIdle, getDeadline: () => idleDeadline },
    }
  }
}
