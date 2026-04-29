/**
 * Origin race preflight for `worktree merge`.
 *
 * Bead: km-bearly.worktree-merge-origin-race-preflight
 *
 * Scenario: two sessions independently integrate the same branch. Session A
 * cherry-picks onto main and pushes; Session B then runs `bun worktree merge`,
 * which would --no-ff merge onto stale local main and produce content-equivalent
 * but SHA-different history. The preflight must catch this and abort cleanly.
 *
 * Test design (no real network — origin is a local bare repo):
 *   1. Build bare-repo origin + two clones (alice, bob).
 *   2. Make alice the working clone, bob a "ghost integrator".
 *   3. From alice, create a feature branch with one commit; create a worktree
 *      pointing at that branch (so mergeWorktree() finds something to merge).
 *   4. From bob, push an unrelated commit to origin/main.
 *   5. From alice, call mergeWorktree(). Expect:
 *      - process.exit(1) is invoked,
 *      - error mentions "origin/main moved",
 *      - alice's main HEAD is unchanged (no merge happened).
 *   6. As a sanity-check, run again with `noFetch: true`; expect the merge
 *      to proceed past the preflight (it may fail later for other reasons,
 *      but the race-abort message must NOT appear).
 *
 * Marked .slow because it shells out to git and does real filesystem work;
 * included in test:vendor / test:all but excluded from test:fast.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest"
import { $ } from "bun"
import { existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { tmpdir } from "os"

import { mergeWorktree, createWorktree } from "../tools/worktree.ts"

let sandbox: string
let consoleLogSpy: ReturnType<typeof vi.spyOn>
let consoleErrorSpy: ReturnType<typeof vi.spyOn>
let exitSpy: ReturnType<typeof vi.spyOn>

async function initBare(path: string): Promise<void> {
  mkdirSync(path, { recursive: true })
  await $`git init -q --bare -b main ${path}`.quiet()
}

async function initClone(originPath: string, clonePath: string): Promise<void> {
  await $`git clone -q ${originPath} ${clonePath}`.quiet()
  await $`cd ${clonePath} && git config user.email t@t && git config user.name t`.quiet()
}

async function commit(repoPath: string, file: string, content: string, message: string): Promise<string> {
  writeFileSync(join(repoPath, file), content)
  await $`cd ${repoPath} && git add -A && git commit -qm ${message}`.quiet()
  const sha = await $`cd ${repoPath} && git rev-parse HEAD`.quiet()
  return sha.stdout.toString().trim()
}

class ProcessExitError extends Error {
  constructor(public exitCode: number) {
    super(`process.exit(${exitCode})`)
  }
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "wt-merge-race-"))
  // Silence the tool's user-facing output, but capture for assertions.
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new ProcessExitError(typeof code === "number" ? code : 1)
  })
})

afterEach(() => {
  consoleLogSpy.mockRestore()
  consoleErrorSpy.mockRestore()
  exitSpy.mockRestore()
  if (sandbox && existsSync(sandbox)) {
    rmSync(sandbox, { recursive: true, force: true })
  }
})

function captured(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls
    .map((call: unknown[]) => call.map((a: unknown) => (typeof a === "string" ? a : String(a))).join(" "))
    .join("\n")
}

describe("worktree merge — origin race preflight (km-bearly.worktree-merge-origin-race-preflight)", () => {
  test("aborts when origin/main has commits the local main lacks", async () => {
    const origin = join(sandbox, "origin.git")
    const alice = join(sandbox, "alice")
    const bob = join(sandbox, "bob")

    // 1. Bare origin
    await initBare(origin)

    // 2. Alice makes the seed commit & pushes; Bob clones from there.
    await initClone(origin, alice)
    await commit(alice, "README.md", "seed\n", "init")
    await $`cd ${alice} && git push -q origin main`.quiet()
    await initClone(origin, bob)

    // 3. Alice creates a feature branch + worktree (this is what mergeWorktree merges).
    const featureBranch = "bug/race-test"
    await $`cd ${alice} && git checkout -q -b ${featureBranch}`.quiet()
    await commit(alice, "feature.txt", "from alice\n", "feat: alice")
    // Switch alice back to main so mergeWorktree's "must be on main" check passes.
    await $`cd ${alice} && git checkout -q main`.quiet()

    // createWorktree expects to run from inside alice; chdir for the call.
    const aliceLocalMainBefore = (await $`cd ${alice} && git rev-parse main`.quiet()).stdout
      .toString()
      .trim()

    const origCwd = process.cwd()
    try {
      process.chdir(alice)
      await createWorktree("racewt", featureBranch, {
        install: false,
        direnv: false,
        hooks: false,
      })
    } finally {
      process.chdir(origCwd)
    }

    const worktreePath = join(dirname(alice), `${"alice"}-racewt`)
    expect(existsSync(worktreePath)).toBe(true)

    // 4. Bob lands a commit on origin/main first (the race winner).
    await commit(bob, "bob.txt", "from bob\n", "feat: bob")
    await $`cd ${bob} && git push -q origin main`.quiet()

    // 5. Alice calls mergeWorktree — must abort with the race error.
    let caught: ProcessExitError | undefined
    try {
      process.chdir(alice)
      await mergeWorktree("racewt", { fullTests: false })
    } catch (e) {
      if (e instanceof ProcessExitError) caught = e
      else throw e
    } finally {
      process.chdir(origCwd)
    }

    expect(caught, "mergeWorktree should call process.exit(1) on race").toBeDefined()
    expect(caught?.exitCode).toBe(1)

    const errLog = captured(consoleErrorSpy)
    const allLog = captured(consoleLogSpy) + "\n" + errLog
    expect(errLog).toMatch(/origin\/main moved/i)
    expect(allLog).toMatch(/git pull --ff-only origin main/)
    expect(allLog).toMatch(/--no-fetch/)

    // Local main must be unchanged — no destructive merge happened.
    const aliceLocalMainAfter = (await $`cd ${alice} && git rev-parse main`.quiet()).stdout
      .toString()
      .trim()
    expect(aliceLocalMainAfter).toBe(aliceLocalMainBefore)
  }, 60_000)

  test("--no-fetch bypass — race preflight does NOT abort with race error", async () => {
    const origin = join(sandbox, "origin.git")
    const alice = join(sandbox, "alice")
    const bob = join(sandbox, "bob")

    await initBare(origin)
    await initClone(origin, alice)
    await commit(alice, "README.md", "seed\n", "init")
    await $`cd ${alice} && git push -q origin main`.quiet()
    await initClone(origin, bob)

    const featureBranch = "bug/race-test-bypass"
    await $`cd ${alice} && git checkout -q -b ${featureBranch}`.quiet()
    await commit(alice, "feature.txt", "from alice\n", "feat: alice")
    await $`cd ${alice} && git checkout -q main`.quiet()

    const origCwd = process.cwd()
    try {
      process.chdir(alice)
      await createWorktree("racewt", featureBranch, {
        install: false,
        direnv: false,
        hooks: false,
      })
    } finally {
      process.chdir(origCwd)
    }

    // Bob races ahead.
    await commit(bob, "bob.txt", "from bob\n", "feat: bob")
    await $`cd ${bob} && git push -q origin main`.quiet()

    // With --no-fetch, the preflight must not fire. The merge may still bail
    // for other reasons (e.g. test runner missing in tmp sandbox), but the
    // race-specific error message must be absent.
    let caught: ProcessExitError | undefined
    try {
      process.chdir(alice)
      await mergeWorktree("racewt", { fullTests: false, noFetch: true })
    } catch (e) {
      if (e instanceof ProcessExitError) caught = e
      // Also tolerate non-exit errors (the merge proceeds further than the race
      // gate and may hit other failures unrelated to this preflight).
    } finally {
      process.chdir(origCwd)
    }

    const allLog = captured(consoleLogSpy) + "\n" + captured(consoleErrorSpy)
    expect(allLog).not.toMatch(/origin\/main moved/i)

    // Either the merge succeeded (caught undefined) OR a later step exited;
    // the only guarantee we make here is that the race preflight didn't fire.
    void caught
  }, 60_000)
})
