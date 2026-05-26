/**
 * Tests for the standalone-codex worktree-isolation guardrail.
 *
 * Pure-decision tests run against fixed `CwdProbe` inputs (no shell). One
 * integration test calls `probeCwd` against a real temp git repo + sibling
 * `<basename>-wtN` dir to verify the probe wiring.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, resolve } from "node:path"

import {
  evaluateCwdPolicy,
  findSiblingPoolSlots,
  isPoolSlotName,
  parseCwdPolicy,
  probeCwd,
  readCwdPolicyFromEnv,
  type CwdProbe,
} from "@bearly/tribe-client/lib/cwd-guardrail"

// ---------------------------------------------------------------------------
// Policy parsing
// ---------------------------------------------------------------------------

describe("parseCwdPolicy", () => {
  test("accepts known values", () => {
    expect(parseCwdPolicy("warn")).toBe("warn")
    expect(parseCwdPolicy("refuse")).toBe("refuse")
    expect(parseCwdPolicy("ignore")).toBe("ignore")
  })
  test("falls back to warn for unknown / unset", () => {
    expect(parseCwdPolicy(undefined)).toBe("warn")
    expect(parseCwdPolicy("")).toBe("warn")
    expect(parseCwdPolicy("nope")).toBe("warn")
  })
})

describe("readCwdPolicyFromEnv", () => {
  test("BEARLY_ALLOW_MAIN_REPO_CWD=1 → ignore", () => {
    expect(readCwdPolicyFromEnv({ BEARLY_ALLOW_MAIN_REPO_CWD: "1" })).toBe("ignore")
    expect(readCwdPolicyFromEnv({ BEARLY_ALLOW_MAIN_REPO_CWD: "true" })).toBe("ignore")
  })
  test("BEARLY_ALLOW_MAIN_REPO_CWD wins over policy var", () => {
    expect(
      readCwdPolicyFromEnv({
        BEARLY_ALLOW_MAIN_REPO_CWD: "1",
        TRIBE_MAIN_REPO_POLICY: "refuse",
      }),
    ).toBe("ignore")
  })
  test("TRIBE_MAIN_REPO_POLICY honored when escape hatch absent", () => {
    expect(readCwdPolicyFromEnv({ TRIBE_MAIN_REPO_POLICY: "refuse" })).toBe("refuse")
    expect(readCwdPolicyFromEnv({ TRIBE_MAIN_REPO_POLICY: "warn" })).toBe("warn")
    expect(readCwdPolicyFromEnv({ TRIBE_MAIN_REPO_POLICY: "ignore" })).toBe("ignore")
  })
  test("defaults to warn when both env vars unset", () => {
    expect(readCwdPolicyFromEnv({})).toBe("warn")
  })
})

describe("isPoolSlotName", () => {
  test("matches `<basename>-wtN`", () => {
    expect(isPoolSlotName("km-wt0")).toBe(true)
    expect(isPoolSlotName("km-wt9")).toBe(true)
    expect(isPoolSlotName("decker-wt3")).toBe(true)
  })
  test("rejects non-slot names", () => {
    expect(isPoolSlotName("km")).toBe(false)
    expect(isPoolSlotName("km-wt")).toBe(false)
    expect(isPoolSlotName("km-wtN")).toBe(false)
    expect(isPoolSlotName("km-feature-branch")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Pure policy evaluation
// ---------------------------------------------------------------------------

const MAIN_REPO_PROBE: CwdProbe = {
  cwd: "/Users/beorn/Code/pim/km",
  gitRoot: "/Users/beorn/Code/pim/km",
  headBranch: "main",
  siblingPoolSlots: ["km-wt0", "km-wt1"],
}

const WT_PROBE: CwdProbe = {
  cwd: "/Users/beorn/Code/pim/km-wt5",
  gitRoot: "/Users/beorn/Code/pim/km-wt5",
  headBranch: "wt5",
  siblingPoolSlots: ["km-wt0", "km-wt1", "km-wt5"],
}

const FEATURE_BRANCH_PROBE: CwdProbe = {
  cwd: "/Users/beorn/Code/pim/km",
  gitRoot: "/Users/beorn/Code/pim/km",
  headBranch: "experiment-foo",
  siblingPoolSlots: ["km-wt0"],
}

const NO_POOL_PROBE: CwdProbe = {
  cwd: "/Users/beorn/Code/pim/solo-repo",
  gitRoot: "/Users/beorn/Code/pim/solo-repo",
  headBranch: "main",
  siblingPoolSlots: [],
}

const NON_REPO_PROBE: CwdProbe = {
  cwd: "/tmp/scratch",
  gitRoot: null,
  headBranch: null,
  siblingPoolSlots: [],
}

describe("evaluateCwdPolicy", () => {
  test("main repo + main branch + pool → warn", () => {
    const result = evaluateCwdPolicy("warn", MAIN_REPO_PROBE)
    expect(result.kind).toBe("warn")
    if (result.kind === "warn") {
      expect(result.message).toContain("main repo")
      expect(result.message).toContain("bun worktree create wtN")
      expect(result.message).toContain("km-wt0, km-wt1")
      expect(result.message).toContain("BEARLY_ALLOW_MAIN_REPO_CWD")
    }
  })

  test("main repo + main branch + pool → refuse under refuse policy", () => {
    const result = evaluateCwdPolicy("refuse", MAIN_REPO_PROBE)
    expect(result.kind).toBe("refuse")
    if (result.kind === "refuse") {
      expect(result.message).toMatch(/^REFUSE: /)
      expect(result.message).toContain("main repo")
    }
  })

  test("pool slot cwd → ok", () => {
    const result = evaluateCwdPolicy("warn", WT_PROBE)
    expect(result.kind).toBe("ok")
  })

  test("main repo but on feature branch → ok", () => {
    const result = evaluateCwdPolicy("warn", FEATURE_BRANCH_PROBE)
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") expect(result.reason).toContain("experiment-foo")
  })

  test("no sibling pool exists → ok (solo repo)", () => {
    const result = evaluateCwdPolicy("warn", NO_POOL_PROBE)
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") expect(result.reason).toContain("no `<repo>-wt")
  })

  test("not in a git repo → ok", () => {
    const result = evaluateCwdPolicy("warn", NON_REPO_PROBE)
    expect(result.kind).toBe("ok")
  })

  test("ignore policy always returns ignored — even in main repo", () => {
    const result = evaluateCwdPolicy("ignore", MAIN_REPO_PROBE)
    expect(result.kind).toBe("ignored")
  })

  test("ignore policy on a worktree probe → ignored too", () => {
    const result = evaluateCwdPolicy("ignore", WT_PROBE)
    expect(result.kind).toBe("ignored")
  })

  test("warn handles master branch the same as main", () => {
    const masterProbe: CwdProbe = { ...MAIN_REPO_PROBE, headBranch: "master" }
    const result = evaluateCwdPolicy("warn", masterProbe)
    expect(result.kind).toBe("warn")
  })

  test("warn handles unknown branch gracefully (treats null as non-main)", () => {
    const detachedProbe: CwdProbe = { ...MAIN_REPO_PROBE, headBranch: null }
    const result = evaluateCwdPolicy("warn", detachedProbe)
    expect(result.kind).toBe("ok")
  })
})

// ---------------------------------------------------------------------------
// findSiblingPoolSlots — filesystem probe
// ---------------------------------------------------------------------------

describe("findSiblingPoolSlots", () => {
  let parent: string
  beforeEach(() => {
    parent = mkdtempSync(resolve(tmpdir(), "cwd-guardrail-test-"))
  })
  afterEach(() => {
    rmSync(parent, { recursive: true, force: true })
  })

  test("finds canonical wtN siblings", () => {
    const repoRoot = resolve(parent, "myrepo")
    mkdirSync(repoRoot)
    mkdirSync(resolve(parent, "myrepo-wt0"))
    mkdirSync(resolve(parent, "myrepo-wt3"))
    mkdirSync(resolve(parent, "myrepo-wt7"))
    // Decoy that shouldn't match (not in the wt<digit> pattern):
    mkdirSync(resolve(parent, "myrepo-feature"))

    const slots = findSiblingPoolSlots(repoRoot)
    expect(slots.sort()).toEqual(["myrepo-wt0", "myrepo-wt3", "myrepo-wt7"])
  })

  test("returns empty list when no pool dirs exist", () => {
    const repoRoot = resolve(parent, "lonely")
    mkdirSync(repoRoot)
    expect(findSiblingPoolSlots(repoRoot)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// probeCwd — full integration against a temp git repo
// ---------------------------------------------------------------------------

describe("probeCwd (integration)", () => {
  let parent: string
  beforeEach(() => {
    parent = mkdtempSync(resolve(tmpdir(), "cwd-guardrail-probe-"))
  })
  afterEach(() => {
    rmSync(parent, { recursive: true, force: true })
  })

  test("real git repo on main with a sibling wt → warn-shaped probe", () => {
    const repoRoot = resolve(parent, "demo")
    mkdirSync(repoRoot)
    // Init a minimal git repo with one commit on `main`.
    execSync("git init -q -b main", { cwd: repoRoot })
    execSync("git config user.email test@example.com", { cwd: repoRoot })
    execSync("git config user.name test", { cwd: repoRoot })
    writeFileSync(resolve(repoRoot, "README.md"), "x")
    execSync("git add . && git -c commit.gpgsign=false commit -qm init", { cwd: repoRoot })
    // Sibling pool slot dir (no need for real git worktree here — we only
    // probe filesystem presence).
    mkdirSync(resolve(parent, "demo-wt0"))

    // On macOS, /tmp → /var → /private/var, so git rev-parse --show-toplevel
    // returns the realpath-resolved form. Compare against realpath to dodge.
    const repoRootReal = realpathSync(repoRoot)
    const probe = probeCwd(repoRoot)
    expect(probe.gitRoot).toBe(repoRootReal)
    expect(probe.headBranch).toBe("main")
    expect(probe.siblingPoolSlots).toContain("demo-wt0")

    const verdict = evaluateCwdPolicy("warn", probe)
    expect(verdict.kind).toBe("warn")
    if (verdict.kind === "warn") {
      expect(verdict.message).toContain(`main repo (${basename(repoRoot)})`)
    }
  })

  test("non-repo cwd → null gitRoot, ok evaluation", () => {
    const scratch = resolve(parent, "scratch")
    mkdirSync(scratch)
    const probe = probeCwd(scratch)
    expect(probe.gitRoot).toBeNull()
    expect(probe.headBranch).toBeNull()
    expect(probe.siblingPoolSlots).toEqual([])
    expect(evaluateCwdPolicy("warn", probe).kind).toBe("ok")
  })
})
