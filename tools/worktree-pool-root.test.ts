/**
 * Configurable worktree pool root (km bead 20888-contained-worktree-pool).
 *
 * The pool of persistent slots (`<repo>-wtN`) historically lives as SIBLINGS
 * of the repo (`<repoParent>/<repo>-wtN`), which sprawls the parent dir. The
 * `worktree.poolRoot` git config key relocates the pool — typically to a
 * contained, git-ignored dir inside the repo (`<repo>/.worktrees/<repo>-wtN`).
 *
 * Contract:
 *   - unset            → sibling parent (historic behavior, zero change)
 *   - relative value   → resolved under the repo root (contained pool)
 *   - absolute value   → used as-is
 *   - empty value      → loud config error (never a silent fallback)
 *
 * Existing slots are found in BOTH locations (configured pool first, then the
 * legacy sibling), so flipping the config never orphans a live slot.
 */

import { describe, expect, test } from "vitest"
import {
  isCanonicalSlotPath,
  resolvePoolRoot,
  resolveWorktreeTargetPath,
  slotPathCandidates,
} from "./worktree.ts"

const GIT_ROOT = "/Users/dev/Code/hh"
const CONTAINED = "/Users/dev/Code/hh/.worktrees"

describe("resolvePoolRoot — worktree.poolRoot config semantics", () => {
  test("unset config keeps the historic sibling parent", () => {
    expect(resolvePoolRoot(GIT_ROOT, () => undefined)).toBe("/Users/dev/Code")
  })

  test("relative value is a contained pool under the repo root", () => {
    expect(resolvePoolRoot(GIT_ROOT, () => ".worktrees")).toBe(CONTAINED)
  })

  test("absolute value is used as-is", () => {
    expect(resolvePoolRoot(GIT_ROOT, () => "/mnt/pool")).toBe("/mnt/pool")
  })

  test("trailing slash normalizes", () => {
    expect(resolvePoolRoot(GIT_ROOT, () => ".worktrees/")).toBe(CONTAINED)
  })

  test("empty value fails loud — misconfiguration is never a silent sibling fallback", () => {
    expect(() => resolvePoolRoot(GIT_ROOT, () => "")).toThrow(/worktree\.poolRoot/)
    expect(() => resolvePoolRoot(GIT_ROOT, () => "   ")).toThrow(/worktree\.poolRoot/)
  })

  test("a path with no .git entry has no config surface — resolves to the sibling default", () => {
    // Pure path math on non-repos (fake roots in tests, derived candidates):
    // the default reader answers "unset", never an error.
    expect(resolvePoolRoot("/no/such/repo/anywhere")).toBe("/no/such/repo")
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
    expect(resolveWorktreeTargetPath(GIT_ROOT, "/abs/km-wt-ci", { poolRoot: CONTAINED, exists })).toBe(
      "/abs/km-wt-ci",
    )
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
