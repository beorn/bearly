/**
 * Regression: a missing provider key must name the CAUSE, not the check.
 *
 * `OPENROUTER_API_KEY not set` is the check that fired. It reads as "your key
 * is wrong" and sends the reader to the credential, when the commonest cause is
 * that no env file ever reached the process. That is the default state of every
 * git worktree in a direnv-managed repo: `.env` is git-ignored and untracked,
 * so `git worktree add` does not carry it, and a worktree whose `.envrc` is not
 * yet `direnv allow`ed loads nothing at all. Both look identical from inside —
 * zero keys — and neither is a bad credential.
 *
 * Sibling of provider-error-surface.test.ts: there the error was swallowed,
 * here it is surfaced but blames the wrong thing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { envFileCandidates, missingApiKeyError } from "../src/lib/env-preflight"

function git(args: string[], cwd: string): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "protocol.file.allow=always", ...args],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  ).trim()
}

/** A throwaway repo with one commit. */
function scratchRepo(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `env-preflight-${label}-`))
  git(["init", "-q", "."], dir)
  writeFileSync(join(dir, "seed.txt"), "seed\n")
  git(["add", "."], dir)
  git(["commit", "-qm", "init"], dir)
  return dir
}

/** Clear every provider credential so "no env file loaded" is reachable. */
function clearProviderKeys(): Record<string, string> {
  const saved: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (name.endsWith("_API_KEY") && value !== undefined) {
      saved[name] = value
      delete process.env[name]
    }
  }
  return saved
}

let saved: Record<string, string> = {}

beforeEach(() => {
  saved = clearProviderKeys()
})

afterEach(() => {
  clearProviderKeys()
  for (const [name, value] of Object.entries(saved)) process.env[name] = value
})

describe("missingApiKeyError", () => {
  it("blames the key, not the env file, when other provider keys ARE set", () => {
    process.env.OPENAI_API_KEY = "sk-test-openai"

    const message = missingApiKeyError("OPENROUTER_API_KEY").message

    expect(message).toContain("OPENROUTER_API_KEY not set")
    expect(message).toContain("an env file did load")
    expect(message).toContain("misspelled")
    // Must NOT send the reader off to create a file that is already loaded.
    expect(message).not.toContain("direnv allow")
  })

  it("reports an unloaded env file — not a bad key — when one exists but no key is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-preflight-present-"))
    writeFileSync(join(dir, ".env"), "OPENROUTER_API_KEY=fake-not-a-secret\n")

    const message = missingApiKeyError("OPENROUTER_API_KEY", dir).message

    expect(message).toContain("OPENROUTER_API_KEY not set")
    expect(message).toContain("no *_API_KEY is set at all")
    expect(message).toContain(join(dir, ".env"))
    expect(message).toContain("did not reach this process")
    expect(message).toContain("direnv allow")
  })

  it("names the paths it looked at when no env file exists anywhere", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-preflight-absent-"))

    const message = missingApiKeyError("OPENROUTER_API_KEY", dir).message

    expect(message).toContain("OPENROUTER_API_KEY not set")
    expect(message).toContain("no env file exists at")
    expect(message).toContain(join(dir, ".env"))
    expect(message).toContain("worktrees inherit it through .envrc")
  })

  it("resolves the main checkout's .env from inside a linked worktree", () => {
    const main = scratchRepo("wt-main")
    writeFileSync(join(main, ".env"), "OPENROUTER_API_KEY=fake-not-a-secret\n")
    const worktree = join(main, "..", `wt-${Date.now()}`)
    git(["worktree", "add", "-q", "--detach", worktree], main)

    const message = missingApiKeyError("OPENROUTER_API_KEY", worktree).message

    // The whole point of the fix: a worktree has no .env of its own and must
    // still find main's. `--show-toplevel` would stop at the worktree.
    expect(message).toContain(join(main, ".env"))
    expect(message).toContain("did not reach this process")
  })

  it("climbs out of a submodule instead of naming a path inside .git/modules", () => {
    const sub = scratchRepo("sub")
    const superproject = scratchRepo("super")
    writeFileSync(join(superproject, ".env"), "OPENROUTER_API_KEY=fake-not-a-secret\n")
    mkdirSync(join(superproject, "deps"), { recursive: true })
    git(["submodule", "add", "-q", sub, "deps/sub"], superproject)
    git(["commit", "-qm", "add submodule"], superproject)

    const insideSubmodule = join(superproject, "deps", "sub")
    const candidates = envFileCandidates(insideSubmodule)

    // `--git-common-dir` inside a submodule points at <super>/.git/modules/…;
    // its parent is a path no checkout ever occupies.
    expect(candidates.some((path) => path.includes(`.git${sep}modules`))).toBe(false)
    expect(candidates).toContain(join(superproject, ".env"))
    expect(missingApiKeyError("OPENROUTER_API_KEY", insideSubmodule).message).toContain(join(superproject, ".env"))
  })

  it("keeps the greppable `<VAR> not set` prefix in every branch", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-preflight-prefix-"))

    expect(missingApiKeyError("XAI_API_KEY", dir).message.startsWith("XAI_API_KEY not set")).toBe(true)

    process.env.OPENAI_API_KEY = "sk-test-openai"
    expect(missingApiKeyError("XAI_API_KEY", dir).message.startsWith("XAI_API_KEY not set")).toBe(true)
  })
})
