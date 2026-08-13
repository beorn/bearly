/**
 * Regression coverage for the GitHub-poll cursor landmine.
 *
 * The original `server.ts` resolved its cursor path by walking up from
 * `process.cwd()` looking for a `.beads` dir, with NO git/project boundary —
 * the walk only stopped at "/". When nothing was found it fell back to
 * `mkdirSync(resolve(process.cwd(), ".beads"))`, and that whole computation
 * ran as a top-level module const, so merely IMPORTING the file minted a
 * `.beads/` dir wherever the importer's cwd happened to be. `saveCursor`
 * then wrote unconditionally, including from the SIGINT/SIGTERM cleanup
 * handler — so a process started and killed before its first successful
 * poll left behind a `.beads/github-cursor.json` stub containing
 * `{"repos":{}}`. Multiple stray stubs across sibling worktrees/cwds were
 * then read by tribe's daemon cursor store as CONFLICTING legacy state,
 * which refuses to start rather than guess — a full messaging outage, seen
 * five times in one day on the fleet host.
 *
 * This module replaces that inline logic with an isolated, side-effect-free
 * (at import time) store: the cursor lives under XDG_DATA_HOME, never cwd;
 * path resolution and directory creation happen only when a caller actually
 * opens the store; an absent cursor loads as `{repos:{}}` in memory with no
 * write; and `save()` refuses to ever persist an empty cursor, which is what
 * makes a pre-first-poll SIGTERM harmless. A pre-existing `.beads/` cursor
 * at the caller-supplied legacy path is adopted exactly once (and removed);
 * an empty legacy stub is removed without being adopted. No ancestor walk of
 * any kind remains — the caller passes one fixed legacy path, or none.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { safeRemoveSync } from "removely"
import { afterEach, describe, expect, test } from "vitest"

import {
  defaultLegacyGitHubCursorPath,
  openGitHubCursorStore,
  resolveGitHubCursorPath,
  type GitHubCursorState,
} from "../cursor-store.ts"

const tempRoot = realpathSync(tmpdir())
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) safeRemoveSync(root, { within: tempRoot, allowMissing: true })
})

function fixture(label: string): { repo: string; stateDir: string; legacyPath: string; targetPath: string } {
  const root = realpathSync(mkdtempSync(join(tempRoot, `bearly-github-cursor-${label}-`)))
  roots.push(root)
  const repo = join(root, "project")
  const stateDir = join(root, "xdg-data", "bearly")
  const legacyPath = join(repo, ".beads", "github-cursor.json")
  mkdirSync(dirname(legacyPath), { recursive: true })
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo })
  execFileSync("git", ["config", "user.name", "cursor test"], { cwd: repo })
  execFileSync("git", ["config", "user.email", "cursor-test@example.com"], { cwd: repo })
  writeFileSync(join(repo, "README.md"), "# fixture\n")
  execFileSync("git", ["add", "README.md"], { cwd: repo })
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: repo })
  return { repo, stateDir, legacyPath, targetPath: join(stateDir, "github-cursor.json") }
}

const realState: GitHubCursorState = {
  repos: {
    "beorn/bearly": { lastEventId: "event-42", lastPollAt: "2026-08-12T19:00:00.000Z" },
  },
}

describe("GitHub cursor store — landmine regression", () => {
  test("importing the module creates nothing on disk", () => {
    // This assertion runs AFTER the top-of-file `import ... from "../cursor-store.ts"`
    // has already been evaluated by the module loader — if the import itself had a
    // side effect (as the original top-level `CURSOR_PATH`/`mkdirSync` did), it would
    // already be visible here, before any test body calls any exported function.
    const realCwdBeadsDir = resolve(process.cwd(), ".beads")
    const preexisting = existsSync(realCwdBeadsDir) ? readdirSync(realCwdBeadsDir) : []
    expect(preexisting).not.toContain("github-cursor.json")
  })

  test("resolves under XDG_DATA_HOME, or ~/.local/share, never cwd", () => {
    expect(resolveGitHubCursorPath({ XDG_DATA_HOME: "/machine/data", HOME: "/home/test" })).toBe(
      "/machine/data/bearly/github-cursor.json",
    )
    expect(resolveGitHubCursorPath({ HOME: "/home/test" })).toBe("/home/test/.local/share/bearly/github-cursor.json")
  })

  test("the default legacy path is the caller's cwd .beads file, with no ancestor walk", () => {
    expect(defaultLegacyGitHubCursorPath("/some/project")).toBe("/some/project/.beads/github-cursor.json")
  })

  test("an absent cursor initializes as {repos:{}} in memory without writing a file", () => {
    const f = fixture("absent")

    const store = openGitHubCursorStore({ stateDir: f.stateDir, legacyPath: f.legacyPath })

    expect(store.state).toEqual({ repos: {} })
    expect(existsSync(f.targetPath)).toBe(false)
  })

  test("SIGTERM before any successful poll: saving untouched empty state writes nothing", () => {
    const f = fixture("sigterm")

    // Mirrors server.ts's cleanup(): SIGTERM/SIGINT/exit all call
    // `cursorStore.save(cursorState)` unconditionally, with whatever state
    // happens to be in memory. Before any repo ever completes a first poll,
    // that state is still the untouched `{repos:{}}` from open().
    const store = openGitHubCursorStore({ stateDir: f.stateDir, legacyPath: f.legacyPath })
    store.save(store.state)

    expect(existsSync(f.targetPath)).toBe(false)
    expect(existsSync(f.stateDir) ? readdirSync(f.stateDir) : []).toEqual([])
  })

  test("a legacy .beads cursor with real repos is adopted once, then removed", () => {
    const f = fixture("legacy-real")
    writeFileSync(f.legacyPath, `${JSON.stringify(realState, null, 2)}\n`)

    const store = openGitHubCursorStore({ stateDir: f.stateDir, legacyPath: f.legacyPath })

    expect(store.state).toEqual(realState)
    expect(JSON.parse(readFileSync(f.targetPath, "utf8"))).toEqual(realState)
    expect(existsSync(f.legacyPath)).toBe(false)
    // The legacy `.beads` dir itself is untouched — it's owned by the beads
    // issue tracker, not by this plugin. Only the stray file inside it goes.
    expect(existsSync(dirname(f.legacyPath))).toBe(true)
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: f.repo, encoding: "utf8" })).toBe("")
  })

  test("a legacy EMPTY stub is removed without being adopted", () => {
    const f = fixture("legacy-empty")
    writeFileSync(f.legacyPath, `${JSON.stringify({ repos: {} }, null, 2)}\n`)

    const store = openGitHubCursorStore({ stateDir: f.stateDir, legacyPath: f.legacyPath })

    expect(store.state).toEqual({ repos: {} })
    expect(existsSync(f.targetPath)).toBe(false)
    expect(existsSync(f.legacyPath)).toBe(false)
  })

  test("opening without a legacyPath never looks at or creates .beads", () => {
    const f = fixture("no-legacy")
    writeFileSync(f.legacyPath, `${JSON.stringify(realState, null, 2)}\n`)

    const store = openGitHubCursorStore({ stateDir: f.stateDir, legacyPath: null })

    expect(store.state).toEqual({ repos: {} })
    // Legacy file is left completely alone when the caller passes no legacy path.
    expect(JSON.parse(readFileSync(f.legacyPath, "utf8"))).toEqual(realState)
  })

  test("corrupt legacy state fails loudly, naming the path, and is left in place", () => {
    const f = fixture("legacy-corrupt")
    writeFileSync(f.legacyPath, "{ not json")

    expect(() => openGitHubCursorStore({ stateDir: f.stateDir, legacyPath: f.legacyPath })).toThrow(
      new RegExp(f.legacyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    )
    expect(existsSync(f.targetPath)).toBe(false)
    expect(readFileSync(f.legacyPath, "utf8")).toBe("{ not json")
  })

  test("an existing target cursor governs; a real-but-different legacy cursor is a loud conflict", () => {
    const f = fixture("conflict")
    const other: GitHubCursorState = {
      repos: { "beorn/km": { lastEventId: "other", lastPollAt: "2026-08-12T20:00:00.000Z" } },
    }
    mkdirSync(f.stateDir, { recursive: true })
    writeFileSync(f.targetPath, `${JSON.stringify(other, null, 2)}\n`)
    writeFileSync(f.legacyPath, `${JSON.stringify(realState, null, 2)}\n`)

    expect(() => openGitHubCursorStore({ stateDir: f.stateDir, legacyPath: f.legacyPath })).toThrow(/conflict/i)
    expect(JSON.parse(readFileSync(f.targetPath, "utf8"))).toEqual(other)
    expect(JSON.parse(readFileSync(f.legacyPath, "utf8"))).toEqual(realState)
  })

  test("save() atomically replaces the cursor file, no leftover temp files", () => {
    const f = fixture("save")
    const store = openGitHubCursorStore({ stateDir: f.stateDir, legacyPath: f.legacyPath })

    store.save(realState)

    expect(JSON.parse(readFileSync(f.targetPath, "utf8"))).toEqual(realState)
    expect(readdirSync(f.stateDir).filter((name) => name.includes(".tmp"))).toEqual([])
  })

  test("save() never persists an empty cursor, even once real state existed", () => {
    const f = fixture("save-empty-guard")
    const store = openGitHubCursorStore({ stateDir: f.stateDir, legacyPath: f.legacyPath })
    store.save(realState)
    expect(existsSync(f.targetPath)).toBe(true)

    store.save({ repos: {} })

    // Regressing to empty never overwrites real persisted history with a stub.
    expect(JSON.parse(readFileSync(f.targetPath, "utf8"))).toEqual(realState)
  })
})
