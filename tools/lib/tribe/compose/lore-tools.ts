/**
 * loreTools() — protocol-agnostic ToolDef array for the lore (memory + recall)
 * RPC surface (tribe.ask / brief / plan / session_register / session_heartbeat
 * / sessions_list / workspace_state / session_state / inject_delta / status /
 * hello).
 *
 * The lore handlers expose a clean `dispatch(conn, method, params)` shape from
 * day one. This wrapper exposes each method as a registry tool so the same
 * surface (MCP server, raw JSON-RPC, future protocols) reaches them through
 * the registry rather than the special-case `loreHandlers.dispatch` path
 * tribe-daemon's handleRequest had before.
 */

import type { Tool, ToolContext } from "@bearly/tribe-client"
import { TRIBE_METHODS } from "../../../../plugins/tribe/lore/lib/rpc.ts"
import type { LoreConnState, LoreHandlers } from "../lore-handlers.ts"

export interface LoreToolExtra {
  /** Per-connection lore state (sessionId / claudePid). */
  conn: LoreConnState
}

const LORE_METHOD_NAMES = Object.values(TRIBE_METHODS) as readonly string[]

export function loreTools(lore: LoreHandlers): Tool[] {
  return LORE_METHOD_NAMES.map((name) => ({
    name,
    handler: async (args, ctx: ToolContext) => {
      const extra = ctx.extra as LoreToolExtra | undefined
      const conn: LoreConnState = extra?.conn ?? { sessionId: null, claudePid: null }
      return lore.dispatch(conn, name, args)
    },
  }))
}
