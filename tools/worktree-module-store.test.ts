/**
 * 31094 — a dropped submodule can leave commits in its module store that are not covered by the compared
 * remote refs, archive refs, or available tags. No-retention removal must preserve that store and report the
 * value call; a store with no such commits can be released and named.
 *
 * @failure `bearly worktree remove` destroys a module repository with commits outside the compared refs, or
 *          releases a no-value store without naming the comparison.
 * @level   l2
 * @consumer @hh/tooling/31094-git-super-still-writes-archive
 * @testonly none
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest"
import { removeWorktree, resolveWorktreeTargetPath } from "./worktree.ts"

const fixtureParent = process.env.KM_VITEST_RUN_ROOT ?? tmpdir()
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
  for (const root of roots.splice(0)) {
    safeRemoveSync(root, { within: fixtureParent, allowMissing: true, allowedRoots: [fixtureParent] })
  }
})

// A cloned module store inherits no user config, and a CI runner has no global identity.
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args as string[], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_IDENTITY },
    stdio: ["ignore", "pipe", "pipe"],
  })
}

type StoreWork = "local" | "none" | "remoteless"

/**
 * A pool slot whose declared submodule `vendor/dep` was dropped from its own HEAD afterwards — the shape that
 * leaves a store no gitlink names inside `<git-dir>/modules/vendor/dep`. `local` commits work in the store,
 * `none` leaves it exactly on its remote main, and `remoteless` commits work and removes the store's remote.
 */
function slotWithDroppedSubmodule(work: StoreWork): { repo: string; dep: string; slot: string; moduleDir: string } {
  const root = mkdtempSync(join(fixtureParent, "bearly-wt-module-store-"))
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
  const moduleDir = git(join(slot, "vendor/dep"), ["rev-parse", "--absolute-git-dir"]).trim()

  if (work !== "none") {
    const child = join(slot, "vendor/dep")
    writeFileSync(join(child, "local.txt"), "bytes that exist only here\n")
    git(child, ["add", "-A"])
    git(child, ["commit", "-qm", "local work"])
  }
  if (work === "remoteless") git(repo, ["--git-dir", moduleDir, "config", "--remove-section", "remote.origin"])
  git(slot, ["submodule", "deinit", "-f", "--", "vendor/dep"])
  git(slot, ["rm", "-fq", "vendor/dep"])
  git(slot, ["commit", "-qm", "drop vendor/dep"])
  return { repo, dep, slot, moduleDir }
}

describe("bearly worktree remove and a slot's module stores (31094)", () => {
  test("a store holding local work reports the compared refs and preserves the store and registration", async () => {
    const { repo, dep, slot, moduleDir } = slotWithDroppedSubmodule("local")
    const tip = git(repo, ["--git-dir", moduleDir, "rev-parse", "HEAD"]).trim()
    process.chdir(repo)
    const failed = vi.spyOn(console, "error").mockImplementation(() => {})
    await removeWorktree("wt0", {}).then(
      () => undefined,
      () => undefined,
    )
    const named = info.mock.calls.map((call) => String(call[0])).join("\n")
    expect(named).toContain(`module store vendor/dep at ${moduleDir} holds 1 commit(s) outside compared refs (`)
    expect(named).toContain("origin default main")
    expect(named).not.toContain("refs/archive/")
    expect(named).toContain("; worktree preserved. Owner value call: land, keep one real branch, or recorded delete.")
    expect(failed.mock.calls.map((call) => String(call[0])).join("\n")).toContain("Failed to remove worktree")
    expect(git(repo, ["--git-dir", moduleDir, "rev-parse", "HEAD"]).trim()).toBe(tip)
    expect(git(dep, ["for-each-ref", "--format=%(refname)", "refs/archive/"]).trim()).toBe("")
    expect(execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" })).toContain(slot)
  })

  test("a store whose work is all on its remote main is released and named", async () => {
    const { repo, slot } = slotWithDroppedSubmodule("none")
    process.chdir(repo)
    await expect(removeWorktree("wt0", {})).resolves.toBeUndefined()
    const named = info.mock.calls.map((call) => String(call[0])).join("\n")
    expect(named).toContain(
      "module store vendor/dep released: origin default main, existing archive refs and available tags, 0 commits outside compared refs",
    )
    expect(execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" })).not.toContain(slot)
  })

  test("a store holding work with no remote stops removal and names the store", async () => {
    const { repo, slot, moduleDir } = slotWithDroppedSubmodule("remoteless")
    process.chdir(repo)
    // The caller keeps its existing error channel; the compared-ref explanation is the contract here.
    const failed = vi.spyOn(console, "error").mockImplementation(() => {})
    await removeWorktree("wt0", {}).then(
      () => undefined,
      () => undefined,
    )
    const logged = info.mock.calls.map((call) => String(call[0])).join("\n")
    expect(logged).toContain(
      `module store vendor/dep at ${moduleDir} holds 2 commit(s) outside compared refs (no remote refs (store has no remote))`,
    )
    expect(logged).toContain("; worktree preserved. Owner value call: land, keep one real branch, or recorded delete.")
    expect(failed.mock.calls.map((call) => String(call[0])).join("\n")).toContain("Failed to remove worktree")
    expect(git(repo, ["--git-dir", moduleDir, "rev-parse", "HEAD"]).trim()).toBeTruthy()
    expect(execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" })).toContain(slot)
  })
})
