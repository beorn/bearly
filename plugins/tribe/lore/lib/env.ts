/**
 * Tribe/lore env var resolver with LORE_* → TRIBE_* compat.
 *
 * New names (TRIBE_*) take precedence. If only an old name (LORE_*) is set,
 * we still honour it but emit a single aggregated stderr deprecation line on
 * the next microtask (so all startup reads coalesce into one warning).
 *
 * Removal target: @bearly/tribe 0.10.
 *
 * Note on naming collisions: `TRIBE_SOCKET` and `TRIBE_DB` are already used
 * by the tribe coordination daemon (see tools/lib/tribe/config.ts,
 * plugins/tribe/server.ts). To avoid ambiguity we use `TRIBE_LORE_SOCKET`
 * and `TRIBE_LORE_DB` for the lore workspace daemon — they are distinct
 * processes with distinct sockets/DBs.
 */

/**
 * Canonical new-name → old-name map. Keys are the names callers pass to
 * `getEnv`; values are the legacy names we fall back to.
 */
const RENAMES: Record<string, string> = {
  TRIBE_NO_DAEMON: "LORE_NO_DAEMON",
  TRIBE_LOG: "LORE_LOG",
  TRIBE_LORE_SOCKET: "LORE_SOCKET",
  TRIBE_LORE_DB: "LORE_DB",
  TRIBE_SUMMARIZER_MODEL: "LORE_SUMMARIZER_MODEL",
  TRIBE_FOCUS_POLL_MS: "LORE_FOCUS_POLL_MS",
  TRIBE_SUMMARY_POLL_MS: "LORE_SUMMARY_POLL_MS",
}

const usedOld: string[] = []
let warned = false

/**
 * Read a tribe/lore env var by its new (TRIBE_*) name.
 *
 * Resolution order:
 *   1. `process.env[newName]` if set → use it, no warning.
 *   2. Legacy `process.env[oldName]` if set → use it, emit a one-time
 *      deprecation warning on next microtask.
 *   3. Otherwise → return `undefined`.
 */
export function getEnv(newName: string): string | undefined {
  const newVal = process.env[newName]
  if (newVal !== undefined) return newVal
  const oldName = RENAMES[newName]
  if (oldName !== undefined) {
    const oldVal = process.env[oldName]
    if (oldVal !== undefined) {
      if (!usedOld.includes(oldName)) usedOld.push(oldName)
      maybeWarn()
      return oldVal
    }
  }
  return undefined
}

/**
 * Emit a single aggregated deprecation line on the next microtask. All
 * startup reads of LORE_* aggregate into one warning; subsequent reads
 * after the warning has fired are silent.
 */
function maybeWarn(): void {
  if (warned || usedOld.length === 0) return
  queueMicrotask(() => {
    if (warned) return
    warned = true
    const news = usedOld.map((old) => {
      const entry = Object.entries(RENAMES).find(([, v]) => v === old)
      return entry ? entry[0] : old
    })
    process.stderr.write(
      `[deprecated] env vars ${usedOld.join(", ")} are now ${news.join(", ")} — old names will be removed in @bearly/tribe 0.10\n`,
    )
  })
}

/**
 * Test-only: reset the module-level warning state. Not exported from the
 * package barrel — tests import directly via `./env.ts`.
 */
export function __resetEnvWarningsForTesting(): void {
  usedOld.length = 0
  warned = false
}
