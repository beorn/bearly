/**
 * Preserve-first guarantee for destructive worktree operations.
 *
 * The plateau gap (L4→L5): `bun worktree create/reset/remove` USED to silently
 * discard a slot's uncommitted work + ahead-of-origin/main commits on the
 * destructive step (`git worktree remove --force`, `-B <slot> origin/main`).
 * On 2026-07-14 `bun worktree create wt2 --allow-dirty` reset-to-origin/main
 * and threw away uncommitted 21102 work — the silvery half lived inside a
 * dirty SUBMODULE, the class of loss the superproject snapshot alone misses.
 *
 * The L5 invariant proved here: NO destructive step ever loses dirty-or-ahead
 * state. Before removing/force-resetting a slot the tooling AUTO-preserves to a
 * durable `wip/<slot>-preserve-<UTCstamp>` ref (built from a temporary index —
 * never `git stash`), prints it loudly, and continues (exit 0, zero prompts).
 * Submodule dirt is preserved into the MAIN submodule store so it survives the
 * per-worktree isolated-store teardown.
 *
 * Marked .slow because it shells out to git and does real filesystem work;
 * included in test:vendor / test:all but excluded from test:fast.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest"
import { $ } from "bun"
import { existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs"
import { join, dirname } from "path"
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

/** Build a superproject with a fake origin/main. Returns { mainRepo }. */
async function buildMain(): Promise<string> {
  const mainRepo = join(sandbox, "main")
  await initRepo(mainRepo)
  writeFileSync(join(mainRepo, "README.md"), "main\n")
  await commitAll(mainRepo, "main-init")
  const upstreamRepo = join(sandbox, "origin.git")
  await $`git init --bare -q -b main ${upstreamRepo}`.quiet()
  await $`cd ${mainRepo} && git remote add origin ${upstreamRepo} && git push -q origin main`.quiet()
  return mainRepo
}

/** All preserve refs for a slot, in a repo (main or submodule). */
async function preserveRefs(repo: string, slot: string): Promise<string[]> {
  // Interpolate the pattern + format as JS strings so Bun's shell escapes them
  // (no local glob expansion; git receives the literal `*` pattern).
  const pattern = `refs/heads/wip/${slot}-preserve-*`
  const fmt = "%(refname)"
  const res = await $`cd ${repo} && git for-each-ref --format=${fmt} ${pattern}`.nothrow().quiet()
  return res.stdout.toString().trim().split("\n").filter(Boolean)
}

/** Did any console.log line mention the preserve ref? (loud-print proof) */
function loggedRef(): string | undefined {
  for (const call of consoleLogSpy.mock.calls) {
    const line = call.map((a) => String(a)).join(" ")
    const m = /wip\/\S*preserve-\S+/.exec(line)
    if (m) return m[0]
  }
  return undefined
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wt-preserve-"))
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  consoleLogSpy.mockRestore()
  consoleErrorSpy.mockRestore()
  if (sandbox && existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true })
}, 20_000)

