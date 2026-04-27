/**
 * withPlugin — register a single observer plugin.
 *
 * Wraps the existing `TribePluginApi.start(api) → cleanup` shape into a
 * Scope-cascading withX. The plugin is `start`ed once at composition time
 * (after `withPluginApi` has installed the `pluginApi` field) and its cleanup
 * is `defer`-ed on the daemon's root scope.
 *
 * `withPlugins(plugins)` is the bulk variant — pipes through one `withPlugin`
 * per plugin, preserving registration order so the plugin handle list reads
 * top-to-bottom in the factory.
 */

import { createLogger } from "loggily"
import type { TribePluginApi, TribePluginHandle } from "../plugin-api.ts"
import type { BaseTribe } from "./base.ts"
import type { WithPluginApi } from "./with-plugin-api.ts"

const log = createLogger("tribe:plugins")

export interface WithPlugins {
  /** Cumulative list of plugins seen by the pipe (active or skipped). */
  readonly pluginHandles: TribePluginHandle[]
}

function ensurePluginsField<T extends BaseTribe & WithPluginApi>(t: T): T & WithPlugins {
  if ("pluginHandles" in t && Array.isArray((t as unknown as WithPlugins).pluginHandles)) {
    return t as T & WithPlugins
  }
  return { ...t, pluginHandles: [] }
}

export function withPlugin<T extends BaseTribe & WithPluginApi>(
  plugin: TribePluginApi,
): (t: T) => T & WithPlugins {
  return (raw) => {
    const t = ensurePluginsField(raw)
    const isAvailable = plugin.available()
    const handle: TribePluginHandle = { name: plugin.name, active: isAvailable }
    if (!isAvailable) {
      log.info?.(`plugin ${plugin.name}: not available (skipped)`)
      return { ...t, pluginHandles: [...t.pluginHandles, handle] }
    }
    log.info?.(`plugin ${plugin.name}: active`)
    const cleanup = plugin.start(t.pluginApi)
    if (cleanup) t.scope.defer(cleanup)
    return { ...t, pluginHandles: [...t.pluginHandles, handle] }
  }
}

/** Bulk helper — pipes through one withPlugin per entry in registration order. */
export function withPlugins<T extends BaseTribe & WithPluginApi>(
  plugins: TribePluginApi[],
): (t: T) => T & WithPlugins {
  return (raw) => {
    let v = ensurePluginsField(raw) as T & WithPlugins
    for (const p of plugins) {
      v = withPlugin<T>(p)(v as unknown as T) as unknown as T & WithPlugins
    }
    return v
  }
}
