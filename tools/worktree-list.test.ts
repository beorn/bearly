/**
 * `bun worktree list` is the scan surface every seat reads; at 307 pool entries
 * it printed the whole estate and every reader piped it through grep (30535).
 * These rows pin the bounded text form, the name filter, and the JSON rows.
 *
 * @level   l1 — the pool mechanics against hermetic git repositories
 * @consumer @i/26-environments/30535-worktree-list-flood
 * @testonly none
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest"
import { listWorktrees, resolveWorktreeTargetPath } from "./worktree.ts"

const roots: string[] = []
let log: MockInstance<(...args: unknown[]) => void>

beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) safeRemoveSync(root, { within: tmpdir(), allowMissing: true })
})

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args as string[], { cwd, encoding: "utf8" })
}

function output(): string {
  return log.mock.calls.map((call) => call.map((part) => String(part)).join(" ")).join("\n")
}

/** A repo plus three pool slots, so a four-row listing is the whole estate. */
function repoWithSlots(): string {
  const root = mkdtempSync(join(tmpdir(), "bearly-wt-list-"))
  roots.push(root)
  const repo = join(root, "repo")
  const poolRoot = join(root, "pool")

  git(root, ["init", "-q", "-b", "main", repo])
  git(repo, ["config", "user.email", "t@example.test"])
  git(repo, ["config", "user.name", "t"])
  git(repo, ["config", "worktree.poolRoot", poolRoot])
  writeFileSync(join(repo, "seed.txt"), "seed\n")
  git(repo, ["add", "-A"])
  git(repo, ["commit", "-qm", "seed"])

  for (const name of ["wt0", "wt1", "wt2"]) {
    const slotPath = resolveWorktreeTargetPath(repo, name, { poolRoot })
    mkdirSync(slotPath, { recursive: true })
    git(repo, ["worktree", "add", "-q", "-B", name, slotPath, "HEAD"])
  }
  return repo
}

describe("worktree list is bounded, filterable and machine-readable (30535)", () => {
  test("text mode caps the rows it prints and still states the total", async () => {
    process.chdir(repoWithSlots())

    await listWorktrees({ limit: 2 })

    const printed = output()
    expect(printed).toContain("4 worktree(s)")
    expect(printed).toContain("showing 2 of 4; narrow with --name <substring> or read --json")
  })

  test("--name returns only the matching slots", async () => {
    process.chdir(repoWithSlots())

    await listWorktrees({ name: "wt1" })

    const printed = output()
    expect(printed).toContain("1 worktree(s)")
    expect(printed).toContain("repo-wt1")
    expect(printed).not.toContain("repo-wt0")
    expect(printed).not.toContain("repo-wt2")
  })

  test("--json prints one machine-readable row per slot", async () => {
    process.chdir(repoWithSlots())

    await listWorktrees({ json: true })

    const rows = JSON.parse(output()) as Array<{ name: string; path: string; branch: string; primary: boolean }>
    expect(rows).toHaveLength(4)
    expect(rows.map((row) => row.name)).toEqual(expect.arrayContaining(["repo", "repo-wt0", "repo-wt1", "repo-wt2"]))
    expect(rows.find((row) => row.name === "repo-wt1")?.branch).toBe("wt1")
  })
})
