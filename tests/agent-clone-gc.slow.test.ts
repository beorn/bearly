/**
 * Tests for the agent-clone GC primitives.
 *
 * Covers `classifyAgentClone`, `countCascades`, `listAgentClones`, and the
 * process-level `worktree gc` contract. Each test uses a synthetic repository
 * in a tmp dir and asserts classification or deletion safety.
 *
 * Marked .slow because we shell out to git per-test.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest"
import { $ } from "bun"
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

import { classifyAgentClone, countCascades, gcAgentClones, listAgentClones } from "../tools/worktree.ts"

let sandbox: string
let consoleLogSpy: ReturnType<typeof vi.spyOn>

async function initRepo(path: string, opts: { withCommit?: boolean } = {}): Promise<void> {
  mkdirSync(path, { recursive: true })
  await $`cd ${path} && git init -q -b main && git config user.email t@t && git config user.name t`.quiet()
  if (opts.withCommit !== false) {
    writeFileSync(join(path, "x.txt"), "x\n")
    await $`cd ${path} && git add -A && git commit -qm init`.quiet()
    await $`git -C ${path} update-ref refs/remotes/origin/main HEAD`.quiet()
  }
}

async function runGc(repo: string, root: string, args: string[] = [], activeCwds: string[] = [repo]): Promise<void> {
  const originalCwd = process.cwd()
  try {
    process.chdir(repo)
    await gcAgentClones(
      { root, includeUniqueWork: args.includes("--include-unique-work") },
      {
        censusProcessCwds: async () => ({
          available: true,
          rows: activeCwds.map((cwd, index) => ({ pid: index + 1, cwd })),
          reason: "deterministic test census",
        }),
      },
    )
  } finally {
    process.chdir(originalCwd)
  }
}

async function initOwnerWithRemote(): Promise<{ owner: string; remote: string }> {
  const remote = join(sandbox, "remote.git")
  const owner = join(sandbox, "owner")
  await $`git init -q --bare -b main ${remote}`.quiet()
  await initRepo(owner)
  await $`git -C ${owner} remote add origin ${remote}`.quiet()
  await $`git -C ${owner} push -qu origin main`.quiet()
  return { owner, remote }
}

async function addSubmodule(owner: string): Promise<void> {
  const subRemote = join(sandbox, "sub.git")
  const subSeed = join(sandbox, "sub-seed")
  await $`git init -q --bare -b main ${subRemote}`.quiet()
  await initRepo(subSeed)
  await $`git -C ${subSeed} remote add origin ${subRemote}`.quiet()
  await $`git -C ${subSeed} push -qu origin main`.quiet()
  await $`git -C ${owner} -c protocol.file.allow=always submodule add -q ${subRemote} vendor/sub`.quiet()
  await $`git -C ${owner} commit -qm add-submodule`.quiet()
  await $`git -C ${owner} push -q origin main`.quiet()
}

async function registeredWorktrees(repo: string): Promise<string[]> {
  const porcelain = await $`git -C ${repo} worktree list --porcelain`.text()
  return porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
}

async function expectProcessCwd(pid: number, expectedCwd: string): Promise<void> {
  const expected = realpathSync(expectedCwd)
  if (process.platform === "darwin") {
    const output = await $`/usr/sbin/lsof -a -p ${pid} -d cwd -Fn`.text()
    expect(output.split("\n")).toContain(`n${expected}`)
    return
  }
  if (process.platform === "linux") {
    expect(realpathSync(`/proc/${pid}/cwd`)).toBe(expected)
    return
  }
  throw new Error(`real CWD-holder regression is unsupported on ${process.platform}`)
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "agent-gc-"))
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  consoleLogSpy.mockRestore()
  if (sandbox && existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true })
})

describe("classifyAgentClone", () => {
  test("returns 'broken' for a path without .git", async () => {
    const clone = join(sandbox, "agent-broken")
    mkdirSync(clone, { recursive: true })
    writeFileSync(join(clone, "x.txt"), "junk")
    expect(await classifyAgentClone(clone)).toBe("broken")
  })

  test("returns 'dirty' for a clone with uncommitted changes", async () => {
    const clone = join(sandbox, "agent-dirty")
    await initRepo(clone)
    writeFileSync(join(clone, "x.txt"), "modified\n")
    expect(await classifyAgentClone(clone)).toBe("dirty")
  })

  test("returns 'clean' when HEAD is reachable from main and no uncommitted", async () => {
    const clone = join(sandbox, "agent-clean")
    await initRepo(clone)
    expect(await classifyAgentClone(clone)).toBe("clean")
  })

  test("returns 'unique-work' when HEAD is ahead of main (committed but unmerged)", async () => {
    const clone = join(sandbox, "agent-unique")
    await initRepo(clone)
    // Make a commit on a branch that's not in main
    await $`cd ${clone} && git checkout -qb feat/agent-work`.quiet()
    writeFileSync(join(clone, "x.txt"), "agent-work\n")
    await $`cd ${clone} && git add -A && git commit -qm "agent commit"`.quiet()
    // HEAD is now on feat/agent-work, which has a commit not in main
    expect(await classifyAgentClone(clone)).toBe("unique-work")
  })
})

describe("countCascades", () => {
  test("returns 0 when no .claude/worktrees/ exists", async () => {
    const clone = join(sandbox, "agent-no-cascade")
    await initRepo(clone)
    expect(await countCascades(clone)).toBe(0)
  })

  test("counts agent-* directories inside .claude/worktrees/", async () => {
    const clone = join(sandbox, "agent-with-cascades")
    await initRepo(clone)
    mkdirSync(join(clone, ".claude/worktrees/agent-inner-1"), { recursive: true })
    mkdirSync(join(clone, ".claude/worktrees/agent-inner-2"), { recursive: true })
    mkdirSync(join(clone, ".claude/worktrees/not-an-agent"), { recursive: true })
    expect(await countCascades(clone)).toBe(2)
  })
})

describe("listAgentClones", () => {
  test("returns empty array when root doesn't exist", async () => {
    expect(await listAgentClones(join(sandbox, "missing"))).toEqual([])
  })

  test("classifies each agent-* clone under root", async () => {
    const root = join(sandbox, ".claude/worktrees")
    mkdirSync(root, { recursive: true })

    // broken
    mkdirSync(join(root, "agent-a"), { recursive: true })
    writeFileSync(join(root, "agent-a/x.txt"), "junk")

    // clean
    await initRepo(join(root, "agent-b"))

    // skipped (doesn't match agent-* prefix)
    mkdirSync(join(root, "scratch"), { recursive: true })

    const clones = await listAgentClones(root)
    expect(clones.map((c) => c.name).sort()).toEqual(["agent-a", "agent-b"])
    const byName = Object.fromEntries(clones.map((c) => [c.name, c]))
    expect(byName["agent-a"]?.class).toBe("broken")
    expect(byName["agent-b"]?.class).toBe("clean")
    expect(byName["agent-b"]?.cascadeCount).toBe(0)
  })

  test("populates cascadeCount when nested clones exist", async () => {
    const root = join(sandbox, ".claude/worktrees")
    mkdirSync(root, { recursive: true })
    const outer = join(root, "agent-outer")
    await initRepo(outer)
    mkdirSync(join(outer, ".claude/worktrees/agent-inner"), { recursive: true })

    const clones = await listAgentClones(root)
    expect(clones).toHaveLength(1)
    expect(clones[0]?.cascadeCount).toBe(1)
  })
})

describe("worktree gc deletion safety", () => {
  test("preserves an unregistered standalone clone even when its HEAD matches origin/main", async () => {
    const { owner, remote } = await initOwnerWithRemote()
    const root = join(sandbox, "worktrees")
    const clone = join(root, "agent-standalone")
    mkdirSync(root, { recursive: true })
    await $`git clone -q ${remote} ${clone}`.quiet()

    await runGc(owner, root)

    expect(existsSync(clone)).toBe(true)
    expect(await registeredWorktrees(owner)).not.toContain(clone)
  })

  test("preserves broken or unknown paths instead of deleting them outside Git", async () => {
    const { owner } = await initOwnerWithRemote()
    const root = join(sandbox, "worktrees")
    const broken = join(root, "agent-broken")
    const unknown = join(root, "agent-unknown")
    mkdirSync(broken, { recursive: true })
    mkdirSync(join(unknown, ".git"), { recursive: true })
    writeFileSync(join(broken, "only-copy.txt"), "must survive\n")
    writeFileSync(join(unknown, "only-copy.txt"), "must also survive\n")

    await runGc(owner, root)

    expect(existsSync(join(broken, "only-copy.txt"))).toBe(true)
    expect(existsSync(join(unknown, "only-copy.txt"))).toBe(true)
  })

  test("removes only a registered clean linked worktree and clears its Git registration", async () => {
    const { owner } = await initOwnerWithRemote()
    const root = join(sandbox, "worktrees")
    const clone = join(root, "agent-linked-clean")
    mkdirSync(root, { recursive: true })
    await $`git -C ${owner} worktree add -q --detach ${clone} refs/remotes/origin/main`.quiet()
    expect(await registeredWorktrees(owner)).toContain(clone)

    await runGc(owner, root)

    expect(existsSync(clone)).toBe(false)
    expect(await registeredWorktrees(owner)).not.toContain(clone)
  })

  test("uses git worktree remove --force for a clean linked worktree with an initialized submodule", async () => {
    const { owner } = await initOwnerWithRemote()
    await addSubmodule(owner)

    const root = join(sandbox, "worktrees")
    const clone = join(root, "agent-linked-submodule")
    mkdirSync(root, { recursive: true })
    await $`git -C ${owner} worktree add -q --detach ${clone} refs/remotes/origin/main`.quiet()
    await $`git -C ${clone} -c protocol.file.allow=always submodule update -q --init --recursive`.quiet()
    expect(existsSync(join(clone, "vendor/sub/.git"))).toBe(true)

    await runGc(owner, root)

    expect(existsSync(clone)).toBe(false)
    expect(await registeredWorktrees(owner)).not.toContain(clone)
  })

  test("preserves submodule dirt even when .gitmodules configures ignore=all", async () => {
    const { owner } = await initOwnerWithRemote()
    await addSubmodule(owner)
    await $`git -C ${owner} config -f .gitmodules submodule.vendor/sub.ignore all`.quiet()
    await $`git -C ${owner} add .gitmodules`.quiet()
    await $`git -C ${owner} commit -qm ignore-submodule-dirt`.quiet()
    await $`git -C ${owner} push -q origin main`.quiet()

    const root = join(sandbox, "worktrees")
    const clone = join(root, "agent-linked-dirty-submodule")
    mkdirSync(root, { recursive: true })
    await $`git -C ${owner} worktree add -q --detach ${clone} refs/remotes/origin/main`.quiet()
    await $`git -C ${clone} -c protocol.file.allow=always submodule update -q --init --recursive`.quiet()
    writeFileSync(join(clone, "vendor/sub/x.txt"), "dirty inside submodule\n")
    expect((await $`git -C ${clone} status --porcelain`.text()).trim()).toBe("")
    expect(
      (await $`git -C ${clone} status --porcelain --untracked-files=all --ignore-submodules=none`.text()).trim(),
    ).not.toBe("")

    await runGc(owner, root)

    expect(existsSync(join(clone, "vendor/sub/x.txt"))).toBe(true)
    expect(await registeredWorktrees(owner)).toContain(clone)
  })

  test("preserves a clean registered worktree while another process holds its CWD inside", async () => {
    const { owner } = await initOwnerWithRemote()
    const root = join(sandbox, "worktrees")
    const clone = join(root, "agent-linked-live-cwd")
    mkdirSync(root, { recursive: true })
    await $`git -C ${owner} worktree add -q --detach ${clone} refs/remotes/origin/main`.quiet()
    const holder = Bun.spawn({ cmd: ["/bin/sleep", "30"], cwd: clone, stdout: "ignore", stderr: "ignore" })

    try {
      await expectProcessCwd(holder.pid, clone)
      await runGc(owner, root, [], [clone])

      expect(existsSync(clone)).toBe(true)
      expect(await registeredWorktrees(owner)).toContain(clone)
    } finally {
      holder.kill()
      await holder.exited
    }
  })

  test("preserves every candidate when the process-CWD census is unavailable", async () => {
    const { owner } = await initOwnerWithRemote()
    const root = join(sandbox, "worktrees")
    const clone = join(root, "agent-linked-census-unavailable")
    mkdirSync(root, { recursive: true })
    await $`git -C ${owner} worktree add -q --detach ${clone} refs/remotes/origin/main`.quiet()
    const originalCwd = process.cwd()

    try {
      process.chdir(owner)
      await gcAgentClones(
        { root },
        {
          censusProcessCwds: async () => ({ available: false, reason: "test probe unavailable" }),
        },
      )
    } finally {
      process.chdir(originalCwd)
    }

    expect(existsSync(clone)).toBe(true)
    expect(await registeredWorktrees(owner)).toContain(clone)
  })

  test("uses refs/remotes/origin/main when landed history is reachable only through a merge", async () => {
    const { owner, remote } = await initOwnerWithRemote()
    const integrator = join(sandbox, "integrator")
    await $`git clone -q ${remote} ${integrator}`.quiet()
    await $`git -C ${integrator} config user.email t@t`.quiet()
    await $`git -C ${integrator} config user.name t`.quiet()
    await $`git -C ${integrator} checkout -qb feature`.quiet()
    writeFileSync(join(integrator, "feature.txt"), "landed through merge\n")
    await $`git -C ${integrator} add feature.txt`.quiet()
    await $`git -C ${integrator} commit -qm feature`.quiet()
    const featureHead = (await $`git -C ${integrator} rev-parse HEAD`.text()).trim()
    await $`git -C ${integrator} checkout -q main`.quiet()
    await $`git -C ${integrator} merge -q --no-ff feature -m merge-feature`.quiet()
    await $`git -C ${integrator} push -q origin main`.quiet()
    await $`git -C ${owner} fetch -q origin main`.quiet()

    const root = join(sandbox, "worktrees")
    const clone = join(root, "agent-merge-landed")
    mkdirSync(root, { recursive: true })
    await $`git -C ${owner} worktree add -q --detach ${clone} ${featureHead}`.quiet()
    expect((await $`git -C ${owner} rev-parse main`.text()).trim()).not.toBe(
      (await $`git -C ${owner} rev-parse refs/remotes/origin/main`.text()).trim(),
    )

    await runGc(owner, root)

    expect(existsSync(clone)).toBe(false)
    expect(await registeredWorktrees(owner)).not.toContain(clone)
  })

  test("preserves registered dirty and unique work even with --include-unique-work", async () => {
    const { owner } = await initOwnerWithRemote()
    const root = join(sandbox, "worktrees")
    const dirty = join(root, "agent-dirty-linked")
    const unique = join(root, "agent-unique-linked")
    mkdirSync(root, { recursive: true })
    await $`git -C ${owner} worktree add -q --detach ${dirty} refs/remotes/origin/main`.quiet()
    await $`git -C ${owner} worktree add -q --detach ${unique} refs/remotes/origin/main`.quiet()
    writeFileSync(join(dirty, "x.txt"), "dirty\n")
    writeFileSync(join(unique, "unique.txt"), "unique\n")
    await $`git -C ${unique} add unique.txt`.quiet()
    await $`git -C ${unique} -c user.email=t@t -c user.name=t commit -qm unique`.quiet()

    await runGc(owner, root, ["--include-unique-work"])

    expect(existsSync(dirty)).toBe(true)
    expect(existsSync(join(dirty, "x.txt"))).toBe(true)
    expect(existsSync(unique)).toBe(true)
    expect(existsSync(join(unique, "unique.txt"))).toBe(true)
    expect(await registeredWorktrees(owner)).toEqual(expect.arrayContaining([dirty, unique]))
  })

  test("preserves a clean merge whose second-parent history is not on origin/main", async () => {
    const { owner } = await initOwnerWithRemote()
    const root = join(sandbox, "worktrees")
    const clone = join(root, "agent-merge-only-unique")
    mkdirSync(root, { recursive: true })
    await $`git -C ${owner} worktree add -q -b unique-side ${clone} refs/remotes/origin/main`.quiet()
    writeFileSync(join(clone, "side.txt"), "unique side history\n")
    await $`git -C ${clone} add side.txt`.quiet()
    await $`git -C ${clone} -c user.email=t@t -c user.name=t commit -qm side`.quiet()
    const sideHead = (await $`git -C ${clone} rev-parse HEAD`.text()).trim()
    const baseTree = (await $`git -C ${owner} rev-parse refs/remotes/origin/main^{tree}`.text()).trim()
    const baseHead = (await $`git -C ${owner} rev-parse refs/remotes/origin/main`.text()).trim()
    const mergeHead = (
      await $`git -C ${owner} -c user.email=t@t -c user.name=t commit-tree ${baseTree} -p ${baseHead} -p ${sideHead} -m merge-only-unique`.text()
    ).trim()
    await $`git -C ${clone} checkout -q --detach ${mergeHead}`.quiet()

    await runGc(owner, root)

    expect(existsSync(clone)).toBe(true)
    expect(await registeredWorktrees(owner)).toContain(clone)
  })

  test("preserves a clean registered worktree if it carries an active .agent-lease.json", async () => {
    const { owner } = await initOwnerWithRemote()
    const root = join(sandbox, "worktrees")
    const clone = join(root, "agent-leased-linked")
    mkdirSync(root, { recursive: true })
    await $`git -C ${owner} worktree add -q --detach ${clone} refs/remotes/origin/main`.quiet()
    const lease = { pid: process.pid, sessionId: "@dev/1", startedAt: new Date().toISOString() }
    writeFileSync(join(clone, ".agent-lease.json"), JSON.stringify(lease))

    await runGc(owner, root)

    expect(existsSync(clone)).toBe(true)
    expect(await registeredWorktrees(owner)).toContain(clone)
  })
})
