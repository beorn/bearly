/**
 * clearStrandedBranch — a failed create does not leave the branch it cut behind.
 *
 * Regression for @hh/tooling/27848: `git worktree add -b <branch> <path>`
 * creates the branch ref BEFORE it prepares the checkout, so a failure after
 * that point strands the ref. Observed 2026-10-06 by @dev/luna2: a `create`
 * whose pool path was not writable printed "Failed to create worktree" and left
 * `feat/<name>` in `git branch --list`. The last test pins the git behavior
 * this helper exists for, so a future git that stops stranding still passes the
 * unit tests but the reason for the helper stays recorded.
 *
 * Scope: only a ref THIS create made is removed (`existedBefore === false`).
 * The checkout-existing form and the tracking form are left exactly as they
 * were, so a pre-existing branch can never be destroyed by a failed create.
 */

import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { clearStrandedBranch } from "./worktree.ts"

let root: string

function git(args: string[], cwd: string = root) {
  return spawnSync("git", args, { cwd, encoding: "utf8" })
}

function branchExists(name: string, cwd: string = root): boolean {
  return git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], cwd).status === 0
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bearly-stranded-"))
  git(["init", "-q", "."])
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"])
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("clearStrandedBranch", () => {
  test("removes a branch this create made, and says so", async () => {
    git(["branch", "stranded"])

    const result = await clearStrandedBranch(root, "stranded", false)

    expect(result.removed).toBe(true)
    expect(result.reason).toContain("refs/heads/stranded")
    expect(branchExists("stranded")).toBe(false)
  })

  test("never touches a branch that existed before the create", async () => {
    git(["branch", "survivor"])
    const before = git(["rev-parse", "refs/heads/survivor"]).stdout.trim()

    const result = await clearStrandedBranch(root, "survivor", true)

    expect(result.removed).toBe(false)
    expect(result.reason).toContain("existed before")
    expect(branchExists("survivor")).toBe(true)
    expect(git(["rev-parse", "refs/heads/survivor"]).stdout.trim()).toBe(before)
  })

  test("reports the no-op when git created nothing to remove", async () => {
    const result = await clearStrandedBranch(root, "never-created", false)

    expect(result.removed).toBe(false)
    expect(result.reason).toContain("no refs/heads/never-created was created")
  })

  test("a real failed `git worktree add -b` does strand the ref, and this helper clears it", async () => {
    const readonly = join(root, "readonly")
    chmodSync(root, 0o700)
    spawnSync("mkdir", ["-p", readonly])
    chmodSync(readonly, 0o500)
    try {
      const add = git(["worktree", "add", "-b", "cut-by-create", join(readonly, "slot")])
      expect(add.status).not.toBe(0)
      // The git behavior itself: the ref survives a failed add.
      expect(branchExists("cut-by-create")).toBe(true)

      const result = await clearStrandedBranch(root, "cut-by-create", false)

      expect(result.removed).toBe(true)
      expect(branchExists("cut-by-create")).toBe(false)
    } finally {
      chmodSync(readonly, 0o700)
    }
  })
})
