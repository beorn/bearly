/**
 * messagingTools() — protocol-agnostic ToolDef array for the tribe.* coord
 * methods (send, broadcast, members, history, rename, join, health, reload,
 * retro, chief, claim-chief, release-chief, debug).
 *
 * Each tool wraps the existing `handleToolCall` from `handlers.ts`, which
 * already uses a clean `(ctx, name, args, opts) → result` shape. The point of
 * this layer is registry-shape uniformity — every surface (MCP, raw JSON-RPC,
 * future protocols) calls `tool.handler(args, ctx)` and gets the same answer.
 *
 * Coordination methods (chief lease, claim, release) ARE messaging tools per
 * `hub/architecture.md` § "Component reference" — there is no separate
 * coordinationTools family.
 */

import type { Tool, ToolContext } from "@bearly/tribe-client"
import { handleToolCall, TRIBE_COORD_METHODS, type HandlerOpts } from "../handlers.ts"
import type { TribeContext } from "../context.ts"

/** Per-call extras the messaging surface needs to bridge the handler call. */
export interface MessagingToolExtra {
  /** The caller's TribeContext (defaults to the daemon's own ctx for daemon-side calls). */
  ctx: TribeContext
  /** Daemon-side handler options (chief accessors, debug snapshot, etc.). */
  opts: HandlerOpts
}

function bindHandler(method: string): Tool["handler"] {
  return async (args, ctx: ToolContext) => {
    const extra = ctx.extra as MessagingToolExtra | undefined
    if (!extra) {
      throw new Error(`messaging tool "${method}" called without ctx.extra (need TribeContext + HandlerOpts)`)
    }
    return handleToolCall(extra.ctx, method, args, extra.opts)
  }
}

/** Stable name for the tool family — used by surfaces to introspect/group. */
export const MESSAGING_TOOL_NAMES = Object.values(TRIBE_COORD_METHODS) as readonly string[]

export function messagingTools(): Tool[] {
  return MESSAGING_TOOL_NAMES.map((name) => ({
    name,
    handler: bindHandler(name),
  }))
}
