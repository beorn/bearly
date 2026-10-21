/**
 * 30580 — a slot's own module repositories are destroyed with the slot. When a submodule was dropped from a
 * later commit, its store survived with local branches, unpushed commits and stashes while `worktree remove`
 * deleted it without ever looking. Removal now refuses a store no HEAD declaration names unless every commit
 * it holds is on a remote-tracking ref, and names every store it releases.
 *
 * @failure `bearly worktree remove` destroys a module repository holding unpushed commits, or destroys a
 *          reproducible one without saying so.
 * @level   l2
 * @consumer @i/26-environments/30580-worktree-remove-enumerate-slot
 * @testonly none
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest"
import { removeWorktree, resolveWorktreeTargetPath } from "./worktree.ts"

const roots: string[] = []
let info: MockInstance<(...args: unknown[]) => void>
let cwd: string

beforeEach(() => {
  cwd = process.cwd()
  info = vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  process.chdir(cwd)
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) safeRemoveSync(root, { within: tmpdir(), allowMissing: true })
})

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args as string[], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

/**
 * A pool slot whose declared submodule `vendor/dep` was dropped from its own HEAD afterwards — the shape that
 * leaves a store no gitlink names inside `<git-dir>/modules/vendor/dep`. `pushWork` puts the store's local
 * commit on its remote first, which is the reproducible case.
 */
function slotWithDroppedSubmodule(pushWork: boolean): { repo: string; slot: string } {
  const root = mkdtempSync(join(tmpdir(), "bearly-wt-module-store-"))
  roots.push(root)
  const repo = join(root, "repo")
  const dep = join(root, "dep")
  const origin = join(root, "origin.git")
  const pool = join(root, "pool")

  git(root, ["init", "-q", "-b", "main", dep])
  git(dep, ["config", "user.email", "t@example.test"])
  git(dep, ["config", "user.name", "t"])
  writeFileSync(join(dep, "dep.txt"), "dep\n")
  git(dep, ["add", "-A"])
  git(dep, ["commit", "-qm", "dep seed"])

  git(root, ["init", "-q", "-b", "main", repo])
  git(repo, ["config", "user.email", "t@example.test"])
  git(repo, ["config", "user.name", "t"])
  git(repo, ["config", "worktree.poolRoot", pool])
  git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", dep, "vendor/dep"])
  git(repo, ["commit", "-qm", "seed"])
  git(root, ["init", "-q", "--bare", origin])
  git(repo, ["remote", "add", "origin", origin])
  git(repo, ["push", "-q", "origin", "main"])
  git(repo, ["fetch", "-q", "origin", "main"])

  const slot = resolveWorktreeTargetPath(repo, "wt0", { poolRoot: pool })
  mkdirSync(slot, { recursive: true })
  git(repo, ["worktree", "add", "-q", "-B", "wt0", slot, "origin/main"])
  git(slot, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "vendor/dep"])

  const child = join(slot, "vendor/dep")
  writeFileSync(join(child, "local.txt"), "bytes that exist only here\n")
  git(child, ["add", "-A"])
  git(child, ["commit", "-qm", "local work"])
  if (pushWork) {
    git(child, ["push", "-q", "origin", "HEAD:refs/heads/local-work"])
    git(child, ["fetch", "-q", "origin"])
  }
  git(slot, ["submodule", "deinit", "-f", "--", "vendor/dep"])
  git(slot, ["rm", "-fq", "vendor/dep"])
  git(slot, ["commit", "-qm", "drop vendor/dep"])
  return { repo, slot }
}

describe("bearly worktree remove and a slot's module stores (30580)", () => {
  test("a store holding an unpushed commit refuses, and the slot survives", async () => {
    const { repo, slot } = slotWithDroppedSubmodule(false)
    process.chdir(repo)
    const failure = await removeWorktree("wt0", {}).then(
      () => null,
      (cause: unknown) => String(cause),
    )
    expect(failure).toContain("module store vendor/dep")
    expect(failure).toContain("holds 1 commit(s) no remote-tracking ref holds")
    expect(failure).toContain("bundle create")
    expect(execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" })).toContain(slot)
  })

  test("a store whose commits are all on its remote is removed and named", async () => {
    const { repo } = slotWithDroppedSubmodule(true)
    process.chdir(repo)
    await expect(removeWorktree("wt0", {})).resolves.toBeUndefined()
    const named = info.mock.calls.map((call) => String(call[0])).join("\n")
    expect(named).toContain("module store vendor/dep released: every commit is held by origin")
  })
})
