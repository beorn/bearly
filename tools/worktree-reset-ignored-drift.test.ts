/**
 * 29302 — an OLD slot must not be refused over output its setup regenerates.
 *
 * `reset` compares a slot's setup inputs (package.json, bun.lock, .envrc and
 * the workspace package dirs) against the recreate base. When those inputs
 * differ — exactly what an old slot looks like — the comparison used to zero
 * the WHOLE setup-derived set, so `node_modules/`, each workspace package's
 * `node_modules/` and `dist/` were named as unproven ignored payload and the
 * reset was refused. The refusal listed every build output in the slot, hiding
 * any genuinely unprovable row among them.
 *
 * The drift changes WHICH packages exist, never whether the output this
 * checkout's own setup produced is disposable. These tests pin that an old
 * checkout's setup-derived install/build output is named and admitted across a
 * drifted declaration, while an authored ignored file is still refused and
 * named ALONE. The drift here is substantive, not cosmetic: the slot carries a
 * whole package the recreate base does not have, so the base would never
 * regenerate that package's output, and it is still disposable.
 *
 * @failure An old slot — setup inputs drifted from the recreate base — is refused a reset over the
 *          install/build output its own declared setup produced (root and per-workspace-package
 *          `node_modules`, a dist-only package's `dist`), and the refusal names every one of them as
 *          unproven ignored payload, so a genuinely unprovable row is buried in the list (29302; it
 *          blocked recycling dev-wt3 on 2026-10-14, which had to move every named path aside by hand).
 * @level   l2 — the real reset admission path and bearly's pool mechanics against hermetic git repositories
 * @consumer @i/16-work-lifecycle/29302-worktree-reset-refuses-an-old-slot-over-regenerable-ignored-output
 * @testonly none
 */

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest"
import { removeWorktree, resetWorktree, resolveWorktreeTargetPath } from "./worktree.ts"

const roots: string[] = []

// `reset` reports the outputs it keeps regenerable through `info` (console.log).
// The repo's vitest setup fails a test that leaks console output, so every test
// here captures it; the first test reads the capture to assert the naming.
let info: MockInstance<(...args: unknown[]) => void>

beforeEach(() => {
  info = vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  // The no-raw-deletes guard polices every delete in a tree it judges: teardown
  // routes through the guarded primitive instead of a bare rmSync.
  for (const root of roots.splice(0)) safeRemoveSync(root, { within: tmpdir(), allowMissing: true })
})

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args as string[], { cwd, encoding: "utf8" })
}

/**
 * A repo shaped like hh's: a lockfile, a `packages/*` workspace, and a
 * dist-only-exports package. A pool slot `wt0` is created at origin/main, then
 * its `package.json` drifts — the old-slot state that triggered the refusal.
 * Its only ignored content is install/build output its own declared setup made.
 */
function driftedSlot(): { repo: string; slot: string } {
  const root = mkdtempSync(join(tmpdir(), "bearly-wt-drift-"))
  roots.push(root)
  const repo = join(root, "repo")
  const origin = join(root, "origin.git")
  const pool = join(root, "pool")

  git(root, ["init", "-q", "-b", "main", repo])
  git(repo, ["config", "user.email", "t@example.test"])
  git(repo, ["config", "user.name", "t"])
  git(repo, ["config", "worktree.poolRoot", pool])
  writeFileSync(join(repo, ".gitignore"), "node_modules\ndist\nprecious.bin\n")
  writeFileSync(join(repo, "package.json"), '{"name":"repro","private":true,"workspaces":["packages/*"]}\n')
  writeFileSync(join(repo, "bun.lock"), "{}\n")
  mkdirSync(join(repo, "packages", "dep"), { recursive: true })
  writeFileSync(
    join(repo, "packages", "dep", "package.json"),
    '{"name":"@repro/dep","exports":{".":"./dist/index.js"},"scripts":{"build":"true"}}\n',
  )
  writeFileSync(join(repo, "seed.txt"), "seed\n")
  git(repo, ["add", "-A"])
  git(repo, ["commit", "-qm", "seed"])
  git(root, ["init", "-q", "--bare", origin])
  git(repo, ["remote", "add", "origin", origin])
  git(repo, ["push", "-q", "origin", "main"])
  git(repo, ["fetch", "-q", "origin", "main"])

  const slotPath = resolveWorktreeTargetPath(repo, "wt0", { poolRoot: pool })
  mkdirSync(slotPath, { recursive: true })
  git(repo, ["worktree", "add", "-q", "-B", "wt0", slotPath, "origin/main"])

  // The slot drifts from the base substantively, not cosmetically: it carries a
  // whole workspace package the base does not have. The recreate base would
  // never produce that package's install/build output, and it is disposable.
  mkdirSync(join(slotPath, "packages", "legacy"), { recursive: true })
  writeFileSync(
    join(slotPath, "packages", "legacy", "package.json"),
    '{"name":"@repro/legacy","exports":{".":"./dist/index.js"},"scripts":{"build":"true"}}\n',
  )
  git(slotPath, ["add", "-A"])
  git(slotPath, ["commit", "-qm", "slot drift"])

  // Ignored content this checkout's setup produced: root and per-package
  // installs, plus each dist-only package's build output.
  mkdirSync(join(slotPath, "node_modules"), { recursive: true })
  writeFileSync(join(slotPath, "node_modules", "dep.txt"), "install output\n")
  mkdirSync(join(slotPath, "packages", "dep", "node_modules"), { recursive: true })
  writeFileSync(join(slotPath, "packages", "dep", "node_modules", "dep.txt"), "install output\n")
  mkdirSync(join(slotPath, "packages", "dep", "dist"), { recursive: true })
  writeFileSync(join(slotPath, "packages", "dep", "dist", "index.js"), "built\n")
  mkdirSync(join(slotPath, "packages", "legacy", "node_modules"), { recursive: true })
  writeFileSync(join(slotPath, "packages", "legacy", "node_modules", "dep.txt"), "install output\n")
  mkdirSync(join(slotPath, "packages", "legacy", "dist"), { recursive: true })
  writeFileSync(join(slotPath, "packages", "legacy", "dist", "index.js"), "built\n")
  return { repo, slot: slotPath }
}

