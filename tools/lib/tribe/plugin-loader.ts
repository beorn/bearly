/**
 * Plugin loader — starts each available plugin with a shared TribeClientApi
 * and returns a combined stop function.
 *
 * Plugins that report `!available()` are skipped silently (dependency missing
 * — e.g. no .beads/, no gh auth, no accountly config).
 */

import { createLogger } from "loggily"
import type { TribePluginApi, TribeClientApi, TribePluginHandle } from "./plugin-api.ts"

const log = createLogger("tribe:plugins")

export interface LoadedPlugins {
  /** Plugin identity snapshot (for observability — e.g. /cli_status "resources"). */
  active: TribePluginHandle[]
  /** Stop every started plugin. */
  stop(): void
}

export function loadPlugins(plugins: TribePluginApi[], api: TribeClientApi): LoadedPlugins {
  const cleanups: Array<() => void> = []
  const active: TribePluginHandle[] = []

  for (const plugin of plugins) {
    const isAvailable = plugin.available()
    active.push({ name: plugin.name, active: isAvailable })
    if (!isAvailable) {
      log.info?.(`plugin ${plugin.name}: not available (skipped)`)
      continue
    }
    log.info?.(`plugin ${plugin.name}: active`)
    const cleanup = plugin.start(api)
    if (cleanup) cleanups.push(cleanup)
  }

  return {
    active,
    stop() {
      for (const fn of cleanups) fn()
    },
  }
}
