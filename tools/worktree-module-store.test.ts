/**
 * 30580 — a slot's own module repositories are destroyed with the slot. A submodule dropped from a later
 * commit leaves its store behind with local branches, unpushed commits and stashes, and `worktree remove`
 * deleted it without ever looking. The operator's value test (2026-10-21) decides: work not on the store's
 * remote main and not under an archive ref is archived on that remote first, then removed; and removal names
 * every store it archives or releases. Nothing refuses on value alone.
 *
 * @failure `bearly worktree remove` destroys a module repository holding work nothing durable names, or
 *          destroys a reproducible one without saying so, or deletes on a failed archive.
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
const DATE = new Date().toISOString().slice(0, 10)

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

type StoreWork = "local" | "none" | "remoteless"

/**
 * A pool slot whose declared submodule `vendor/dep` was dropped from its own HEAD afterwards — the shape that
 * leaves a store no gitlink names inside `<git-dir>/modules/vendor/dep`. `local` commits work in the store,
 * `none` leaves it exactly on its remote main, and `remoteless` commits work and removes the store's remote.
 */
function slotWithDroppedSubmodule(work: StoreWork): { repo: string; dep: string; slot: string; moduleDir: string } {
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

describe("bearly worktree remove and a slot's module stores (30580)", () => {
  test("a store holding local work is archived on its remote, named, and only then removed", async () => {
    const { repo, dep, slot, moduleDir } = slotWithDroppedSubmodule("local")
    const tip = git(repo, ["--git-dir", moduleDir, "rev-parse", "HEAD"]).trim()
    process.chdir(repo)
    await expect(removeWorktree("wt0", {})).resolves.toBeUndefined()
    const named = info.mock.calls.map((call) => String(call[0])).join("\n")
    expect(named).toContain("module store vendor/dep archived: 1 commit(s) to refs/archive/")
    expect(git(dep, ["rev-parse", `refs/archive/${DATE}/wt0/vendor/dep/HEAD`]).trim()).toBe(tip)
    expect(execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" })).not.toContain(slot)
  })

  test("a store whose work is all on its remote main is released and named", async () => {
    const { repo } = slotWithDroppedSubmodule("none")
    process.chdir(repo)
    await expect(removeWorktree("wt0", {})).resolves.toBeUndefined()
    const named = info.mock.calls.map((call) => String(call[0])).join("\n")
    expect(named).toContain("module store vendor/dep released: origin main and archive refs hold it, 0 commits unique")
  })

  test("a store holding work with no remote stops removal and names the store", async () => {
    const { repo, slot } = slotWithDroppedSubmodule("remoteless")
    process.chdir(repo)
    // The CLI reports the refusal and exits; the line it prints is the contract here.
    const failed = vi.spyOn(console, "error").mockImplementation(() => {})
    await removeWorktree("wt0", {}).then(
      () => undefined,
      () => undefined,
    )
    const logged = info.mock.calls.map((call) => String(call[0])).join("\n")
    // With no remote nothing proves the base commit exists elsewhere either, so both commits count.
    expect(logged).toContain("module store vendor/dep holds 2 commit(s)")
    expect(logged).toContain("has no remote to archive them to")
    expect(failed.mock.calls.map((call) => String(call[0])).join("\n")).toContain("Failed to remove worktree")
    expect(execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" })).toContain(slot)
  })
})
