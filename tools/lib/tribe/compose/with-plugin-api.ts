/**
 * withPluginApi — install the `pluginApi` field on the daemon value so
 * `withPlugin(...)` factories can wire observers to the wire.
 *
 * The api is a strict subset of what an out-of-process tribe client gets over
 * the Unix socket: send / broadcast / claimDedup / hasRecentMessage /
 * getActiveSessions / getSessionNames / hasChief. No DB or clients-map access.
 *
 * Today's implementation is a thin factory that takes pre-built closures from
 * `runtime.ts` (the imperative half of the daemon owns clients-map + chief).
 * Once the runtime decomposes into TEA, the closures get replaced by direct
 * derivations — but the registry-shape API the plugin sees doesn't change.
 */

import type { TribeClientApi } from "../plugin-api.ts"
import type { BaseTribe } from "./base.ts"

export interface WithPluginApi {
  readonly pluginApi: TribeClientApi
}

export function withPluginApi<T extends BaseTribe>(api: TribeClientApi): (t: T) => T & WithPluginApi {
  return (t) => ({ ...t, pluginApi: api })
}
