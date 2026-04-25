/**
 * Tests for the agent-clone GC primitives.
 *
 * Covers `classifyAgentClone`, `countCascades`, `listAgentClones`. Each
 * test sets up a synthetic clone in a tmp dir and asserts the right
 * classification.
 *
 * Marked .slow because we shell out to git per-test.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest"
import { $ } from "bun"
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

import { classifyAgentClone, countCascades, listAgentClones } from "../tools/worktree.ts"

let sandbox: string
let consoleLogSpy: ReturnType<typeof vi.spyOn>

async function initRepo(path: string, opts: { withCommit?: boolean } = {}): Promise<void> {
  mkdirSync(path, { recursive: true })
  await $`cd ${path} && git init -q -b main && git config user.email t@t && git config user.name t`.quiet()
  if (opts.withCommit !== false) {
    writeFileSync(join(path, "x.txt"), "x\n")
    await $`cd ${path} && git add -A && git commit -qm init`.quiet()
  }
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
