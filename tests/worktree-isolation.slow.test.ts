/**
 * Round-trip test for worktree submodule isolation.
 *
 * Scenario:
 *   1. Create a superproject repo with a submodule.
 *   2. Run createWorktree() to make a worktree with the submodule.
 *   3. Modify the submodule's working tree inside the worktree.
 *   4. Verify the main repo's submodule working tree is untouched.
 *   5. Run removeWorktree() and verify no orphan .git/worktrees/<name>/modules/*.
 *
 * Marked .slow because it shells out to git and does real filesystem work;
 * included in test:vendor / test:all but excluded from test:fast.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest"
import { $ } from "bun"
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { tmpdir } from "os"

import { createWorktree, removeWorktree, getWorktreeModulesDir, getSubmoduleHeads } from "../tools/worktree.ts"

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
  sandbox = mkdtempSync(join(tmpdir(), "wt-iso-"))
  // Silence the tool's user-facing output — the vitest setup treats console
  // output as test failure by default.
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

describe("worktree submodule isolation round-trip", () => {
  test("worktree changes to submodule don't leak to main, and remove leaves no orphans", async () => {
    const mainRepo = join(sandbox, "main")
    const subRepo = join(sandbox, "sub")

    // Build the upstream submodule repo
    await initRepo(subRepo)
    writeFileSync(join(subRepo, "file.txt"), "original\n")
    await commitAll(subRepo, "sub-init")

    // Build the superproject with vendor/sub as a submodule
    await initRepo(mainRepo)
    writeFileSync(join(mainRepo, "README.md"), "main\n")
    await commitAll(mainRepo, "main-init")
    await $`cd ${mainRepo} && git -c protocol.file.allow=always submodule add ${subRepo} vendor/sub`.quiet()
    await commitAll(mainRepo, "add-sub")

    // Record the main repo's submodule file content before worktree work
    const mainSubFile = join(mainRepo, "vendor/sub/file.txt")
    const mainContentsBefore = readFileSync(mainSubFile, "utf8")
    expect(mainContentsBefore).toBe("original\n")

    // Run createWorktree from inside mainRepo
    const worktreeName = "iso-test"
    const origCwd = process.cwd()
    try {
      process.chdir(mainRepo)
      await createWorktree(worktreeName, undefined, {
        install: false,
        direnv: false,
        hooks: false,
      })
    } finally {
      process.chdir(origCwd)
    }

    // createWorktree uses `${repoName}-${name}` in the parent dir
    const worktreeDirName = `main-${worktreeName}`
    const worktreePath = join(dirname(mainRepo), worktreeDirName)
    expect(existsSync(worktreePath)).toBe(true)
    const wtSubFile = join(worktreePath, "vendor/sub/file.txt")
    expect(existsSync(wtSubFile)).toBe(true)

    // Verify per-worktree modules dir exists (isolation)
    // git uses the basename of the worktree path as the worktree identifier
    const modulesDir = await getWorktreeModulesDir(mainRepo, worktreeDirName)
    expect(modulesDir).toBeDefined()
    if (!modulesDir) throw new Error("modulesDir undefined")
    expect(existsSync(modulesDir)).toBe(true)
    expect(existsSync(join(modulesDir, "vendor/sub"))).toBe(true)

    // Submodule heads at this point should match the main repo
    const heads = await getSubmoduleHeads(worktreePath)
    expect(heads["vendor/sub"]).toBeDefined()

    // Modify the submodule inside the worktree
    writeFileSync(wtSubFile, "modified-in-worktree\n")
    expect(readFileSync(wtSubFile, "utf8")).toBe("modified-in-worktree\n")

    // Main repo's submodule file must be unchanged — this is the isolation invariant
    const mainContentsAfter = readFileSync(mainSubFile, "utf8")
    expect(mainContentsAfter).toBe("original\n")

    // Commit the change inside the worktree's submodule to prove the .git is
    // independent (would fail if .git were shared with the main's submodule)
    await $`cd ${wtSubFile.replace(/\/file\.txt$/, "")} && git add -A && git -c user.email=t@t -c user.name=t commit -qm wt-change`.quiet()
    const wtHeads = await getSubmoduleHeads(worktreePath)
    const mainHeads = await getSubmoduleHeads(mainRepo)
    expect(wtHeads["vendor/sub"]).not.toBe(mainHeads["vendor/sub"])

    // Tear down: removeWorktree() must leave no orphan modules dir.
    // removeWorktree re-derives `${repoName}-${name}` internally, so pass
    // the bare name, not the directory name.
    try {
      process.chdir(mainRepo)
      await removeWorktree(worktreeName, { force: true })
    } finally {
      process.chdir(origCwd)
    }

    expect(existsSync(worktreePath)).toBe(false)
    expect(existsSync(modulesDir)).toBe(false)
  }, 60_000)
})
