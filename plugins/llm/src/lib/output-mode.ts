/**
 * @deprecated — use `createDispatchContext()` from `./context.ts` and pass
 * the context object explicitly through the dispatch chain. This shim
 * remains so that `cli.ts`, library callers, and existing tests keep
 * working during the migration; new code should not import from here.
 *
 * The shim mutates a process-level singleton (`_defaultCtx` in context.ts).
 * That singleton is the same anti-pattern this module documents — it is
 * not safe across parallel test workers or library embedding. The whole
 * point of the v0.8.0 migration is to replace it; this file just lets us
 * do that without a giant flag-day.
 *
 * Original (legacy) docs preserved below for callers that still grep here.
 *
 * Why this exists: skills (.claude/skills/{pro,deep,ask}) used to regex
 * stderr or scrape the trailing JSON line on stdout to find the output
 * file path and metadata. Both are fragile — format drift breaks
 * parsing. The `--json` flag locks the contract:
 *
 *   - JSON mode (`--json`):
 *       - stdout: exactly ONE JSON line (the result envelope)
 *       - stderr: all human-readable progress, prompts, errors
 *
 *   - Default mode:
 *       - stdout: result content + the same JSON envelope (legacy
 *                 behavior; backward-compatible with existing scripts
 *                 that grep/regex stderr or read both streams)
 *       - stderr: progress + path line
 */

import {
  createDispatchContext,
  _setDefaultDispatchContext,
  _getDefaultDispatchContext,
} from "./context"

/**
 * @deprecated Pass `DispatchContext` through dispatch chain instead.
 * Enables JSON output mode on the global default context.
 */
export function setJsonMode(value: boolean): void {
  _setDefaultDispatchContext(createDispatchContext({ jsonMode: value }))
}

/** @deprecated Read `ctx.jsonMode` from a passed-in DispatchContext instead. */
export function isJsonMode(): boolean {
  return _getDefaultDispatchContext().jsonMode
}

/** @deprecated Construct a fresh DispatchContext per test instead. */
export function resetOutputMode(): void {
  _setDefaultDispatchContext(createDispatchContext({ jsonMode: false }))
}

/** @deprecated Use `ctx.emit(envelope)` from a passed-in DispatchContext. */
export function emitJson(envelope: Record<string, unknown>): void {
  _getDefaultDispatchContext().emit(envelope)
}

/** @deprecated Use `ctx.content(text)` from a passed-in DispatchContext. */
export function emitContent(content: string): void {
  _getDefaultDispatchContext().content(content)
}
