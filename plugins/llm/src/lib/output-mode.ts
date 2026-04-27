/**
 * Output-mode singleton — `--json` vs human-text.
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
 *
 * The mode is set once at CLI startup (cli.ts reads `--json` then calls
 * setJsonMode(true)). Library code reads it via isJsonMode(). Using a
 * module-level singleton (not env vars) keeps it test-isolated:
 * vitest can call resetOutputMode() between tests without leaking env
 * state across workers.
 */

let jsonMode = false

/** Enable JSON output mode. Call once at CLI startup, before any dispatch. */
export function setJsonMode(value: boolean): void {
  jsonMode = value
}

/** True when --json was passed. Library code reads this to route output. */
export function isJsonMode(): boolean {
  return jsonMode
}

/** Reset for tests. Not part of the public CLI surface. */
export function resetOutputMode(): void {
  jsonMode = false
}

/**
 * Emit the final JSON envelope on stdout.
 *
 * Mode-agnostic: the envelope ALWAYS goes to stdout (both in JSON mode
 * and legacy mode). The difference is what ELSE goes to stdout — in
 * JSON mode, nothing else does.
 *
 * Always writes exactly ONE line (newline-terminated). Use jq, grep,
 * or simple line-reads to consume.
 *
 * Implementation note: uses console.log (which writes to stdout with a
 * trailing newline) rather than process.stdout.write so vitest spies on
 * console.log catch the line. The behavior is identical from the
 * shell's perspective.
 */
export function emitJson(envelope: Record<string, unknown>): void {
  console.log(JSON.stringify(envelope))
}

/**
 * Emit response content to the appropriate stream.
 *
 * Legacy mode → stdout (so callers piping `bun llm recover <id>` to
 * less / a file still see the response body).
 *
 * JSON mode → stderr (stdout is reserved for the single JSON line; the
 * caller is expected to read the file at envelope.file for content).
 *
 * Used by recover/await paths that print recovered content as a
 * preview. The canonical content is always written to a file via
 * finalizeOutput; this is just for the human-watching-the-terminal
 * case.
 */
export function emitContent(content: string): void {
  if (jsonMode) {
    console.error(content)
  } else {
    console.log(content)
  }
}
