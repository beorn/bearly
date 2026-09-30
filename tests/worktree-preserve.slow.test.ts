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
 * Fresh creation refuses an orphan slot ref with commits absent from its base;
 * choosing an exact destination does not authorize replacing that ref.
 * Submodule dirt is preserved into the MAIN submodule store so it survives the
 * per-worktree isolated-store teardown.
 *
 * Marked .slow because it shells out to git and does real filesystem work;
 * included in test:vendor / test:all but excluded from test:fast.
 * @reach fs-walk <fixture-only: buildMain and worktrees use the mkdtempSync sandbox>
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest"
import { $ } from "bun"
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { tmpdir } from "os"

import { createWorktree, removeWorktree, resetWorktree } from "../tools/worktree.ts"

let sandbox: string
let consoleLogSpy: ReturnType<typeof vi.spyOn>
let consoleErrorSpy: ReturnType<typeof vi.spyOn>
let originalPoolSlots: string | undefined

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

async function buildSubmoduleMain(): Promise<string> {
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
    const line = call.map((a: unknown) => String(a)).join(" ")
    const m = /wip\/\S*preserve-\S+/.exec(line)
    if (m) return m[0]
  }
  return undefined
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wt-preserve-"))
  originalPoolSlots = process.env.BEARLY_WORKTREE_POOL_SLOTS
  process.env.BEARLY_WORKTREE_POOL_SLOTS = JSON.stringify(["wt5", "wt6", "wt7"])
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  if (originalPoolSlots === undefined) delete process.env.BEARLY_WORKTREE_POOL_SLOTS
  else process.env.BEARLY_WORKTREE_POOL_SLOTS = originalPoolSlots
  consoleLogSpy.mockRestore()
  consoleErrorSpy.mockRestore()
  if (sandbox && existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true })
}, 20_000)

