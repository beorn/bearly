/**
 * Shared worktree-config poison guard — @hh/tooling/21159.
 *
 * Once extensions.worktreeConfig is enabled, a shared core.bare=true makes
 * every linked worktree report as bare. Provisioning repairs that state, but
 * `bun worktree audit` is the fast read-only gate that must catch a later
 * reintroduction before another provision happens.
 */

import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

const WORKTREE_CLI = join(import.meta.dirname, "worktree.ts")
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("worktree audit shared-config safety", () => {
  test("fails when worktreeConfig and core.bare=true coexist in shared config", () => {
    const { repo } = repository()
    git(repo, ["config", "extensions.worktreeConfig", "true"])
    git(repo, ["config", "core.bare", "true"])

    const audit = runAudit(repo)

    expect(audit.status).toBe(1)
    const report = JSON.parse(audit.stdout) as {
      findings: Array<{ severity: string; check: string }>
    }
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        severity: "error",
        check: "shared-worktree-config-poisoned",
      }),
    )
  })

  test("passes the paired state with worktreeConfig enabled and no shared core.bare", () => {
    const { repo } = repository()
    git(repo, ["config", "extensions.worktreeConfig", "true"])
    git(repo, ["config", "--worktree", "core.bare", "false"])

    const audit = runAudit(repo)
    const report = JSON.parse(audit.stdout) as {
      findings: Array<{ severity: string; check: string }>
    }

    expect(audit.status).toBe(0)
    expect(report.findings.map((finding) => finding.check)).not.toContain("shared-worktree-config-poisoned")
  })
})

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
  }
}

function repository(): { repo: string } {
  const root = mkdtempSync(join(tmpdir(), "worktree-shared-config-"))
  roots.push(root)
  const repo = join(root, "repo")

  git(root, ["init", "-q", repo])
  git(repo, ["config", "user.name", "Worktree Guard Test"])
  git(repo, ["config", "user.email", "worktree-guard@example.test"])
  writeFileSync(join(repo, "README.md"), "fixture\n")
  git(repo, ["add", "README.md"])
  git(repo, ["commit", "-qm", "fixture"])
  git(repo, ["worktree", "add", "-q", "-b", "pool", join(root, "pool")])
  return { repo }
}

function runAudit(repo: string) {
  return spawnSync(process.execPath, [WORKTREE_CLI, "audit", "--json"], {
    cwd: repo,
    encoding: "utf8",
  })
}
