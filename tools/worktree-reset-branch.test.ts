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

import { describe, expect, test } from "vitest"
import { resolveBranchArg, worktreeAddEnvironment } from "./worktree.ts"

const AT_ORIGIN_MAIN = { base: "refs/remotes/origin/main" }

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
