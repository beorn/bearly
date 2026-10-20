/**
 * resolveBranchArg — every branch this create CUTS lands at the given base.
 *
 * Regression for @km/inbox/19363: `bun worktree reset wtN --force` recreated
 * the slot on a STALE local `wtN` pet branch (N-behind origin/main) when the
 * slot had last run a `task/<id>` branch, instead of landing at origin/main.
 * Root cause: the branch-exists check fired BEFORE the pool-slot rule, so a
 * surviving stale `wtN` ref shortcut to "use existing" at its ancient SHA.
 *
 * Regression for worktree-base-origin-main (2026-07-15): a brand-new non-pool
 * branch was cut with NO start point (`-b feat/<name>`), i.e. from the invoking
 * repo's local HEAD — `hh-adhoc1` was born 226 commits behind origin/main, and
 * 55 of 150 worktree branches grew -r2/-r3 recut suffixes as a consequence.
 * Every cut branch now takes an explicit base (fetched origin/main by default,
 * `--base <ref>` as the escape hatch).
 */

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { describe, expect, test, vi } from "vitest"
import { resetWorktree, resolveBranchArg, resolveWorktreeTargetPath, worktreeAddEnvironment } from "./worktree.ts"

const AT_ORIGIN_MAIN = { base: "refs/remotes/origin/main" }

/** @failure Forced reset deletes an unrelated author ref before its owner can archive it,
 * or stops recutting the same-named slot branch; dirty state must retain preserve-first custody.
 * @level l2 @consumer hosts composing reset with their own branch-retirement policy
 * Pure branch-argument coverage never runs removal, preservation or recreation.
 */
