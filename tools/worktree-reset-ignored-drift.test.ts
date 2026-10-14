/**
 * 29302 — an OLD slot must not be refused over output its setup regenerates.
 *
 * `reset` compares a slot's setup inputs (package.json, bun.lock, .envrc and
 * the workspace package dirs) against the recreate base. When those inputs
 * differ — exactly what an old slot looks like — the comparison used to zero
 * the WHOLE regenerable set, so `node_modules/`, each workspace package's
 * `node_modules/` and `dist/` were named as unproven ignored payload and the
 * reset was refused. The refusal listed every build output in the slot, hiding
 * any genuinely unprovable row among them.
 *
 * The drift changes WHICH packages exist, never whether their install/build
 * output is disposable. These tests pin that: regenerable setup output stays
 * regenerable across a drifted setup declaration and is NAMED as such, while an
 * authored ignored file is still refused and named ALONE.
 *
 * @failure An old slot — setup inputs drifted from the recreate base — is refused a reset over output the
 *          recreated setup regenerates (root and per-workspace-package `node_modules`, a dist-only
 *          package's `dist`), and the refusal names every one of them as unproven ignored payload, so a
 *          genuinely unprovable row is buried in the list (29302; it blocked recycling dev-wt3 2026-10-14).
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
import { resetWorktree, resolveWorktreeTargetPath } from "./worktree.ts"

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
 * Its only ignored content is install/build output the recreated setup makes.
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

  // The slot's setup declaration drifts from the base: the old-slot condition.
  writeFileSync(join(slotPath, "package.json"), '{"name":"repro","private":true,"workspaces":["packages/*"]}\n\n')
  git(slotPath, ["add", "-A"])
  git(slotPath, ["commit", "-qm", "slot drift"])

  // Ignored content the recreated setup regenerates: root and per-package
  // installs, plus the dist-only package's build output.
  mkdirSync(join(slotPath, "node_modules"), { recursive: true })
  writeFileSync(join(slotPath, "node_modules", "dep.txt"), "install output\n")
  mkdirSync(join(slotPath, "packages", "dep", "node_modules"), { recursive: true })
  writeFileSync(join(slotPath, "packages", "dep", "node_modules", "dep.txt"), "install output\n")
  mkdirSync(join(slotPath, "packages", "dep", "dist"), { recursive: true })
  writeFileSync(join(slotPath, "packages", "dep", "dist", "index.js"), "built\n")
  return { repo, slot: slotPath }
}

const RESET = { force: true, install: true, direnv: false, hooks: false, admitOnly: true } as const

describe("reset admits regenerable setup output across a drifted setup declaration (29302)", () => {
  test("regenerable-only ignored output no longer refuses, and the outputs are named", async () => {
    const { repo } = driftedSlot()

    process.chdir(repo)
    await expect(resetWorktree("wt0", RESET)).resolves.toBeUndefined()

    const named = info.mock.calls.map((call) => String(call[0])).join("\n")
    expect(named).toContain("regenerable: node_modules")
    expect(named).toContain("regenerable: packages/dep/node_modules")
    expect(named).toContain("regenerable: packages/dep/dist")
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
    expect(failure).not.toMatch(/node_modules|packages\/dep\/dist/)
  })
})