describe("worktree preserve-first (L5): destructive ops never discard", () => {
  /** @failure ignored dependency output is discarded without selected regeneration, or blocks a regenerating reset
   * @level l2 @consumer #26139 reset setup @testonly none */
  test.each(["lockfile", "workspace-only", "unnamed-workspace"] as const)(
    "reset admits ignored %s output only when its setup regenerates it",
    async (setup) => {
      const mainRepo = await buildMain()
      writeFileSync(join(mainRepo, ".gitignore"), "node_modules/\ndist/\n")
      writeFileSync(join(mainRepo, "package.json"), JSON.stringify({ name: "fixture", workspaces: ["packages/*"] }))
      mkdirSync(join(mainRepo, "packages/local"), { recursive: true })
      writeFileSync(
        join(mainRepo, "packages/local/package.json"),
        JSON.stringify({
          ...(setup === "unnamed-workspace" ? {} : { name: "local-fixture" }),
          version: "1.0.0",
          exports: "./dist/index.js",
          scripts: { build: "bun build.ts" },
        }),
      )
      writeFileSync(
        join(mainRepo, "packages/local/build.ts"),
        'await Bun.write("dist/index.js", "export default 42\\n")\n',
      )
      if (setup === "lockfile") await $`cd ${mainRepo} && bun install`.quiet()
      await commitAll(mainRepo, "dependency setup")
      await $`cd ${mainRepo} && git push -q origin main`.quiet()
      const destination = join(sandbox, "wt-@dev5")
      const origCwd = process.cwd()
      try {
        process.chdir(mainRepo)
        await createWorktree("wt5", undefined, { destination, install: true, direnv: false, hooks: false })
        const oldOutput = join(destination, "node_modules/previous.txt")
        mkdirSync(dirname(oldOutput), { recursive: true })
        writeFileSync(oldOutput, "old generated output\n")
        writeFileSync(join(destination, "packages/local/dist/index.js"), "old generated build\n")
        await expect(
          resetWorktree("wt5", { destination, force: true, install: false, direnv: false, hooks: false }),
        ).rejects.toThrow("ignored")
        expect(readFileSync(oldOutput, "utf8")).toBe("old generated output\n")
        if (setup === "unnamed-workspace") {
          // Symlink setup skips packages without a name. Their presence cannot
          // qualify an unrelated ignored node_modules payload for deletion.
          const refsBefore = await $`git -C ${mainRepo} for-each-ref --format=${"%(refname) %(objectname)"}`.text()
          await expect(
            resetWorktree("wt5", { destination, force: true, install: true, direnv: false, hooks: false }),
          ).rejects.toThrow("ignored")
          expect(readFileSync(oldOutput, "utf8")).toBe("old generated output\n")
          expect(await $`git -C ${mainRepo} for-each-ref --format=${"%(refname) %(objectname)"}`.text()).toBe(
            refsBefore,
          )
          return
        }
        await resetWorktree("wt5", { destination, force: true, install: true, direnv: false, hooks: false })
        expect(existsSync(oldOutput)).toBe(false)
        expect(readFileSync(join(destination, "packages/local/dist/index.js"), "utf8")).toBe("export default 42\n")
        expect(await Bun.file(join(destination, "node_modules/local-fixture/package.json")).json()).toMatchObject({
          name: "local-fixture",
        })
        if (setup === "workspace-only") {
          // The cached origin/main still declares generation, while the actual
          // next base no longer does. Admission must use the recreated base.
          const publisher = join(sandbox, "publisher")
          await $`git clone -q ${join(sandbox, "origin.git")} ${publisher}`.quiet()
          await $`git -C ${publisher} config user.email t@t`.quiet()
          await $`git -C ${publisher} config user.name t`.quiet()
          writeFileSync(join(publisher, "package.json"), JSON.stringify({ name: "fixture", workspaces: [] }))
          await commitAll(publisher, "stop generating workspace output")
          await $`git -C ${publisher} push -q origin main`.quiet()
          writeFileSync(oldOutput, "keep until regeneration is proven\n")
          const refsBefore = await $`git -C ${mainRepo} for-each-ref --format=${"%(refname) %(objectname)"}`.text()
          await expect(
            resetWorktree("wt5", { destination, force: true, install: true, direnv: false, hooks: false }),
          ).rejects.toThrow("ignored")
          expect(readFileSync(oldOutput, "utf8")).toBe("keep until regeneration is proven\n")
          expect(await $`git -C ${mainRepo} for-each-ref --format=${"%(refname) %(objectname)"}`.text()).toBe(
            refsBefore,
          )
        }
      } finally {
        process.chdir(origCwd)
      }
    },
    60_000,
  )

  /** @failure force reset silently drops ignored root or submodule payload
   * @level l2 @consumer #26139 relocated reset @testonly none */
  test.each(["root", "submodule", "uninitialized", "changed-submodule-setup"] as const)(
    "reset refuses ignored %s payload with repository and path, preserving bytes and refs",
    async (location) => {
      const mainRepo = await buildMain()
      let source = mainRepo
      if (location !== "root") {
        source = join(sandbox, "sub-source")
        await initRepo(source)
        writeFileSync(join(source, "file.txt"), "submodule\n")
      }
      const changedSetup = location === "changed-submodule-setup"
      const payload = changedSetup ? "packages/local/dist/private notes\n.env" : "private notes\n.env"
      writeFileSync(join(source, ".gitignore"), "*.env\n")
      if (changedSetup) {
        mkdirSync(join(source, "packages/local"), { recursive: true })
        writeFileSync(
          join(source, "packages/local/package.json"),
          JSON.stringify({ name: "local-fixture", exports: "./src/index.ts" }),
        )
        writeFileSync(
          join(source, "packages/local/build.ts"),
          'await Bun.write("dist/index.js", "export default 42\\n")\n',
        )
        writeFileSync(
          join(mainRepo, "package.json"),
          JSON.stringify({ name: "fixture", workspaces: ["vendor/sub/packages/*"] }),
        )
        writeFileSync(join(mainRepo, ".gitignore"), "node_modules/\n")
      }
      await commitAll(source, "ignore private files")
      if (location !== "root") {
        await $`cd ${mainRepo} && git -c protocol.file.allow=always submodule add -q ${source} vendor/sub`.quiet()
        await commitAll(mainRepo, "add submodule")
      }
      await $`cd ${mainRepo} && git push -q origin main`.quiet()
      const destination = join(sandbox, "wt-@dev5")
      const origCwd = process.cwd()
      try {
        process.chdir(mainRepo)
        await createWorktree("wt5", undefined, { destination, install: false, direnv: false, hooks: false })
        const repository = location === "root" ? destination : join(destination, "vendor/sub")
        if (changedSetup) {
          // Only the current submodule declares this output. Its selected base
          // has source exports, so recreation will not generate dist.
          writeFileSync(
            join(repository, "packages/local/package.json"),
            JSON.stringify({ name: "local-fixture", exports: "./dist/index.js", scripts: { build: "bun build.ts" } }),
          )
        }
        mkdirSync(dirname(join(repository, payload)), { recursive: true })
        writeFileSync(join(repository, payload), "precious ignored bytes\n")
        if (location === "uninitialized") rmSync(join(repository, ".git"))
        const refs = await $`cd ${mainRepo} && git for-each-ref --format=${"%(refname) %(objectname)"}`.text()
        const subRefs =
          location === "uninitialized"
            ? undefined
            : await $`cd ${repository} && git for-each-ref --format=${"%(refname) %(objectname)"}`.text()
        const attempt = resetWorktree("wt5", {
          destination,
          force: true,
          install: changedSetup,
          direnv: false,
          hooks: false,
        })
        await expect(attempt).rejects.toThrow(location === "uninitialized" ? "uninitialized" : "ignored")
        await expect(attempt).rejects.toThrow(repository)
        if (location !== "uninitialized") {
          // Native Git groups this fully ignored subtree as a directory.
          await expect(attempt).rejects.toThrow(JSON.stringify(changedSetup ? "packages/local/dist/" : payload))
        }
        expect(readFileSync(join(repository, payload), "utf8")).toBe("precious ignored bytes\n")
        expect(await $`cd ${mainRepo} && git for-each-ref --format=${"%(refname) %(objectname)"}`.text()).toBe(refs)
        if (subRefs !== undefined) {
          expect(await $`cd ${repository} && git for-each-ref --format=${"%(refname) %(objectname)"}`.text()).toBe(
            subRefs,
          )
        }
      } finally {
        process.chdir(origCwd)
      }
    },
    60_000,
  )

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
    const mainRepo = await buildSubmoduleMain()

    const slot = "sub-dirt"
    const worktreePath = join(dirname(mainRepo), `main-${slot}`)
    const origCwd = process.cwd()
    try {
      process.chdir(mainRepo)
      // This hermetic repository deliberately has no remote; make its local
      // seed commit the explicit branch base instead of testing network policy.
      await createWorktree(slot, undefined, { install: false, direnv: false, hooks: false, base: "HEAD" })
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

  /** @failure Bearly destroys lender module objects before GitSuper can preserve a live borrower
   * @level l2 @consumer #26139 worktree removal @testonly none */
  test("remove preserves a borrower reading a unique packed lender commit", async () => {
    const mainRepo = await buildSubmoduleMain()
    const lender = join(sandbox, "main-lender")
    const borrower = join(sandbox, "main-borrower")
    const lenderSub = join(lender, "vendor/sub")
    const borrowerSub = join(borrower, "vendor/sub")
    const mainSub = join(mainRepo, "vendor/sub")
    const origCwd = process.cwd()
    try {
      process.chdir(mainRepo)
      const setup = { install: false, direnv: false, hooks: false, base: "HEAD" }
      await createWorktree("lender", undefined, setup)
      await $`git -C ${lenderSub} config user.email t@t`.quiet()
      await $`git -C ${lenderSub} config user.name t`.quiet()
      writeFileSync(join(lenderSub, "private.txt"), "unique lender object\n")
      await commitAll(lenderSub, "unique lender commit")
      const commit = (await $`git -C ${lenderSub} rev-parse HEAD`.text()).trim()
      await commitAll(lender, "record lender gitlink")
      await $`git -C ${lenderSub} repack -a -d`.quiet()
      await createWorktree("borrower", undefined, setup)
      const lenderObjects = (
        await $`git -C ${lenderSub} rev-parse --path-format=absolute --git-path objects`.text()
      ).trim()
      const mainObjects = (await $`git -C ${mainSub} rev-parse --path-format=absolute --git-path objects`.text()).trim()
      const alternates = (
        await $`git -C ${borrowerSub} rev-parse --path-format=absolute --git-path objects/info/alternates`.text()
      ).trim()
      writeFileSync(alternates, `${lenderObjects}\n${mainObjects}\n`)
      await $`git -C ${borrowerSub} update-ref refs/heads/borrowed ${commit}`.quiet()
      await $`git -C ${borrowerSub} symbolic-ref HEAD refs/heads/borrowed`.quiet()
      expect((await $`git -C ${mainSub} cat-file -e ${commit}`.nothrow().quiet()).exitCode).not.toBe(0)
      expect(await $`git -C ${borrowerSub} show HEAD:private.txt`.text()).toBe("unique lender object\n")

      await removeWorktree(lender, { force: true })
      expect(existsSync(lender)).toBe(false)
      expect(readFileSync(alternates, "utf8")).not.toContain(lenderObjects)
      expect(await $`git -C ${borrowerSub} show HEAD:private.txt`.text()).toBe("unique lender object\n")
      const fsck = await $`git -C ${borrowerSub} fsck --full`.nothrow().quiet()
      expect(fsck.exitCode).toBe(0)
      expect(fsck.stderr.toString()).toBe("")
    } finally {
      process.chdir(origCwd)
    }
  }, 60_000)

  test("create refuses an orphan slot with commits absent from the chosen base", async () => {
    // A stale `wtN` branch left ahead of origin/main with no live slot dir: the
    // pool-slot recreate does `git worktree add -B wtN origin/main`, which
    // must refuse before moving the ref; removal's existing preservation is separate.
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

      const preservesBefore = await preserveRefs(mainRepo, slot)
      const originalBase = (await $`cd ${mainRepo} && git rev-parse main`.text()).trim()
      const recreate = (base?: string) =>
        createWorktree(slot, undefined, {
          install: false,
          direnv: false,
          hooks: false,
          ...(base === undefined ? {} : { base }),
        })
      await expect(recreate()).rejects.toThrow(/process.exit unexpectedly called with "1"/)
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("wt7"))
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("origin/main"))
      expect(existsSync(worktreePath)).toBe(false)
      expect((await $`cd ${mainRepo} && git rev-parse refs/heads/${slot}`.text()).trim()).toBe(orphanTip)
      expect(await preserveRefs(mainRepo, slot)).toEqual(preservesBefore)

      // Even when origin contains the work, an explicit older base must not
      // overwrite it. The decision belongs to the selected base, not origin/main.
      await $`cd ${mainRepo} && git push -q origin ${orphanTip}:refs/heads/main && git fetch -q origin main`.quiet()
      await expect(recreate(originalBase)).rejects.toThrow(/process.exit unexpectedly called with "1"/)
      expect(existsSync(worktreePath)).toBe(false)
      expect((await $`cd ${mainRepo} && git rev-parse refs/heads/${slot}`.text()).trim()).toBe(orphanTip)

      // A base containing the slot's commits is safe and needs no preservation.
      await recreate()
      expect((await $`cd ${worktreePath} && git rev-parse HEAD`.text()).trim()).toBe(orphanTip)
      expect(await preserveRefs(mainRepo, slot)).toEqual(preservesBefore)
    } finally {
      process.chdir(origCwd)
    }
  }, 60_000)
})