test.each(["distinct", "same"] as const)(
  "native forced reset preserves author custody: %s branch",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "bearly-reset-author-"))
    const repo = join(root, "repo")
    const origin = join(root, "origin.git")
    const beforeCwd = process.cwd()
    const beforePoolSlots = process.env.BEARLY_WORKTREE_POOL_SLOTS
    const messages: string[] = []
    using _info = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
      messages.push(values.map(String).join(" "))
    })
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
    try {
      git(root, "init", "-q", "-b", "main", repo)
      git(root, "init", "-q", "--bare", "-b", "main", origin)
      git(repo, "config", "user.email", "reset@example.test")
      git(repo, "config", "user.name", "reset")
      git(repo, "config", "worktree.poolRoot", ".pool")
      writeFileSync(join(repo, "package.json"), '{"name":"reset-author","private":true,"workspaces":[]}\n')
      writeFileSync(join(repo, ".gitignore"), ".pool/\n")
      writeFileSync(join(repo, "payload.txt"), "base\n")
      git(repo, "add", ".")
      git(repo, "commit", "-qm", "base")
      git(repo, "remote", "add", "origin", origin)
      git(repo, "push", "-q", "origin", "main")
      git(repo, "fetch", "-q", "origin", "main")
      const base = git(repo, "rev-parse", "HEAD")
      const slot = resolveWorktreeTargetPath(repo, "wt0", { poolRoot: join(repo, ".pool") })
      mkdirSync(join(repo, ".pool"))
      git(repo, "worktree", "add", "-q", "-b", "wt0", slot, "HEAD")
      const branch = mode === "same" ? "wt0" : "topic/author"
      if (mode === "distinct") git(slot, "checkout", "-q", "-b", branch)
      writeFileSync(join(slot, "payload.txt"), "committed author work\n")
      git(slot, "commit", "-qam", "author work")
      const tip = git(slot, "rev-parse", "HEAD")
      writeFileSync(join(slot, "payload.txt"), "uncommitted author work\n")
      process.chdir(repo)
      process.env.BEARLY_WORKTREE_POOL_SLOTS = JSON.stringify(["wt0"])
      await resetWorktree("wt0", {
        force: true,
        install: false,
        direnv: false,
        hooks: false,
        saveAheadAs: "retirement-proof",
      })
      expect(git(slot, "rev-parse", "HEAD")).toBe(base)
      expect(git(repo, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`)).toBe(
        mode === "same" ? base : tip,
      )
      const archiveRefs = git(repo, "for-each-ref", "--format=%(refname)", "refs/archive/").split("\n")
      expect(archiveRefs).toHaveLength(1)
      const archiveRef = archiveRefs[0]
      expect(archiveRef).toContain("retirement-proof-")
      expect(git(repo, "show", `${archiveRef}:payload.txt`)).toBe("uncommitted author work")
      expect(git(repo, "rev-parse", `${archiveRef}^`)).toBe(tip)
      expect(git(origin, "rev-parse", `${archiveRef}`)).toBe(git(repo, "rev-parse", `${archiveRef}`))
      expect(git(origin, "show", `${archiveRef}:payload.txt`)).toBe("uncommitted author work")
      expect(messages).toContainEqual(expect.stringContaining("reset"))
    } finally {
      process.chdir(beforeCwd)
      if (beforePoolSlots === undefined) delete process.env.BEARLY_WORKTREE_POOL_SLOTS
      else process.env.BEARLY_WORKTREE_POOL_SLOTS = beforePoolSlots
      safeRemoveSync(root, { within: tmpdir(), allowMissing: true })
    }
  },
  30_000,
)

describe("worktree-add hook boundary", () => {
  test("the creator suppresses hook-owned submodule cloning before its reference-aware materializer runs", () => {
    expect(worktreeAddEnvironment({ PATH: "/bin", KM_NO_AUTO_SUBMODULE_UPDATE: "0" })).toEqual({
      PATH: "/bin",
      KM_NO_AUTO_SUBMODULE_UPDATE: "1",
    })
  })
})

describe("resolveBranchArg — pool slots land at the base (@km/inbox/19363)", () => {
  test("pool slot with a STALE local wtN branch RESETS to the base (-B), never reuse", () => {
    // The exact 19363 shape: slot was on task/<id>; a stale local wt0 ref
    // survives the reset. Pre-fix this returned ["wt0"] (reuse the stale SHA).
    expect(
      resolveBranchArg({
        isPoolSlot: true,
        branchExists: true,
        remoteBranchExists: true,
        branchName: "wt0",
        ...AT_ORIGIN_MAIN,
      }),
    ).toEqual(["-B", "wt0", "refs/remotes/origin/main"])
  })

  test("pool slot with no existing branch also lands at the base", () => {
    expect(
      resolveBranchArg({
        isPoolSlot: true,
        branchExists: false,
        remoteBranchExists: false,
        branchName: "wt3",
        ...AT_ORIGIN_MAIN,
      }),
    ).toEqual(["-B", "wt3", "refs/remotes/origin/main"])
  })

  test("non-slot existing branch is reused (stable upstream, behavior unchanged; base does not apply)", () => {
    expect(
      resolveBranchArg({
        isPoolSlot: false,
        branchExists: true,
        remoteBranchExists: false,
        branchName: "feat/x",
        ...AT_ORIGIN_MAIN,
      }),
    ).toEqual(["feat/x"])
  })

  test("non-slot remote-only branch is tracked (base does not apply)", () => {
    expect(
      resolveBranchArg({
        isPoolSlot: false,
        branchExists: false,
        remoteBranchExists: true,
        branchName: "feat/y",
        ...AT_ORIGIN_MAIN,
      }),
    ).toEqual(["feat/y"])
  })
})

describe("resolveBranchArg — a brand-new branch is cut AT the base, never from local HEAD (worktree-base-origin-main)", () => {
  test("non-slot brand-new branch carries the origin/main start point (pre-fix: bare -b → local HEAD, born 226 behind)", () => {
    expect(
      resolveBranchArg({
        isPoolSlot: false,
        branchExists: false,
        remoteBranchExists: false,
        branchName: "feat/z",
        ...AT_ORIGIN_MAIN,
      }),
    ).toEqual(["-b", "feat/z", "refs/remotes/origin/main"])
  })

  test("explicit --base <ref> overrides the start point for a new branch (offline escape hatch)", () => {
    expect(
      resolveBranchArg({
        isPoolSlot: false,
        branchExists: false,
        remoteBranchExists: false,
        branchName: "feat/z",
        base: "v1.2.3",
      }),
    ).toEqual(["-b", "feat/z", "v1.2.3"])
  })

  test("explicit --base <ref> overrides the start point for a pool slot too", () => {
    expect(
      resolveBranchArg({
        isPoolSlot: true,
        branchExists: false,
        remoteBranchExists: false,
        branchName: "wt7",
        base: "main",
      }),
    ).toEqual(["-B", "wt7", "main"])
  })
})
