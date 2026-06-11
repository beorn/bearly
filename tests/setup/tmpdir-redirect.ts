/**
 * Redirect TMPDIR to a bounded, self-sweeping base before any test runs.
 *
 * The shared macOS per-user tmpdir (/var/folders/.../T) accumulates leaked
 * mkdtemp fixtures from killed and timed-out runs (afterEach cleanup never
 * fires). Sustained create/delete churn bloats that directory's btree until
 * a full readdir takes minutes — and bun's startup enumerates the cwd
 * ancestor chain, so any spawned bun subprocess whose cwd or socket dir
 * lives under it wedges past testTimeout (45 tribe/recall/github tests
 * timed out this way on 2026-06-11; the same file passed in 0.7s with
 * TMPDIR redirected).
 *
 * os.tmpdir() reads process.env.TMPDIR at call time, so setting it here —
 * setup files run before any test module loads — moves every
 * `mkdtempSync(join(tmpdir(), ...))` fixture under a bounded base with zero
 * call-site edits. Children inherit the env. Entries older than 24h are
 * swept at worker startup so leaks can never re-accumulate into the same
 * pathology.
 */
import { mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"

// realpathSync: /tmp is a symlink to /private/tmp on macOS — tools that
// compare resolved paths against fixture paths (e.g. the ripgrep-backed
// wikilink find) mismatch unless TMPDIR is already canonical.
mkdirSync(`/tmp/bearly-vitest-${process.getuid?.() ?? 0}`, { recursive: true })
const TEST_TMP_BASE = realpathSync(`/tmp/bearly-vitest-${process.getuid?.() ?? 0}`)
const STALE_CUTOFF_MS = Date.now() - 24 * 60 * 60 * 1000
for (const name of readdirSync(TEST_TMP_BASE)) {
  const stale = join(TEST_TMP_BASE, name)
  try {
    if (statSync(stale).mtimeMs < STALE_CUTOFF_MS) rmSync(stale, { recursive: true, force: true })
  } catch {
    // Concurrent workers race to sweep the same stale entry; losing the race
    // (ENOENT between stat and rm) is the expected outcome, not an error.
  }
}
process.env.TMPDIR = TEST_TMP_BASE
