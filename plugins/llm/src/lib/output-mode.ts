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

import * as path from "node:path"
import { createDispatchContext, _setDefaultDispatchContext, _getDefaultDispatchContext } from "./context"

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

// --- Full-paths flag (km-bearly.llm-path-leakage) ---
//
// By default, the JSON envelope's `file` field is relativized to avoid
// leaking absolute /tmp paths (which carry username/hostname/project hashes
// embedded in /tmp paths) into CI logs and log aggregators (Splunk, Datadog).
// `--full-paths` opts back into the absolute path for users who want it
// (debugging, scripts that need to `cat` the file directly without joining cwd).
//
// Singleton — same anti-pattern as `setJsonMode`. Eventually folds into
// DispatchContext alongside jsonMode; until then this is the parallel surface.

let _fullPaths = false

/** Enable absolute-path mode for envelope `file` field. Default: relativized. */
export function setFullPaths(value: boolean): void {
  _fullPaths = value
}

/** Read current full-paths setting. */
export function isFullPaths(): boolean {
  return _fullPaths
}

/**
 * Format a file path for the JSON envelope `file` field.
 *
 * Default (`fullPaths: false`):
 *   - If the path lives under cwd, return the cwd-relative path
 *     (e.g. cwd=/Users/me/proj, abs=/Users/me/proj/out/x.txt → out/x.txt).
 *   - Otherwise return the basename
 *     (e.g. /tmp/llm-...txt → llm-...txt — covers the canonical case).
 *   - Non-absolute inputs are passed through verbatim.
 *
 * `fullPaths: true` returns the input unchanged.
 *
 * Pure — no module-state reads. Callers pass `fullPaths` and `cwd` explicitly
 * so the function is trivially testable and deterministic across workers.
 */
export function formatEnvelopeFile(filePath: string, opts: { fullPaths: boolean; cwd: string }): string {
  if (opts.fullPaths) return filePath
  // Already-relative paths pass through. We only relativize absolute ones —
  // callers occasionally pass relative paths (e.g. via `--output ./foo.txt`)
  // and rewriting those would surprise users.
  if (!path.isAbsolute(filePath)) return filePath
  const rel = path.relative(opts.cwd, filePath)
  // If the file is *outside* cwd, `path.relative` produces "../..." — that's
  // useless leakage of intermediate directories. Fall back to basename.
  if (rel.startsWith("..") || path.isAbsolute(rel)) return path.basename(filePath)
  return rel
}

/** @deprecated Construct a fresh DispatchContext per test instead. */
export function resetOutputMode(): void {
  _setDefaultDispatchContext(createDispatchContext({ jsonMode: false }))
  _fullPaths = false
}

/** @deprecated Use `ctx.emit(envelope)` from a passed-in DispatchContext. */
export function emitJson(envelope: Record<string, unknown>): void {
  _getDefaultDispatchContext().emit(envelope)
}

/** @deprecated Use `ctx.content(text)` from a passed-in DispatchContext. */
export function emitContent(content: string): void {
  _getDefaultDispatchContext().content(content)
}