const RESET = { force: true, install: true, direnv: false, hooks: false, admitOnly: true } as const

describe("reset admits old setup-derived output across a drifted setup declaration (29302)", () => {
  test("setup-output-only ignored content no longer refuses, and the outputs are named", async () => {
    const { repo } = driftedSlot()

    process.chdir(repo)
    await expect(resetWorktree("wt0", RESET)).resolves.toBeUndefined()

    const named = info.mock.calls.map((call) => String(call[0])).join("\n")
    expect(named).toContain("disposable: node_modules")
    expect(named).toContain("disposable: packages/dep/node_modules")
    expect(named).toContain("disposable: packages/dep/dist")
    expect(named).toContain("disposable: packages/legacy/node_modules")
    expect(named).toContain("disposable: packages/legacy/dist")
  })

  test("an authored ignored file is still refused, and named alone", async () => {
    const { repo, slot } = driftedSlot()
    writeFileSync(join(slot, "precious.bin"), "authored payload\n")

    process.chdir(repo)
    const failure = await resetWorktree("wt0", RESET).then(
      () => null,
      (cause: unknown) => String(cause),
    )
    expect(failure).toMatch(/precious\.bin/)
    expect(failure).not.toMatch(/node_modules|packages\/dep\/dist|packages\/legacy/)
  })
})

/**
 * A pool slot whose nested submodule was never initialized — exactly the state
 * a plain `git worktree add` leaves, and the state that refused removal with no
 * way forward (30529).
 */
function slotWithUninitializedSubmodule(): { repo: string; slot: string } {
  const root = mkdtempSync(join(tmpdir(), "bearly-wt-uninit-submodule-"))
  roots.push(root)
  const repo = join(root, "repo")
  const nested = join(root, "nested")
  const origin = join(root, "origin.git")
  const pool = join(root, "pool")

  git(root, ["init", "-q", "-b", "main", nested])
  git(nested, ["config", "user.email", "t@example.test"])
  git(nested, ["config", "user.name", "t"])
  writeFileSync(join(nested, "nested.txt"), "nested\n")
  git(nested, ["add", "-A"])
  git(nested, ["commit", "-qm", "nested seed"])

  git(root, ["init", "-q", "-b", "main", repo])
  git(repo, ["config", "user.email", "t@example.test"])
  git(repo, ["config", "user.name", "t"])
  git(repo, ["config", "worktree.poolRoot", pool])
  writeFileSync(join(repo, ".gitignore"), "node_modules\n")
  writeFileSync(join(repo, "seed.txt"), "seed\n")
  git(repo, ["add", "-A"])
  git(repo, ["commit", "-qm", "seed"])
  git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", nested, "components/nested"])
  git(repo, ["commit", "-qm", "add nested submodule"])

  git(root, ["init", "-q", "--bare", origin])
  git(repo, ["remote", "add", "origin", origin])
  git(repo, ["push", "-q", "origin", "main"])
  git(repo, ["fetch", "-q", "origin", "main"])

  const slotPath = resolveWorktreeTargetPath(repo, "wt0", { poolRoot: pool })
  mkdirSync(slotPath, { recursive: true })
  git(repo, ["worktree", "add", "-q", "-B", "wt0", slotPath, "origin/main"])
  return { repo, slot: slotPath }
}

describe("remove names the cure for an uninitialized nested submodule (30529)", () => {
  test("a plain remove refuses with the exact init command", async () => {
    const { repo, slot } = slotWithUninitializedSubmodule()

    process.chdir(repo)
    const failure = await removeWorktree("wt0", {}).then(
      () => null,
      (cause: unknown) => String(cause),
    )

    expect(failure).toMatch(/uninitialized submodules/)
    expect(failure).toContain(`git -C ${slot} submodule update --init components/nested`)
  })

  test("--admit prints the classification it used for each nested submodule", async () => {
    const { repo } = slotWithUninitializedSubmodule()

    process.chdir(repo)
    const failure = await removeWorktree("wt0", { admitOnly: true }).then(
      () => null,
      (cause: unknown) => String(cause),
    )

    expect(failure).toMatch(/uninitialized submodules/)
    const named = info.mock.calls.map((call) => String(call[0])).join("\n")
    expect(named).toContain("components/nested: uninitialized; contents cannot be classified")
  })
})
