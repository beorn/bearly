/**
 * Tribe daemon boot — `pipe + with*` composition entry point.
 *
 * This is the structural skeleton that builds the daemon value top-down.
 * It uses the factory layer in `tools/lib/tribe/compose/` to assemble
 * everything that's cleanly decomposable (config, db, ctx, lore, tools,
 * pluginApi, plugins) and exposes seams for the still-imperative parts
 * of `tribe-daemon.ts` (socket server, JSON-RPC dispatcher, hot-reload,
 * idle-quit) to attach to.
 *
 * The reading order matches the architecture topology in
 * `hub/architecture.md` § "Tribe — the runtime topology":
 *
 *   project root
 *   └── tribe-daemon
 *       ├── config + db (filesystem boundary)
 *       ├── daemon ctx + lore handlers (in-process state)
 *       ├── tool registry — populated before surfaces
 *       │   ├── messaging tools (tribe.send / broadcast / members / …)
 *       │   └── lore tools (tribe.ask / brief / plan / …)
 *       ├── observer plugins (git, beads, github, health, accountly, dolt-reaper)
 *       └── runtime (socket server, dispatcher, hot-reload, idle quit, signals)
 *
 * Today the boot in `tribe-daemon.ts` runs as imperative module-level code.
 * This file shows the target shape; cutover to it as the entry point lands
 * in a follow-on bead (see `km-tribe.composition-pipe-boot-cutover`) once
 * the still-coupled imperative state (clients map, chiefClaim, broadcast
 * pipeline) has been refactored into withX factories of its own.
 *
 * The prototype is here so the pipe shape is reviewable as code, not just
 * design doc — and so callers building alternative daemon entry points
 * (test fixtures, embedded usage) can compose from the same primitives.
 */

import { pipe, withTool, withTools } from "@bearly/daemon-spine"
import { gitPlugin } from "./lib/tribe/git-plugin.ts"
import { beadsPlugin } from "./lib/tribe/beads-plugin.ts"
import { githubPlugin } from "./lib/tribe/github-plugin.ts"
import { healthMonitorPlugin } from "./lib/tribe/health-monitor-plugin.ts"
import { accountlyPlugin } from "./lib/tribe/accountly-plugin.ts"
import { doltReaperPlugin } from "./lib/tribe/dolt-reaper-plugin.ts"
import {
  createBaseTribe,
  loreTools,
  messagingTools,
  withConfig,
  withDaemonContext,
  withDatabase,
  withLore,
  withPlugins,
  withPluginApi,
  withProjectRoot,
  type TribeConfig,
} from "./lib/tribe/compose/index.ts"
import type { TribeClientApi } from "./lib/tribe/plugin-api.ts"

export interface BootTribeDaemonOpts {
  /** The `TribeClientApi` constructed from the still-imperative runtime state.
   *  Once the runtime is decomposed, this becomes another `withX` factory and
   *  this opt goes away. */
  pluginApi: TribeClientApi
  /** Disable observer plugins (TRIBE_NO_PLUGINS=1). */
  noPlugins?: boolean
  /** Skip CLI parseArgs and use this config (tests). */
  configOverride?: TribeConfig
}

/**
 * Build the tribe-daemon value via pipe(). Returns the fully-assembled value
 * for the caller to drive (start sockets, install dispatchers, await run loop).
 *
 * Construction order is enforced by types — try to call e.g. `withDatabase()`
 * without `withConfig()` upstream and TypeScript stops you. Cleanup cascades
 * through the daemon's root scope: closing it disposes db, lore, plugins,
 * and any other resources later `withX` factories defer.
 */
export function bootTribeDaemon(opts: BootTribeDaemonOpts) {
  const observerPlugins = opts.noPlugins
    ? []
    : [gitPlugin, beadsPlugin, githubPlugin, healthMonitorPlugin, accountlyPlugin, doltReaperPlugin]

  // The pipe IS the architecture. Each step extends the value with one
  // capability; cleanup registers on the shared scope. Reading top-to-bottom
  // tells the whole composition story without a separate boot doc.
  const tribe = pipe(
    createBaseTribe(),
    withConfig({ override: opts.configOverride }),
    withProjectRoot(),
    withDatabase(),
    withDaemonContext(),
    withLore(),
    withTools(),
    withTool(messagingTools()),
    withPluginApi(opts.pluginApi),
    withPlugins(observerPlugins),
  )

  // Add lore tools after lore is initialised — withTool() throws on duplicate
  // names, so we only call it when the registry doesn't already have them.
  if (tribe.lore) {
    for (const t of loreTools(tribe.lore)) {
      tribe.tools.set(t.name, t)
    }
  }

  return tribe
}

export type TribeDaemon = ReturnType<typeof bootTribeDaemon>