describe("worktree preserve-first (L5): destructive ops never discard", () => {
  test("reset --force PRESERVES uncommitted work to wip/<slot>-preserve-* (does not discard)", async () => {
    const mainRepo = await buildMain()
    const slot = "wt5"
    const worktreePath = join(sandbox, "main-wt5")
    const origCwd = process.cwd()
    try {
      process.chdir(mainRepo)
      await createWorktree(slot, undefined, { install: false, direnv: false, hooks: false })

      // Uncommitted work in the slot (tracked-modified + untracked-new).
      writeFileSync(join(worktreePath, "README.md"), "main\ndirty-edit\n")
      writeFileSync(join(worktreePath, "scratch.txt"), "precious-uncommitted\n")

      // Reset --force must NOT throw / exit — it preserves and continues.
      await resetWorktree(slot, { force: true, install: false, direnv: false, hooks: false })

      // Slot is recreated clean at origin/main.
      expect(existsSync(worktreePath)).toBe(true)
      const dirtyAfter = (await $`cd ${worktreePath} && git status --short`.text()).trim()
      expect(dirtyAfter).toBe("")

      // Exactly one preserve ref, and it carries the EXACT dirty content.
      const refs = await preserveRefs(mainRepo, slot)
      expect(refs.length).toBe(1)
      const ref = refs[0]!
      const readme = await $`cd ${mainRepo} && git show ${ref}:README.md`.text()
      expect(readme).toBe("main\ndirty-edit\n")
      const scratch = await $`cd ${mainRepo} && git show ${ref}:scratch.txt`.text()
      expect(scratch).toBe("precious-uncommitted\n")

      // Loud: the ref was printed to the operator.
      expect(loggedRef()).toBeDefined()
    } finally {
      process.chdir(origCwd)
    }
  }, 60_000)

  test("reset --force PRESERVES ahead-of-origin/main commits", async () => {
    const mainRepo = await buildMain()
    const slot = "wt6"
    const worktreePath = join(sandbox, "main-wt6")
    const origCwd = process.cwd()
    try {
      process.chdir(mainRepo)
      await createWorktree(slot, undefined, { install: false, direnv: false, hooks: false })

      writeFileSync(join(worktreePath, "feature.txt"), "shipped\n")
      await $`cd ${worktreePath} && git add feature.txt && git commit -qm "ahead work"`.quiet()
      const aheadTip = (await $`cd ${worktreePath} && git rev-parse HEAD`.text()).trim()

      await resetWorktree(slot, { force: true, install: false, direnv: false, hooks: false })

      const refs = await preserveRefs(mainRepo, slot)
      expect(refs.length).toBe(1)
      const ref = refs[0]!
      // Clean-but-ahead → ref points directly at the ahead tip (no snapshot commit).
      const refSha = (await $`cd ${mainRepo} && git rev-parse ${ref}`.text()).trim()
      expect(refSha).toBe(aheadTip)
      const body = await $`cd ${mainRepo} && git show ${ref}:feature.txt`.text()
      expect(body).toBe("shipped\n")

      // Slot recreated at origin/main (0 ahead).
      const aheadAfter = parseInt(
        (await $`cd ${worktreePath} && git rev-list --count origin/main..HEAD`.text()).trim(),
        10,
      )
      expect(aheadAfter).toBe(0)
    } finally {
      process.chdir(origCwd)
    }
  }, 60_000)

  test("removeWorktree --force PRESERVES submodule-only dirt into the MAIN submodule store", async () => {
    // The 21102 loss class: dirt lived only inside a submodule. The superproject
    // snapshot records the gitlink, but the submodule's dirty FILE content lives
    // in the per-worktree isolated object store that removeWorktree tears down.
    // Preservation must transfer it into the durable MAIN submodule store first.
    const mainRepo = join(sandbox, "main")
    const subRepo = join(sandbox, "sub")
    await initRepo(subRepo)
    writeFileSync(join(subRepo, "file.txt"), "original\n")
    await commitAll(subRepo, "sub-init")

    await initRepo(mainRepo)
    writeFileSync(join(mainRepo, "README.md"), "main\n")
    await commitAll(mainRepo, "main-init")
    await $`cd ${mainRepo} && git -c protocol.file.allow=always submodule add ${subRepo} vendor/sub`.quiet()
    await commitAll(mainRepo, "add-sub")

    const slot = "sub-dirt"
    const worktreePath = join(dirname(mainRepo), `main-${slot}`)
    const origCwd = process.cwd()
    try {
      process.chdir(mainRepo)
      await createWorktree(slot, undefined, { install: false, direnv: false, hooks: false })
      expect(existsSync(worktreePath)).toBe(true)

      // Dirty ONLY inside the submodule (tracked-modified + untracked-new).
      writeFileSync(join(worktreePath, "vendor/sub/file.txt"), "modified-in-worktree\n")
      writeFileSync(join(worktreePath, "vendor/sub/extra.txt"), "untracked-precious\n")

      // Force-remove — must preserve before destroying the isolated sub store.
      await removeWorktree(slot, { force: true })
      expect(existsSync(worktreePath)).toBe(false)

      // The submodule preserve ref lives durably in the MAIN submodule store.
      const mainSub = join(mainRepo, "vendor/sub")
      const subRefs = await preserveRefs(mainSub, slot)
      expect(subRefs.length).toBe(1)
      const subRef = subRefs[0]!
      const filetxt = await $`cd ${mainSub} && git show ${subRef}:file.txt`.text()
      expect(filetxt).toBe("modified-in-worktree\n")
      const extratxt = await $`cd ${mainSub} && git show ${subRef}:extra.txt`.text()
      expect(extratxt).toBe("untracked-precious\n")

      // The superproject preserve ref threads its gitlink to the sub preserve commit.
      const superRefs = await preserveRefs(mainRepo, slot)
      expect(superRefs.length).toBe(1)
      const gitlink = (await $`cd ${mainRepo} && git ls-tree ${superRefs[0]!} vendor/sub`.text()).trim()
      const subTip = (await $`cd ${mainSub} && git rev-parse ${subRef}`.text()).trim()
      expect(gitlink).toContain(subTip)
    } finally {
      process.chdir(origCwd)
    }
  }, 60_000)

  test("create force-resets an orphan ahead slot branch only AFTER preserving it", async () => {
    // A stale `wtN` branch left ahead of origin/main with no live slot dir: the
    // pool-slot recreate does `git worktree add -B wtN origin/main`, which
    // force-moves the ref and discards the ahead commits. Preserve them first.
    const mainRepo = await buildMain()
    const slot = "wt7"
    const worktreePath = join(sandbox, "main-wt7")
    const origCwd = process.cwd()
    try {
      process.chdir(mainRepo)
      await createWorktree(slot, undefined, { install: false, direnv: false, hooks: false })
      writeFileSync(join(worktreePath, "orphan.txt"), "orphan-ahead\n")
      await $`cd ${worktreePath} && git add orphan.txt && git commit -qm "orphan ahead commit"`.quiet()
      const orphanTip = (await $`cd ${worktreePath} && git rev-parse HEAD`.text()).trim()

      // Remove the slot dir but KEEP the ahead wt7 branch (do not delete branch).
      await removeWorktree(slot, { force: true })
      const branchSha = (await $`cd ${mainRepo} && git rev-parse refs/heads/${slot}`.text()).trim()
      expect(branchSha).toBe(orphanTip)

      // Recreate the slot — the -B origin/main reset would discard wt7's ahead
      // commit; preserve must fire first.
      await createWorktree(slot, undefined, { install: false, direnv: false, hooks: false })
      const refs = await preserveRefs(mainRepo, slot)
      expect(refs.length).toBeGreaterThanOrEqual(1)
      const found = await $`cd ${mainRepo} && git rev-parse ${refs[0]!}`.text()
      expect(found.trim()).toBe(orphanTip)
      const body = await $`cd ${mainRepo} && git show ${refs[0]!}:orphan.txt`.text()
      expect(body).toBe("orphan-ahead\n")

      // Slot recreated at origin/main.
      const aheadAfter = parseInt(
        (await $`cd ${worktreePath} && git rev-list --count origin/main..HEAD`.text()).trim(),
        10,
      )
      expect(aheadAfter).toBe(0)
    } finally {
      process.chdir(origCwd)
    }
  }, 60_000)
})
