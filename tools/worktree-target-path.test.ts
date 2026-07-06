/**
 * resolveWorktreeTargetPath — verbs that operate on an EXISTING worktree
 * (remove/reset/merge) must accept a filesystem path, not only a slot name.
 *
 * Regression for the absolute-path remove UX: `bun worktree remove
 * /abs/path/to/repo-wt-ci` used to join `<parent>/<repo>-/abs/path/...` and
 * fail with a nonsense "Worktree not found" (found during the 2026-07 CI-lane
 * worktree migration; km bead 20881-tooling-cleanup).
 */

import { describe, expect, test } from "vitest"
import { resolve } from "path"
import { resolveWorktreeTargetPath } from "./worktree.ts"

const GIT_ROOT = "/Users/dev/Code/hh"

describe("resolveWorktreeTargetPath", () => {
  test("bare slot name keeps the historic sibling contract", () => {
    expect(resolveWorktreeTargetPath(GIT_ROOT, "wt3")).toBe("/Users/dev/Code/hh-wt3")
  })

  test("already-prefixed sibling dir name is not double-prefixed", () => {
    expect(resolveWorktreeTargetPath(GIT_ROOT, "hh-wt-ci")).toBe("/Users/dev/Code/hh-wt-ci")
  })

  test("absolute path is used as-is (the CI-lane migration shape)", () => {
    expect(resolveWorktreeTargetPath(GIT_ROOT, "/Users/dev/Code/pim/km-wt-ci")).toBe("/Users/dev/Code/pim/km-wt-ci")
  })

  test("absolute path with trailing slash normalizes", () => {
    expect(resolveWorktreeTargetPath(GIT_ROOT, "/Users/dev/Code/pim/km-wt-ci/")).toBe("/Users/dev/Code/pim/km-wt-ci")
  })

  test("relative path containing a separator resolves from cwd", () => {
    expect(resolveWorktreeTargetPath(GIT_ROOT, "../hh-wt5")).toBe(resolve("../hh-wt5"))
  })

  test("dot resolves to cwd (remove-the-one-I-am-in shape)", () => {
    expect(resolveWorktreeTargetPath(GIT_ROOT, ".")).toBe(resolve("."))
  })
})
