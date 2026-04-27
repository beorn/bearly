/**
 * withLore — initialise the lore (memory + recall) handlers.
 *
 * Lore was a separate daemon until April 2026; absorbed into tribe-daemon as
 * in-process handlers. Each lore handler runs synchronously on the same event
 * loop. The lore DB is opened here and closed via the root scope.
 */

import { createLoreHandlers, type LoreHandlers } from "../lore-handlers.ts"
import type { BaseTribe } from "./base.ts"
import type { WithConfig } from "./with-config.ts"

export interface WithLore {
  /** null when --no-lore is set (or TRIBE_NO_LORE in env). */
  readonly lore: LoreHandlers | null
}

export function withLore<T extends BaseTribe & WithConfig>(): (t: T) => T & WithLore {
  return (t) => {
    if (!t.config.loreEnabled) return { ...t, lore: null }

    const lore = createLoreHandlers({
      dbPath: t.config.loreDbPath,
      socketPath: t.config.socketPath,
      daemonVersion: t.daemonVersion,
      focusPollMs: t.config.focusPollMs,
      summaryPollMs: t.config.summaryPollMs,
      summarizerMode: t.config.summarizerMode,
      // Pass the scope's signal so lore aborts on shutdown.
      signal: t.scope.signal,
    })

    // Belt-and-braces: register an explicit close on the scope too. close() is
    // idempotent (gated by an internal `closed` flag) so the signal-driven
    // path and this defer-driven path are safe to coexist.
    t.scope.defer(() => lore.close())

    return { ...t, lore }
  }
}
