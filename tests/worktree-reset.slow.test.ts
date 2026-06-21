/**
 * Round-trip test for `bun worktree reset <name>`.
 *
 * Scenario:
 *   1. Build a superproject repo.
 *   2. Create a worktree via createWorktree().
 *   3. Make uncommitted modifications in the worktree.
 *   4. Add a local commit ahead of origin/main in the worktree.
 *   5. Call resetWorktree(name, { force: true }).
 *   6. Verify the worktree dir exists, status is clean, branch tip matches origin/main.
 *
 * Marked .slow because it shells out to git and does real filesystem work.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest"
import { $ } from "bun"
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

import { createWorktree, removeWorktree, resetWorktree } from "../tools/worktree.ts"

let sandbox: string
let consoleLogSpy: ReturnType<typeof vi.spyOn>
let consoleErrorSpy: ReturnType<typeof vi.spyOn>

async function initRepo(path: string): Promise<void> {
  mkdirSync(path, { recursive: true })
  await $`cd ${path} && git init -q -b main && git config user.email t@t && git config user.name t`.quiet()
}

async function commitAll(path: string, message: string): Promise<void> {
  await $`cd ${path} && git add -A && git commit -qm ${message}`.quiet()
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wt-reset-"))
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  consoleLogSpy.mockRestore()
  consoleErrorSpy.mockRestore()
  if (sandbox && existsSync(sandbox)) {
    rmSync(sandbox, { recursive: true, force: true })
  }
})

describe("worktree reset round-trip", () => {
  test("reset --force discards uncommitted + ahead commits, leaves a clean slot at origin/main", async () => {
    const mainRepo = join(sandbox, "main")

    // Build the upstream repo and push origin/main
    await initRepo(mainRepo)
    writeFileSync(join(mainRepo, "README.md"), "main\n")
    await commitAll(mainRepo, "main-init")
    // Set up a fake remote so the worktree can have an origin/main to compare against.
    const upstreamRepo = join(sandbox, "origin.git")
    await $`git init --bare -q -b main ${upstreamRepo}`.quiet()
    await $`cd ${mainRepo} && git remote add origin ${upstreamRepo} && git push -q origin main`.quiet()

    const worktreeName = "wt-test"
    const worktreePath = join(sandbox, "main-wt-test")
    const origCwd = process.cwd()
    try {
      process.chdir(mainRepo)

      // Create the worktree
      await createWorktree(worktreeName, undefined, { install: false, direnv: false, hooks: false })
      expect(existsSync(worktreePath)).toBe(true)

      // Pollute the worktree: uncommitted file + a local-only commit
      writeFileSync(join(worktreePath, "uncommitted.txt"), "dirt\n")
      writeFileSync(join(worktreePath, "ahead.txt"), "ahead\n")
      await $`cd ${worktreePath} && git add ahead.txt && git commit -qm "local-only commit"`.quiet()
      writeFileSync(join(worktreePath, "uncommitted.txt"), "dirt-after-commit\n")

      // Sanity-check pollution
      const dirtyBefore = await $`cd ${worktreePath} && git status --short`.text()
      expect(dirtyBefore.length).toBeGreaterThan(0)
      const aheadBefore = parseInt(
        (await $`cd ${worktreePath} && git rev-list --count origin/main..HEAD`.text()).trim(),
        10,
      )
      expect(aheadBefore).toBe(1)

      // Reset
      await resetWorktree(worktreeName, { force: true, install: false, direnv: false, hooks: false })

      // Worktree still exists
      expect(existsSync(worktreePath)).toBe(true)

      // Worktree is clean
      const dirtyAfter = await $`cd ${worktreePath} && git status --short`.text()
      expect(dirtyAfter.trim()).toBe("")

      // Worktree HEAD is at origin/main (zero commits ahead)
      const aheadAfter = parseInt(
        (await $`cd ${worktreePath} && git rev-list --count origin/main..HEAD`.text()).trim(),
        10,
      )
      expect(aheadAfter).toBe(0)

      // Uncommitted file is gone
      expect(existsSync(join(worktreePath, "uncommitted.txt"))).toBe(false)
      // Ahead-commit file is gone
      expect(existsSync(join(worktreePath, "ahead.txt"))).toBe(false)
    } finally {
      process.chdir(origCwd)
    }
  }, 60_000)

  test("a pool slot left on a task/<id> branch resets to current origin/main, not a stale wtN ref (@km/inbox/19363)", async () => {
    const mainRepo = join(sandbox, "main")
    await initRepo(mainRepo)
    writeFileSync(join(mainRepo, "README.md"), "main\n")
    await commitAll(mainRepo, "main-init")
    const upstreamRepo = join(sandbox, "origin.git")
    await $`git init --bare -q -b main ${upstreamRepo}`.quiet()
    await $`cd ${mainRepo} && git remote add origin ${upstreamRepo} && git push -q origin main`.quiet()

    const slot = "wt0" // a REAL pool-slot name (matches /^wt\d+$/), unlike "wt-test"
    const worktreePath = join(sandbox, "main-wt0")
    const origCwd = process.cwd()
    try {
      process.chdir(mainRepo)
      await createWorktree(slot, undefined, { install: false, direnv: false, hooks: false })
      expect(existsSync(worktreePath)).toBe(true)

      // The slot moves onto a task/<id> branch (the post-15493 model). The `wt0`
      // pet branch is now stale — it stays pinned at the original origin/main SHA.
      await $`cd ${worktreePath} && git checkout -q -b task/foo`.quiet()

      // origin/main advances (other beads land) → the stale wt0 ref falls behind.
      writeFileSync(join(mainRepo, "moved.txt"), "moved\n")
      await commitAll(mainRepo, "main-moves")
      await $`cd ${mainRepo} && git push -q origin main`.quiet()

      // Reset. removeWorktree deletes the worktree's branch (task/foo); the stale
      // `wt0` ref survives. Pre-19363 the recreate reused it → slot landed 1 behind.
      await resetWorktree(slot, { force: true, install: false, direnv: false, hooks: false })

      expect(existsSync(worktreePath)).toBe(true)
      const ahead = parseInt((await $`cd ${worktreePath} && git rev-list --count origin/main..HEAD`.text()).trim(), 10)
      const behind = parseInt((await $`cd ${worktreePath} && git rev-list --count HEAD..origin/main`.text()).trim(), 10)
      expect(ahead).toBe(0)
      expect(behind).toBe(0) // the 19363 bug landed the slot 1 behind on the stale wt0 ref
      const slotBranch = (await $`cd ${worktreePath} && git rev-parse --abbrev-ref HEAD`.text()).trim()
      expect(slotBranch).toBe("wt0")
    } finally {
      process.chdir(origCwd)
    }
  }, 60_000)

  test("reset without --force refuses when worktree has uncommitted changes", async () => {
    const mainRepo = join(sandbox, "main")

    await initRepo(mainRepo)
    writeFileSync(join(mainRepo, "README.md"), "main\n")
    await commitAll(mainRepo, "main-init")
    const upstreamRepo = join(sandbox, "origin.git")
    await $`git init --bare -q -b main ${upstreamRepo}`.quiet()
    await $`cd ${mainRepo} && git remote add origin ${upstreamRepo} && git push -q origin main`.quiet()

    const worktreeName = "wt-refuse"
    const worktreePath = join(sandbox, "main-wt-refuse")
    const origCwd = process.cwd()
    try {
      process.chdir(mainRepo)

      await createWorktree(worktreeName, undefined, { install: false, direnv: false, hooks: false })
      writeFileSync(join(worktreePath, "uncommitted.txt"), "dirt\n")

      // Without --force, should refuse and throw (or exit) — capture by expecting it to throw.
      // Since the tool calls process.exit, we catch the SystemExit via try/catch on a Promise rejection,
      // OR by checking that the file still exists after the call.
      // For testability, resetWorktree should THROW instead of process.exit when refusing.
      await expect(
        resetWorktree(worktreeName, { force: false, install: false, direnv: false, hooks: false }),
      ).rejects.toThrow(/uncommitted|dirty/i)

      // Uncommitted file still there — refusal preserved state
      expect(existsSync(join(worktreePath, "uncommitted.txt"))).toBe(true)
    } finally {
      process.chdir(origCwd)
    }
  }, 30_000)

  test("reset --save-ahead-as <slug> saves ahead commits to wip/<slug> before discarding", async () => {
    const mainRepo = join(sandbox, "main")

    await initRepo(mainRepo)
    writeFileSync(join(mainRepo, "README.md"), "main\n")
    await commitAll(mainRepo, "main-init")
    const upstreamRepo = join(sandbox, "origin.git")
    await $`git init --bare -q -b main ${upstreamRepo}`.quiet()
    await $`cd ${mainRepo} && git remote add origin ${upstreamRepo} && git push -q origin main`.quiet()

    const worktreeName = "wt-save"
    const worktreePath = join(sandbox, "main-wt-save")
    const origCwd = process.cwd()
    try {
      process.chdir(mainRepo)

      await createWorktree(worktreeName, undefined, { install: false, direnv: false, hooks: false })

      // Add 2 ahead commits in the worktree
      writeFileSync(join(worktreePath, "ahead1.txt"), "first\n")
      await $`cd ${worktreePath} && git add ahead1.txt && git commit -qm "ahead-commit-1"`.quiet()
      writeFileSync(join(worktreePath, "ahead2.txt"), "second\n")
      await $`cd ${worktreePath} && git add ahead2.txt && git commit -qm "ahead-commit-2"`.quiet()

      const aheadTipSha = (await $`cd ${worktreePath} && git rev-parse HEAD`.text()).trim()
      expect(aheadTipSha.length).toBe(40)

      // Reset with save-ahead — should preserve the 2 commits on wip/<slug>
      await resetWorktree(worktreeName, {
        force: true,
        saveAheadAs: "demo",
        install: false,
        direnv: false,
        hooks: false,
      })

      // Save branch exists in main repo and points at the pre-reset tip
      const saveBranchSha = (await $`cd ${mainRepo} && git rev-parse refs/heads/wip/demo`.text()).trim()
      expect(saveBranchSha).toBe(aheadTipSha)

      // Save branch contains both ahead commits
      const saveLog = await $`cd ${mainRepo} && git log refs/heads/wip/demo --format='%s' -3`.text()
      expect(saveLog).toContain("ahead-commit-1")
      expect(saveLog).toContain("ahead-commit-2")

      // Worktree is fresh (0 ahead of origin/main, ahead files gone)
      const aheadAfter = parseInt(
        (await $`cd ${worktreePath} && git rev-list --count origin/main..HEAD`.text()).trim(),
        10,
      )
      expect(aheadAfter).toBe(0)
      expect(existsSync(join(worktreePath, "ahead1.txt"))).toBe(false)
      expect(existsSync(join(worktreePath, "ahead2.txt"))).toBe(false)
    } finally {
      process.chdir(origCwd)
    }
  }, 60_000)

  test("reset --retarget-origin force-pushes origin/<name> back to origin/main before recreate", async () => {
    const mainRepo = join(sandbox, "main")

    await initRepo(mainRepo)
    writeFileSync(join(mainRepo, "README.md"), "main\n")
    await commitAll(mainRepo, "main-init")
    const upstreamRepo = join(sandbox, "origin.git")
    await $`git init --bare -q -b main ${upstreamRepo}`.quiet()
    await $`cd ${mainRepo} && git remote add origin ${upstreamRepo} && git push -q origin main`.quiet()

    const worktreeName = "wt-retarget"
    const worktreePath = join(sandbox, "main-wt-retarget")
    const origCwd = process.cwd()
    try {
      process.chdir(mainRepo)

      await createWorktree(worktreeName, undefined, { install: false, direnv: false, hooks: false })

      // Make a stale ahead commit in the worktree, then push it to origin/<name>
      // so origin has divergent history. This is the scenario --retarget-origin
      // is designed to resolve.
      writeFileSync(join(worktreePath, "ahead.txt"), "stale\n")
      await $`cd ${worktreePath} && git add ahead.txt && git commit -qm "stale ahead"`.quiet()
      // The actual branch name depends on createWorktree's policy — pool slots
      // (wtN) get a plain name, other names get `feat/<name>`. Read it back.
      const branchName = (await $`cd ${worktreePath} && git rev-parse --abbrev-ref HEAD`.text()).trim()
      await $`cd ${worktreePath} && git push -q origin HEAD:refs/heads/${branchName}`.quiet()

      // Verify origin/<branch> is ahead of origin/main before reset
      const aheadBefore = parseInt(
        (await $`cd ${mainRepo} && git rev-list --count origin/main..origin/${branchName}`.text()).trim(),
        10,
      )
      expect(aheadBefore).toBe(1)

      // Reset with --retarget-origin
      await resetWorktree(worktreeName, {
        force: true,
        retargetOrigin: true,
        install: false,
        direnv: false,
        hooks: false,
      })

      // origin/<branch> now matches origin/main (zero ahead)
      const aheadAfter = parseInt(
        (await $`cd ${mainRepo} && git rev-list --count origin/main..origin/${branchName}`.text()).trim(),
        10,
      )
      expect(aheadAfter).toBe(0)

      // Worktree is fresh (no stale ahead)
      const wtAhead = parseInt(
        (await $`cd ${worktreePath} && git rev-list --count origin/main..HEAD`.text()).trim(),
        10,
      )
      expect(wtAhead).toBe(0)
      expect(existsSync(join(worktreePath, "ahead.txt"))).toBe(false)
    } finally {
      process.chdir(origCwd)
    }
  }, 60_000)

  test("reset --force on a slot-pattern name (wtN) lands at origin/main even when origin/wtN is ahead", async () => {
    // Pins @km/all/bun-worktree-reset-silent-no-op. Earlier behavior: when
    // origin/wtN had stale commits ahead of origin/main (left over from a
    // prior agent's push), `bun worktree reset wtN --force` silently
    // inherited that state on recreate — the slot stayed at the pre-reset
    // SHA despite the success banner. The createWorktree branch-resolution
    // fell into the "Tracking remote branch" path because refs/remotes/
    // origin/wtN existed.
    //
    // Slot-pattern names (wt0..wt9) are anonymous pool resources, not
    // stable shared branches. A reset must always land at origin/main
    // regardless of origin/wtN tracking state. --retarget-origin is the
    // explicit knob for force-pushing origin/wtN back; this test is the
    // default-path invariant.
    //
    // Cross-link: @agent/1's wt1 reset 2026-05-12 hit this same root cause
    // (origin/wt1 carried stale state); chief recreated manually after the
    // tooling failed silently.
    const mainRepo = join(sandbox, "main")

    await initRepo(mainRepo)
    writeFileSync(join(mainRepo, "README.md"), "main\n")
    await commitAll(mainRepo, "main-init")
    const upstreamRepo = join(sandbox, "origin.git")
    await $`git init --bare -q -b main ${upstreamRepo}`.quiet()
    await $`cd ${mainRepo} && git remote add origin ${upstreamRepo} && git push -q origin main`.quiet()

    const worktreeName = "wt3" // /^wt\d+$/ — slot pattern triggers the bug
    const worktreePath = join(sandbox, "main-wt3")
    const origCwd = process.cwd()
    try {
      process.chdir(mainRepo)

      // Create slot wt3 once and pollute origin/wt3 with an ahead commit,
      // simulating a prior agent that pushed slot WIP. This is what causes
      // the silent-no-op on a future reset.
      await createWorktree(worktreeName, undefined, { install: false, direnv: false, hooks: false })
      writeFileSync(join(worktreePath, "stale.txt"), "ahead-from-prior-agent\n")
      await $`cd ${worktreePath} && git add stale.txt && git commit -qm "stale prior-agent commit"`.quiet()
      await $`cd ${worktreePath} && git push -q origin HEAD:refs/heads/${worktreeName}`.quiet()

      // Confirm the stale state on origin/wt3 (one commit ahead of origin/main).
      const originAhead = parseInt(
        (await $`cd ${mainRepo} && git rev-list --count origin/main..origin/${worktreeName}`.text()).trim(),
        10,
      )
      expect(originAhead).toBe(1)

      // Reset --force WITHOUT --retarget-origin. The slot pattern alone
      // should force the recreate to start from origin/main; the user has
      // not asked us to mutate origin/wt3.
      await resetWorktree(worktreeName, { force: true, install: false, direnv: false, hooks: false })

      // Slot is at origin/main (zero ahead) — NOT inheriting origin/wt3.
      const wtAhead = parseInt(
        (await $`cd ${worktreePath} && git rev-list --count origin/main..HEAD`.text()).trim(),
        10,
      )
      expect(wtAhead, "slot wt3 should land at origin/main, not origin/wt3").toBe(0)

      // The stale ahead file from the prior agent's push is gone.
      expect(existsSync(join(worktreePath, "stale.txt"))).toBe(false)

      // origin/wt3 is left untouched — the test pins the recreate-side
      // invariant. `--retarget-origin` is still the opt-in for force-
      // pushing origin/wt3 back to origin/main (covered by the test above).
      const originAheadAfter = parseInt(
        (await $`cd ${mainRepo} && git rev-list --count origin/main..origin/${worktreeName}`.text()).trim(),
        10,
      )
      expect(originAheadAfter).toBe(1)
    } finally {
      process.chdir(origCwd)
    }
  }, 60_000)

  test("reset --save-ahead-as on a clean worktree is a no-op for the save branch", async () => {
    const mainRepo = join(sandbox, "main")

    await initRepo(mainRepo)
    writeFileSync(join(mainRepo, "README.md"), "main\n")
    await commitAll(mainRepo, "main-init")
    const upstreamRepo = join(sandbox, "origin.git")
    await $`git init --bare -q -b main ${upstreamRepo}`.quiet()
    await $`cd ${mainRepo} && git remote add origin ${upstreamRepo} && git push -q origin main`.quiet()

    const worktreeName = "wt-clean-save"
    const origCwd = process.cwd()
    try {
      process.chdir(mainRepo)

      await createWorktree(worktreeName, undefined, { install: false, direnv: false, hooks: false })

      // No ahead commits, no dirt. Reset with --save-ahead-as should NOT create wip/clean.
      await resetWorktree(worktreeName, {
        force: true,
        saveAheadAs: "clean",
        install: false,
        direnv: false,
        hooks: false,
      })

      // Save branch should NOT exist — nothing was ahead, so nothing to save
      const exists = await $`cd ${mainRepo} && git show-ref --verify refs/heads/wip/clean`.nothrow().quiet()
      expect(exists.exitCode).not.toBe(0)
    } finally {
      process.chdir(origCwd)
    }
  }, 30_000)
})
