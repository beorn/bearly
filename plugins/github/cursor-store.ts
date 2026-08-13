/**
 * Machine-local persistence for the GitHub channel's poll cursor.
 *
 * Deliberately side-effect-free at import time: every exported function only
 * touches the filesystem when a caller actually invokes it. `server.ts`
 * calls `openGitHubCursorStore()` once, after its token/repo checks, and
 * holds the returned store for the life of the process.
 *
 * History: the cursor used to live at a `.beads/github-cursor.json` found by
 * walking up from `process.cwd()` with no git/project boundary, computed as
 * a top-level module const — so importing the file (including from a test)
 * minted a `.beads/` dir wherever the importer's cwd happened to be, and an
 * unconditional save from the SIGINT/SIGTERM handler wrote a `{"repos":{}}`
 * stub there even when no repo had ever completed a poll. Those stray stubs
 * were then read by tribe's daemon cursor store as conflicting legacy state,
 * which refuses to start rather than guess — a full messaging outage. See
 * `tests/cursor-store.test.ts` for the regression coverage.
 *
 * The fix ports the shape already hardened in tribe's own
 * `github-cursor-store.ts` (XDG-only, lazy, adopt-legacy-once): stateDir +
 * mkdir happen only inside `openGitHubCursorStore`, an absent cursor loads
 * as `{repos:{}}` purely in memory, and `save()` refuses to ever write an
 * empty cursor. Simplified from tribe's version for this plugin's lighter
 * single-process-per-repo model: no cross-process flock (tribe's daemon is
 * the single shared writer across a whole multi-agent fleet; this plugin is
 * one `bun server.ts` per Claude Code session), and legacy discovery is one
 * caller-supplied fixed path rather than a bounded ancestor search — the
 * ancestor walk is exactly what caused the landmine, so it doesn't come back
 * in any form. A caller who wants an old `.beads/github-cursor.json`
 * adopted just passes `defaultLegacyGitHubCursorPath()`, which reads only
 * `<cwd>/.beads/github-cursor.json` — never a parent directory.
 */
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, resolve } from "node:path"

export interface GitHubCursorState {
  /** Per-repo last-seen event ID. */
  readonly repos: Record<string, { readonly lastEventId: string; readonly lastPollAt: string }>
}

export interface GitHubCursorStore {
  readonly path: string
  readonly state: GitHubCursorState
  /** No-ops when `state.repos` is empty — an empty cursor is never worth persisting. */
  save(state: GitHubCursorState): void
}

export interface OpenGitHubCursorStoreOptions {
  /** Directory the XDG cursor file lives in. Created if missing. */
  readonly stateDir: string
  /** A single pre-existing `.beads`-era cursor to adopt once, or `null` to skip legacy handling entirely. */
  readonly legacyPath?: string | null
}

type CursorEnvironment = Readonly<Record<string, string | undefined>>

/** `<XDG_DATA_HOME or ~/.local/share>/bearly/github-cursor.json` — bearly's own product namespace, never the project checkout. */
export function resolveGitHubCursorPath(env: CursorEnvironment = process.env): string {
  const dataHome = env.XDG_DATA_HOME?.trim() || resolve(env.HOME?.trim() || homedir(), ".local/share")
  return resolve(dataHome, "bearly", "github-cursor.json")
}

/**
 * The one legacy location this plugin will ever adopt from: `.beads/` in the
 * caller's own cwd. No ancestor walk — that is the bug being fixed, not a
 * feature to preserve. `.beads/` itself belongs to the beads issue tracker;
 * this only ever reads (and, on adoption, removes) the one file it wrote.
 */
export function defaultLegacyGitHubCursorPath(cwd: string = process.cwd()): string {
  return resolve(cwd, ".beads", "github-cursor.json")
}

function isEmpty(state: GitHubCursorState): boolean {
  return Object.keys(state.repos).length === 0
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function parseStrict(bytes: string, path: string): GitHubCursorState {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes)
  } catch (error) {
    throw new Error(
      `GitHub cursor ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.repos)) {
    throw new Error(`GitHub cursor ${path} must be an object with a "repos" object`)
  }
  return { repos: parsed.repos as GitHubCursorState["repos"] }
}

/** Lenient on purpose — a corrupt cursor cache just means "re-notify a few recent events," never worth crashing the channel over. */
function readTargetLenient(path: string): GitHubCursorState {
  try {
    return parseStrict(readFileSync(path, "utf8"), path)
  } catch {
    return { repos: {} }
  }
}

function canonicalCursorJson(state: GitHubCursorState): string {
  return JSON.stringify(Object.fromEntries(Object.entries(state.repos).sort(([a], [b]) => a.localeCompare(b))))
}

function sameCursor(a: GitHubCursorState, b: GitHubCursorState): boolean {
  return canonicalCursorJson(a) === canonicalCursorJson(b)
}

function removeLegacyFile(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
}

function writeCursorAtomic(path: string, state: GitHubCursorState): void {
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true })
  const temp = resolve(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
    renameSync(temp, path)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // temp file was never created, or is already gone — nothing to clean up
    }
    throw new Error(
      `GitHub cursor ${path} could not be written: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Open the cursor store: resolve state, adopting a legacy `.beads` cursor at
 * most once. Every filesystem touch — the mkdir, the reads, the migration
 * write, the legacy removal — happens here, at call time, never at import.
 */
export function openGitHubCursorStore(options: OpenGitHubCursorStoreOptions): GitHubCursorStore {
  mkdirSync(options.stateDir, { recursive: true })
  const path = resolve(options.stateDir, "github-cursor.json")
  const resolvedLegacyPath = options.legacyPath ? resolve(options.legacyPath) : null
  const legacy =
    resolvedLegacyPath !== null && resolvedLegacyPath !== path && existsSync(resolvedLegacyPath)
      ? resolvedLegacyPath
      : null

  const state = resolveInitialState(path, legacy)

  return {
    path,
    state,
    save(next) {
      if (isEmpty(next)) return
      writeCursorAtomic(path, next)
    },
  }
}

function resolveInitialState(path: string, legacy: string | null): GitHubCursorState {
  if (existsSync(path)) {
    const state = readTargetLenient(path)
    if (legacy !== null) {
      const legacyState = parseStrict(readFileSync(legacy, "utf8"), legacy)
      if (!isEmpty(legacyState) && !sameCursor(legacyState, state)) {
        throw new Error(
          `GitHub cursor conflict: ${path} and legacy ${legacy} disagree; refusing to choose. ` +
            `Remove the stale legacy file once you've confirmed ${path} is correct.`,
        )
      }
      removeLegacyFile(legacy)
    }
    return state
  }

  if (legacy !== null) {
    const legacyState = parseStrict(readFileSync(legacy, "utf8"), legacy)
    if (!isEmpty(legacyState)) writeCursorAtomic(path, legacyState)
    removeLegacyFile(legacy)
    return isEmpty(legacyState) ? { repos: {} } : legacyState
  }

  return { repos: {} }
}
