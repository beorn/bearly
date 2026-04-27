/**
 * Composition primitives — the structural layer of the daemon-spine stack.
 *
 * Exposes:
 *
 * - `pipe()` — left-to-right function composition (12 overloads).
 * - `Scope` / `createScope()` / `disposable()` — TC39-aligned structured-concurrency
 *   lifetime owner; mirrors `@silvery/scope` so tribe-daemon and silvery apps share
 *   the same lifecycle vocabulary.
 * - `Tool` / `ToolRegistry` / `withTools()` / `withTool()` — protocol-agnostic
 *   tool registry.
 *
 * See `hub/composition.md` for the full strategy.
 */

export type { Plugin } from "./pipe.ts"
export { pipe } from "./pipe.ts"

export { Scope, createScope, disposable } from "./scope.ts"

export type { Tool, ToolContext, ToolHandler, ToolRegistry, WithTools } from "./registry.ts"
export { withTool, withTools } from "./registry.ts"
