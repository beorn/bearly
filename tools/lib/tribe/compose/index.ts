/**
 * Tribe-daemon composition layer — `pipe + with*` factories that build the
 * daemon value top-down. Pairs with `@bearly/daemon-spine`'s `pipe`, `Scope`,
 * and tool-registry primitives.
 *
 * Reading order matches the runtime topology in `hub/architecture.md` § "Tribe
 * — the runtime topology":
 *
 *   createBaseTribe → withConfig → withProjectRoot → withDatabase
 *     → withDaemonContext → withLore → withTools → withTool(messagingTools())
 *     → withTool(loreTools(lore)) → withPluginApi → withPlugin(...)
 *
 * Each `withX` accepts a value extending its prerequisites (the type system
 * enforces order) and registers cleanup on the daemon's root `Scope`.
 *
 * Future surfaces (raw JSON-RPC, REST, hypothetical agent protocols) consume
 * the same `tools` registry — no per-surface re-implementation.
 */

export { createBaseTribe } from "./base.ts"
export type { BaseTribe, CreateBaseTribeOpts } from "./base.ts"

export { withConfig } from "./with-config.ts"
export type { ConfigOpts, TribeConfig, WithConfig } from "./with-config.ts"

export { withProjectRoot } from "./with-project-root.ts"
export type { WithProjectRoot } from "./with-project-root.ts"

export { withDatabase } from "./with-database.ts"
export type { WithDatabase } from "./with-database.ts"

export { withDaemonContext } from "./with-daemon-context.ts"
export type { WithDaemonContext } from "./with-daemon-context.ts"

export { withLore } from "./with-lore.ts"
export type { WithLore } from "./with-lore.ts"

export { messagingTools, MESSAGING_TOOL_NAMES } from "./messaging-tools.ts"
export type { MessagingToolExtra } from "./messaging-tools.ts"

export { loreTools } from "./lore-tools.ts"
export type { LoreToolExtra } from "./lore-tools.ts"

export { withPluginApi } from "./with-plugin-api.ts"
export type { WithPluginApi } from "./with-plugin-api.ts"

export { withPlugin, withPlugins } from "./with-plugin.ts"
export type { WithPlugins } from "./with-plugin.ts"

export { withClientRegistry } from "./with-client-registry.ts"
export type { ClientRegistry, ClientSession, WithClientRegistry } from "./with-client-registry.ts"

export { withBroadcast } from "./with-broadcast.ts"
export type { Broadcast, WithBroadcast } from "./with-broadcast.ts"

export { withSocketServer, probeAndCleanSocket } from "./with-socket-server.ts"
export type { SocketServer, WithSocketServer } from "./with-socket-server.ts"

export { withDispatcher } from "./with-dispatcher.ts"
export type { Dispatcher, DispatcherRuntimeHooks, WithDispatcher } from "./with-dispatcher.ts"
