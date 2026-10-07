/**
 * Configurable worktree pool root (km bead 20888-contained-worktree-pool).
 *
 * The persistent slot pool (`<repo>-wtN`) historically lives as SIBLINGS of
 * the repo (`<repoParent>/<repo>-wtN`), which sprawls the parent dir. The
 * `worktree.poolRoot` git config key relocates the pool — typically to a
 * contained, git-ignored dir inside the repo (`<repo>/.worktrees/<repo>-wtN`).
 *
 * The chain — repo `worktree.poolRoot` > `HH_WORKTREE_HOME` >
 * `DEFAULT_WORKTREE_HOME` — now lives in ONE place, git-super's
 * `worktreeHomeRoot` (@i/26-environments/worktree-create-and-in; @cto
 * ebf2cc43), and `resolvePoolRoot` delegates to it. There is no sibling tier:
 * an undeclared path falls to the env home, then the default.
 *
 * Existing slots are found in BOTH locations (configured pool first, then the
 * legacy sibling), so flipping the config never orphans a live slot.
 */

import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import {
  isCanonicalSlotPath,
  POOL_ROOT_CONFIG_KEY,
  resolvePoolRoot,
  resolveWorktreeTargetPath,
  slotPathCandidates,
} from "./worktree.ts"

const GIT_ROOT = "/Users/dev/Code/hh"
const CONTAINED = "/Users/dev/Code/hh/.worktrees"
const NON_REPO = "/no/such/repo/anywhere"

const scratch: string[] = []

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", args as string[], { cwd, stdio: ["ignore", "pipe", "pipe"] })
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "bearly-pool-root-"))
  scratch.push(dir)
  git(dir, ["init", "-q", "-b", "main"])
  git(dir, ["config", "user.email", "t@example.test"])
  git(dir, ["config", "user.name", "t"])
  writeFileSync(join(dir, "seed.txt"), "seed\n")
  git(dir, ["add", "seed.txt"])
  git(dir, ["commit", "-qm", "seed"])
  return dir
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("resolvePoolRoot — the one declaration chain (git-super worktreeHomeRoot)", () => {
  let home: string
  let prior: string | undefined

  beforeEach(() => {
    prior = process.env.HH_WORKTREE_HOME
    home = mkdtempSync(join(tmpdir(), "bearly-pool-home-"))
    process.env.HH_WORKTREE_HOME = home
  })

  afterEach(() => {
    if (prior === undefined) delete process.env.HH_WORKTREE_HOME
    else process.env.HH_WORKTREE_HOME = prior
    rmSync(home, { recursive: true, force: true })
  })

  test("an undeclared path (no .git) falls to HH_WORKTREE_HOME, never a sibling", () => {
    expect(resolvePoolRoot(NON_REPO)).toBe(home)
  })

  test("a declared repo returns its declaration", () => {
    const repo = makeRepo()
    git(repo, ["config", POOL_ROOT_CONFIG_KEY, "/mnt/pool"])
    expect(resolvePoolRoot(repo)).toBe("/mnt/pool")
  })

  test("a relative declaration resolves against the repo's main worktree root", () => {
    const repo = makeRepo()
    git(repo, ["config", POOL_ROOT_CONFIG_KEY, ".worktrees"])
    expect(resolvePoolRoot(repo)).toBe(join(repo, ".worktrees"))
  })

  test("a trailing slash normalizes", () => {
    const repo = makeRepo()
    git(repo, ["config", POOL_ROOT_CONFIG_KEY, ".worktrees/"])
    expect(resolvePoolRoot(repo)).toBe(join(repo, ".worktrees"))
  })

  test("empty value fails loud — misconfiguration is never a silent fallback", () => {
    const repo = makeRepo()
    git(repo, ["config", POOL_ROOT_CONFIG_KEY, ""])
    expect(() => resolvePoolRoot(repo)).toThrow(/worktree\.poolRoot/)
  })
})

describe("slotPathCandidates — configured pool first, legacy sibling fallback", () => {
  test("contained pool configured: candidates are contained then sibling", () => {
    expect(slotPathCandidates(GIT_ROOT, "wt3", CONTAINED)).toEqual([
      "/Users/dev/Code/hh/.worktrees/hh-wt3",
      "/Users/dev/Code/hh-wt3",
    ])
  })

  test("default sibling pool: a single candidate (no duplicate)", () => {
    expect(slotPathCandidates(GIT_ROOT, "wt3", "/Users/dev/Code")).toEqual(["/Users/dev/Code/hh-wt3"])
  })

  test("already-prefixed dir names are not double-prefixed", () => {
    expect(slotPathCandidates(GIT_ROOT, "hh-wt-ci", CONTAINED)).toEqual([
      "/Users/dev/Code/hh/.worktrees/hh-wt-ci",
      "/Users/dev/Code/hh-wt-ci",
    ])
  })
})

describe("resolveWorktreeTargetPath — pool-aware existing-target resolution", () => {
  test("no options keeps the pure historic sibling contract (existing callers)", () => {
    expect(resolveWorktreeTargetPath(GIT_ROOT, "wt3")).toBe("/Users/dev/Code/hh-wt3")
  })

  test("contained configured + contained slot exists → contained path", () => {
    const exists = (p: string) => p === "/Users/dev/Code/hh/.worktrees/hh-wt3"
    expect(resolveWorktreeTargetPath(GIT_ROOT, "wt3", { poolRoot: CONTAINED, exists })).toBe(
      "/Users/dev/Code/hh/.worktrees/hh-wt3",
    )
  })

  test("contained configured + only the legacy sibling exists → sibling path (no orphaned live slot)", () => {
    const exists = (p: string) => p === "/Users/dev/Code/hh-wt3"
    expect(resolveWorktreeTargetPath(GIT_ROOT, "wt3", { poolRoot: CONTAINED, exists })).toBe("/Users/dev/Code/hh-wt3")
  })

  test("neither exists → canonical (configured) path, so create-fresh lands contained", () => {
    const exists = () => false
    expect(resolveWorktreeTargetPath(GIT_ROOT, "wt3", { poolRoot: CONTAINED, exists })).toBe(
      "/Users/dev/Code/hh/.worktrees/hh-wt3",
    )
  })

  test("pathlike args stay as-is regardless of pool config", () => {
    const exists = () => false
    expect(resolveWorktreeTargetPath(GIT_ROOT, "/abs/km-wt-ci", { poolRoot: CONTAINED, exists })).toBe("/abs/km-wt-ci")
  })
})

describe("isCanonicalSlotPath — audit classification follows the configured pool", () => {
  test("default (sibling) pool: sibling wtN is canonical, exactly as before", () => {
    expect(isCanonicalSlotPath("/Users/dev/Code/hh-wt3", GIT_ROOT, "/Users/dev/Code")).toBe(true)
    expect(isCanonicalSlotPath("/Users/dev/Code/hh-wt-ci", GIT_ROOT, "/Users/dev/Code")).toBe(false)
  })

  test("contained pool configured: contained wtN is canonical, sibling is not (legacy)", () => {
    expect(isCanonicalSlotPath("/Users/dev/Code/hh/.worktrees/hh-wt3", GIT_ROOT, CONTAINED)).toBe(true)
    expect(isCanonicalSlotPath("/Users/dev/Code/hh-wt3", GIT_ROOT, CONTAINED)).toBe(false)
  })

  test("non-slot dirs in the pool are not canonical", () => {
    expect(isCanonicalSlotPath("/Users/dev/Code/hh/.worktrees/hh-scratch", GIT_ROOT, CONTAINED)).toBe(false)
  })
})
