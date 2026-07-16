/**
 * resolveBranchArg — pool slots always (re)create at origin/main.
 *
 * Regression for @km/inbox/19363: `bun worktree reset wtN --force` recreated
 * the slot on a STALE local `wtN` pet branch (N-behind origin/main) when the
 * slot had last run a `task/<id>` branch, instead of landing at origin/main.
 * Root cause: the branch-exists check fired BEFORE the pool-slot rule, so a
 * surviving stale `wtN` ref shortcut to "use existing" at its ancient SHA.
 */

import { describe, expect, test } from "vitest"
import { resolveBranchArg } from "./worktree.ts"

describe("resolveBranchArg — pool slots land at origin/main (@km/inbox/19363)", () => {
  test("pool slot with a STALE local wtN branch RESETS to origin/main (-B), never reuse", () => {
    // The exact 19363 shape: slot was on task/<id>; a stale local wt0 ref
    // survives the reset. Pre-fix this returned ["wt0"] (reuse the stale SHA).
    expect(
      resolveBranchArg({ isPoolSlot: true, branchExists: true, remoteBranchExists: true, branchName: "wt0" }),
    ).toEqual(["-B", "wt0", "origin/main"])
  })

  test("pool slot with no existing branch also lands at origin/main", () => {
    expect(
      resolveBranchArg({ isPoolSlot: true, branchExists: false, remoteBranchExists: false, branchName: "wt3" }),
    ).toEqual(["-B", "wt3", "origin/main"])
  })

  test("non-slot existing branch is reused (stable upstream, behavior unchanged)", () => {
    expect(
      resolveBranchArg({ isPoolSlot: false, branchExists: true, remoteBranchExists: false, branchName: "feat/x" }),
    ).toEqual(["feat/x"])
  })

  test("non-slot remote-only branch is tracked", () => {
    expect(
      resolveBranchArg({ isPoolSlot: false, branchExists: false, remoteBranchExists: true, branchName: "feat/y" }),
    ).toEqual(["feat/y"])
  })

  // Base selection for new branches generalized beyond slots on 2026-07-15 —
  // see worktree-base-ref.test.ts. This case previously expected a base-less
  // ["-b", "feat/z"], which git resolves against local HEAD.
  test("non-slot brand-new branch is created at origin/main", () => {
    expect(
      resolveBranchArg({ isPoolSlot: false, branchExists: false, remoteBranchExists: false, branchName: "feat/z" }),
    ).toEqual(["-b", "feat/z", "origin/main"])
  })
})
