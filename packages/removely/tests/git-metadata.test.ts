/**
 * @failure  `resolveGitMetadata` re-spawns git on every call, drifts from the
 *           individual `rev-parse` answers it replaces, or misclassifies a
 *           non-repository / probe failure so a caller refuses with the wrong
 *           text.
 * @level    l2 - runs git in temporary repositories
 * @consumer @i/14-substrate/25690-km-write-speed/27703-km-cli-start-floor
 * @reach    none <temporary fixtures; no host walk>
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "vitest"

import { findGitProjectRoot, resolveGitMetadata, runWithGitMetadataScope, safeRemove } from "../src/index.ts"

const roots: string[] = []

function scratch(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `removely-git-metadata-${label}-`))
  roots.push(root)
  return root
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
  return (result.stdout ?? "").trim()
}

function gitOrNull(cwd: string, ...args: string[]): string | null {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  return (result.status ?? 1) === 0 ? (result.stdout ?? "").trim() : null
}

function initRepo(dir: string, branch = "probe"): string {
  mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q", "-b", branch)
  git(dir, "config", "user.email", "test@example.com")
  git(dir, "config", "user.name", "Test")
  writeFileSync(join(dir, "README.md"), "fixture\n")
  git(dir, "add", "README.md")
  git(dir, "commit", "-qm", "fixture")
  return dir
}

/** The four individual rev-parse answers this record replaces, field for field. */
function oldAnswers(root: string) {
  return {
    toplevel: gitOrNull(root, "rev-parse", "--show-toplevel"),
    commonDir: gitOrNull(root, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    prefix: gitOrNull(root, "rev-parse", "--show-prefix"),
    findProjectRoot: findGitProjectRoot(root),
  }
}

function recordOf(root: string) {
  const probe = resolveGitMetadata(root)
  if (probe.kind !== "repo") throw new Error(`expected a repo record for ${root}, got ${probe.kind}`)
  return probe.record
}

function expectFieldParity(root: string): void {
  const old = oldAnswers(root)
  const record = recordOf(root)
  expect(record.toplevel).toBe(old.toplevel)
  expect(record.commonDir).toBe(old.commonDir)
  expect(record.prefix).toBe(old.prefix)
  expect(record.superprojectWorktree ?? record.toplevel).toBe(old.findProjectRoot)
}

afterAll(async () => {
  for (const root of roots.splice(0)) {
    await safeRemove(root, { within: await realpath(tmpdir()), allowMissing: true })
  }
})

describe("resolveGitMetadata — one rev-parse answering every repository question", () => {
  test("memoizes inside one invocation scope and nothing outside any scope", () => {
    const root = initRepo(join(scratch("memo"), "repo"))
    // No ambient scope: every question is a direct probe, so no long-lived process caches anything.
    expect(resolveGitMetadata(root)).not.toBe(resolveGitMetadata(root))
    const inside = runWithGitMetadataScope(() => {
      const first = resolveGitMetadata(root)
      return { first, again: resolveGitMetadata(root) }
    })
    expect(inside.first.kind).toBe("repo")
    expect(inside.again).toBe(inside.first)
    expect(runWithGitMetadataScope(() => resolveGitMetadata(root, { cache: false }))).not.toBe(inside.first)
    // Separate invocations do not share entries — the row @cto required for two commands in one worker.
    expect(runWithGitMetadataScope(() => resolveGitMetadata(root))).not.toBe(inside.first)
  })

  test("keys the memo by realpath root and by git environment inside one scope", () => {
    const fixture = scratch("keys")
    const first = initRepo(join(fixture, "first"))
    const second = initRepo(join(fixture, "second"))
    const seen = runWithGitMetadataScope(() => ({
      first: resolveGitMetadata(first),
      second: resolveGitMetadata(second),
      firstAgain: resolveGitMetadata(first),
      otherEnv: resolveGitMetadata(first, { env: { ...process.env, GIT_DIR: "/nonexistent" } }),
    }))
    expect(seen.firstAgain).toBe(seen.first)
    expect(seen.second).not.toBe(seen.first)
    expect(seen.otherEnv).not.toBe(seen.first)
  })

  test("classifies a non-repository as no-repo, carrying git's own status", () => {
    const outside = scratch("outside")
    const probe = resolveGitMetadata(outside)
    expect(probe.kind).toBe("no-repo")
    expect(probe.status).toBe(128)
    expect(probe.stderr).toMatch(/not a git repository/u)
  })

  test("field parity with the individual rev-parse calls, for every checkout shape", () => {
    const fixture = scratch("shapes")

    const plain = initRepo(join(fixture, "plain"))
    expectFieldParity(plain)

    const nested = join(plain, "packages", "app", "src")
    mkdirSync(nested, { recursive: true })
    expectFieldParity(nested)

    const link = join(fixture, "plain-link")
    symlinkSync(plain, link)
    expectFieldParity(link)

    const worktree = join(fixture, "linked-worktree")
    git(plain, "worktree", "add", "-q", worktree, "-b", "probe-worktree")
    expectFieldParity(worktree)

    const productSource = initRepo(join(fixture, "product-source"))
    const superproject = join(fixture, "superproject")
    mkdirSync(superproject)
    git(superproject, "init", "-q", "-b", "super")
    git(superproject, "-c", "protocol.file.allow=always", "submodule", "add", "-q", productSource, "product")
    expectFieldParity(join(superproject, "product"))

    const noRepo = scratch("no-repo")
    expect(resolveGitMetadata(noRepo).kind).toBe("no-repo")
    expect(findGitProjectRoot(noRepo)).toBeNull()
  })
})
