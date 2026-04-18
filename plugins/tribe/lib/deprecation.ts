/**
 * MCP tool rename deprecation shim.
 *
 * Phase 2 of system-unification moves every tribe MCP tool under the
 * `tribe.*` namespace:
 *
 *   lore.ask          -> tribe.ask
 *   lore.current_brief -> tribe.brief
 *   tribe_send        -> tribe.send
 *   tribe_broadcast   -> tribe.broadcast
 *   ...
 *
 * Old names still work for one release cycle. Calling an old name logs a
 * single deprecation warning per process + dispatches to the new handler.
 * Removal scheduled for @bearly/tribe 0.10.
 */

export const TRIBE_TOOL_RENAMES: ReadonlyArray<readonly [newName: string, oldName: string]> = [
  // lore.* -> tribe.*
  ["tribe.ask", "lore.ask"],
  ["tribe.brief", "lore.current_brief"],
  ["tribe.plan", "lore.plan_only"],
  ["tribe.session", "lore.session_state"],
  ["tribe.workspace", "lore.workspace_state"],
  ["tribe.inject_delta", "lore.inject_delta"],
  // tribe_* -> tribe.*
  ["tribe.send", "tribe_send"],
  ["tribe.broadcast", "tribe_broadcast"],
  ["tribe.members", "tribe_sessions"],
  ["tribe.history", "tribe_history"],
  ["tribe.rename", "tribe_rename"],
  ["tribe.health", "tribe_health"],
  ["tribe.join", "tribe_join"],
  ["tribe.reload", "tribe_reload"],
  ["tribe.retro", "tribe_retro"],
  ["tribe.leadership", "tribe_leadership"],
]

/** O(1) old-name -> new-name lookup. */
const OLD_TO_NEW: ReadonlyMap<string, string> = new Map(
  TRIBE_TOOL_RENAMES.map(([nu, old]) => [old, nu]),
)

/** O(1) new-name -> old-name lookup (for tools-list alias emission). */
const NEW_TO_OLD: ReadonlyMap<string, string> = new Map(
  TRIBE_TOOL_RENAMES.map(([nu, old]) => [nu, old]),
)

/** Module-level: warn at most once per old name per process. */
const warned = new Set<string>()

/** Removal target — keep in sync with CHANGELOG. */
export const TRIBE_DEPRECATION_REMOVAL_VERSION = "0.10"

/**
 * Normalize an incoming MCP tool name to its canonical (new) form.
 *
 * If the incoming name is a deprecated alias, logs a one-time stderr warning
 * and returns the new name. Otherwise returns the name unchanged.
 */
export function normalizeToolName(name: string): string {
  const nu = OLD_TO_NEW.get(name)
  if (nu === undefined) return name
  if (!warned.has(name)) {
    warned.add(name)
    process.stderr.write(
      `[deprecated] MCP tool '${name}' is now '${nu}' — old name will be removed in @bearly/tribe ${TRIBE_DEPRECATION_REMOVAL_VERSION}\n`,
    )
  }
  return nu
}

/** Return the deprecated alias for a canonical name, or undefined. */
export function getDeprecatedAlias(newName: string): string | undefined {
  return NEW_TO_OLD.get(newName)
}

/**
 * Given a list of tools keyed by new (`tribe.*`) names, return a parallel
 * list of tools for each deprecated alias. Callers concat the two to emit
 * both surfaces in ListToolsResult.
 */
export function buildDeprecatedAliasTools<T extends { name: string; description?: string }>(
  baseTools: readonly T[],
): T[] {
  const aliases: T[] = []
  for (const tool of baseTools) {
    const oldName = NEW_TO_OLD.get(tool.name)
    if (!oldName) continue
    aliases.push({
      ...tool,
      name: oldName,
      description: `[deprecated alias of ${tool.name}] ${tool.description ?? ""}`.trim(),
    })
  }
  return aliases
}

/** Test-only: reset the per-process warn set. */
export function __resetDeprecationWarnings(): void {
  warned.clear()
}
