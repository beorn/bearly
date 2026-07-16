/**
 * Every new worktree is born at origin/main, never at a stale local HEAD.
 *
 * @failure `bun worktree create <name>` branches a brand-new worktree from
 *   LOCAL main's HEAD. When local main is behind origin/main (routine: a dirty
 *   tree + `rebase.autostash=false` means `pull` can never run), the worktree is
 *   born N commits behind. Measured 2026-07-15: a clean `bun worktree create
 *   adhoc1` landed 226 commits behind origin/main. The agent working there
 *   conflicts on land, recuts into a NEW worktree — which is born behind too —
 *   and recuts again: 55 of 150 branches carried `-r2`/`-r3`/`currentmain`
 *   suffixes. This is the engine behind worktree sprawl and recut churn.
 * @level l1
 * @consumer vendor/bearly/tools/worktree.ts resolveBranchArg — the ONE base
 *   selection seam for `git worktree add`, reached from `bun worktree create`
 *   (hh tools/worktree.ts re-exports the CLI). Pool slots wt0..wt9 were already
 *   fixed for this at @km/inbox/19363; non-slot names never were.
 */

import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import { resolveBranchArg } from "./worktree.ts"

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort fixture cleanup; a leaked tmp dir is not a test failure.
    }
  }
})

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd} failed: ${r.stderr || `exit ${r.status}`}`)
  return (r.stdout ?? "").trim()
}

const ident = ["-c", "user.email=a@b.c", "-c", "user.name=a"]

/**
 * Build the exact failure shape: a clone whose LOCAL main is `behind` commits
 * behind origin/main, with origin/main fetched and known locally. Returns the
 * clone path.
 */
function buildCloneBehindOrigin(behind: number): string {
  const root = mkdtempSync(join(tmpdir(), "wt-base-"))
  scratch.push(root)

  const origin = join(root, "origin.git")
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin])

  const seed = join(root, "seed")
  mkdirSync(seed)
  git(seed, "init", "-q", "-b", "main")
  writeFileSync(join(seed, "f.txt"), "0\n")
  git(seed, "add", "-A")
  git(seed, ...ident, "commit", "-qm", "init")
  git(seed, "remote", "add", "origin", origin)
  git(seed, "push", "-q", "origin", "main")

  const clone = join(root, "clone")
  spawnSync("git", ["clone", "-q", origin, clone])

  // Origin advances past the clone; the clone fetches but never pulls — the
  // dirty-tree + autostash=false shape that strands local main for hours.
  for (let i = 1; i <= behind; i++) {
    writeFileSync(join(seed, "f.txt"), `${i}\n`)
    git(seed, "add", "-A")
    git(seed, ...ident, "commit", "-qm", `advance ${i}`)
  }
  git(seed, "push", "-q", "origin", "main")
  git(clone, "fetch", "-q", "origin")

  // Precondition: this fixture reproduces the reported symptom.
  expect(git(clone, "rev-list", "--count", "HEAD..origin/main")).toBe(String(behind))
  return clone
}

describe("resolveBranchArg — new worktrees are born at origin/main", () => {
  test("a brand-new non-slot branch bases on origin/main, not local HEAD", () => {
    expect(
      resolveBranchArg({ isPoolSlot: false, branchExists: false, remoteBranchExists: false, branchName: "feat/z" }),
    ).toEqual(["-b", "feat/z", "origin/main"])
  })

  test("baseRef: 'HEAD' is the explicit opt-out for branching off in-progress work", () => {
    expect(
      resolveBranchArg({
        isPoolSlot: false,
        branchExists: false,
        remoteBranchExists: false,
        branchName: "feat/z",
        baseRef: "HEAD",
      }),
    ).toEqual(["-b", "feat/z", "HEAD"])
  })

  test("an existing local branch is still reused as-is — never re-based over the user's work", () => {
    expect(
      resolveBranchArg({ isPoolSlot: false, branchExists: true, remoteBranchExists: false, branchName: "feat/x" }),
    ).toEqual(["feat/x"])
  })

  test("a remote-only branch is still tracked as-is", () => {
    expect(
      resolveBranchArg({ isPoolSlot: false, branchExists: false, remoteBranchExists: true, branchName: "feat/y" }),
    ).toEqual(["feat/y"])
  })

  // The end-to-end proof: feed resolveBranchArg's output to REAL `git worktree
  // add` in a repo reproducing the measured 226-behind shape, and measure the
  // born worktree with the same command that reported the bug.
  test("git worktree add with the resolved arg is born 0 behind origin/main (was 226)", () => {
    const clone = buildCloneBehindOrigin(12)
    const arg = resolveBranchArg({
      isPoolSlot: false,
      branchExists: false,
      remoteBranchExists: false,
      branchName: "feat/adhoc1",
    })

    const wt = join(clone, ".worktrees", "adhoc1")
    git(clone, "worktree", "add", wt, ...arg)

    expect(git(wt, "rev-list", "--count", "HEAD..origin/main")).toBe("0")
    expect(git(wt, "rev-parse", "HEAD")).toBe(git(clone, "rev-parse", "origin/main"))
  })

  test("the opt-out still reaches local HEAD end-to-end (in-progress work stays reachable)", () => {
    const clone = buildCloneBehindOrigin(12)
    const arg = resolveBranchArg({
      isPoolSlot: false,
      branchExists: false,
      remoteBranchExists: false,
      branchName: "feat/wip",
      baseRef: "HEAD",
    })

    const wt = join(clone, ".worktrees", "wip")
    git(clone, "worktree", "add", wt, ...arg)

    expect(git(wt, "rev-parse", "HEAD")).toBe(git(clone, "rev-parse", "HEAD"))
    expect(git(wt, "rev-list", "--count", "HEAD..origin/main")).toBe("12")
  })
})
