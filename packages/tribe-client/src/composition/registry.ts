/**
 * Tool registry — protocol-agnostic callables on the daemon value.
 *
 * A `Tool` is `{ name, schema, handler }`. The registry is a plain `Map<string, Tool>`
 * established by `withTools()` and populated by `withTool(...)`. Surfaces (MCP,
 * raw JSON-RPC, future protocols) consume the registry without re-implementing
 * handlers.
 *
 * The schema field is intentionally typed as `unknown` so callers can plug in
 * Zod, JSON Schema, Standard Schema, or a hand-rolled type guard — the
 * registry doesn't enforce a particular validation library.
 */

export type ToolHandler<Args = Record<string, unknown>, Result = unknown> = (
  args: Args,
  ctx: ToolContext,
) => Result | Promise<Result>

export interface ToolContext {
  /** Connection identifier. Surfaces fill this in per-call. */
  readonly connId?: string
  /** Free-form per-call extras (lore conn state, MCP transport metadata, etc.) */
  readonly extra?: Record<string, unknown>
}

export interface Tool<Args = Record<string, unknown>, Result = unknown> {
  readonly name: string
  /** Optional schema — the registry doesn't interpret it; surfaces may. */
  readonly schema?: unknown
  /** Optional human-readable description (surfaced over MCP, etc.). */
  readonly description?: string
  readonly handler: ToolHandler<Args, Result>
}

/** Plain data — `withTools()` puts this on the daemon value. */
export type ToolRegistry = Map<string, Tool>

export interface WithTools {
  readonly tools: ToolRegistry
}

/** Establish the registry slot on the daemon value. */
export function withTools<T>(): (t: T) => T & WithTools {
  return (t) => ({ ...t, tools: new Map<string, Tool>() })
}

/** Append a tool (or array of tools) to the registry. */
export function withTool<T extends WithTools>(tool: Tool | Tool[]): (t: T) => T {
  return (t) => {
    const tools = Array.isArray(tool) ? tool : [tool]
    for (const x of tools) {
      if (t.tools.has(x.name)) {
        throw new Error(`Tool "${x.name}" already registered`)
      }
      t.tools.set(x.name, x)
    }
    return t
  }
}
