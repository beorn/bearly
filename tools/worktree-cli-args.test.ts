/**
 * planCliInvocation — pure CLI planner for the worktree tool's main().
 *
 * Regression for the flag-as-name bug: `bun worktree reset --help` used to
 * take `args[1]` verbatim as the worktree name, flow it through
 * resolveWorktreeTargetPath → createWorktree, and CREATE a sprawl worktree
 * `<repo>---help` on branch `feat/--help` (2026-07-06, km bead
 * 20888-contained-worktree-pool). The planner guarantees a `-`-prefixed
 * token can never become a worktree name, and `-h`/`--help` anywhere in the
 * argv is help, never work.
 */

import { describe, expect, test } from "vitest"
import { assertValidWorktreeName, planCliInvocation } from "./worktree.ts"

describe("planCliInvocation — help interception (the hh---help incident)", () => {
  test("`reset --help` is help, not a reset of a worktree named --help", () => {
    expect(planCliInvocation(["reset", "--help"])).toEqual({ action: "help" })
  })

  test("`-h`/`--help` anywhere wins over any subcommand", () => {
    expect(planCliInvocation(["--help"])).toEqual({ action: "help" })
    expect(planCliInvocation(["create", "wt3", "--help"])).toEqual({ action: "help" })
    expect(planCliInvocation(["remove", "-h"])).toEqual({ action: "help" })
    expect(planCliInvocation(["help"])).toEqual({ action: "help" })
  })
})

describe("planCliInvocation — name is the first positional, never a flag", () => {
  test("`reset --force wt3` resolves name wt3 (flag-first ordering)", () => {
    expect(planCliInvocation(["reset", "--force", "wt3"])).toEqual({
      action: "reset",
      name: "wt3",
      options: { force: true, saveAheadAs: undefined, retargetOrigin: false, install: true, direnv: true, hooks: true },
    })
  })

  test("`reset --save-ahead-as slug wt4` does not eat the flag value as the name", () => {
    expect(planCliInvocation(["reset", "--save-ahead-as", "slug", "wt4"])).toEqual({
      action: "reset",
      name: "wt4",
      options: { force: false, saveAheadAs: "slug", retargetOrigin: false, install: true, direnv: true, hooks: true },
    })
  })

  test("commands with only flags are usage errors, not flag-named worktrees", () => {
    expect(planCliInvocation(["remove", "--force"])).toMatchObject({ action: "usage-error" })
    expect(planCliInvocation(["reset"])).toMatchObject({ action: "usage-error" })
  })

  test("`remove -f wt5` accepts short flags without consuming them as names", () => {
    expect(planCliInvocation(["remove", "-f", "wt5"])).toEqual({
      action: "remove",
      name: "wt5",
      options: { deleteBranch: false, force: true },
    })
  })

  test("create keeps the `--branch <branch>` as-name contract", () => {
    expect(planCliInvocation(["create", "--branch", "km-theme-inherit"])).toEqual({
      action: "create",
      name: "km-theme-inherit",
      branch: "km-theme-inherit",
      options: { install: true, direnv: true, hooks: true, allowDirty: false, baseRef: "origin/main", fetch: true },
    })
    expect(planCliInvocation(["create", "wt3"])).toEqual({
      action: "create",
      name: "wt3",
      branch: undefined,
      options: { install: true, direnv: true, hooks: true, allowDirty: false, baseRef: "origin/main", fetch: true },
    })
    expect(planCliInvocation(["create", "bugfix", "fix/cursor-pos", "--no-install"])).toEqual({
      action: "create",
      name: "bugfix",
      branch: "fix/cursor-pos",
      options: { install: false, direnv: true, hooks: true, allowDirty: false, baseRef: "origin/main", fetch: true },
    })
  })

  // The default IS the fix: a create with no base flag must plan origin/main,
  // never local HEAD. Asserted here at the CLI boundary so a future flag-parsing
  // refactor can't quietly drop the default and re-open the 226-behind bug.
  test("create defaults to basing on origin/main, with --base/--no-fetch as opt-outs", () => {
    const planned = planCliInvocation(["create", "adhoc1"])
    expect(planned).toMatchObject({ options: { baseRef: "origin/main", fetch: true } })

    expect(planCliInvocation(["create", "adhoc1", "--base", "HEAD"])).toMatchObject({
      options: { baseRef: "HEAD", fetch: true },
    })
    expect(planCliInvocation(["create", "adhoc1", "--no-fetch"])).toMatchObject({
      options: { baseRef: "origin/main", fetch: false },
    })
  })

  test("--base requires a value rather than swallowing the next flag", () => {
    expect(planCliInvocation(["create", "adhoc1", "--base"])).toEqual({
      action: "usage-error",
      message: "--base requires a value",
    })
  })
})

describe("planCliInvocation — unknown flags fail loud (shape guard)", () => {
  test("an unmapped flag on a subcommand is a usage error, not silently ignored", () => {
    expect(planCliInvocation(["reset", "wt3", "--frce"])).toMatchObject({ action: "usage-error" })
    expect(planCliInvocation(["create", "wt3", "--allowdirty"])).toMatchObject({ action: "usage-error" })
  })

  test("a value-taking flag missing its value is a usage error", () => {
    expect(planCliInvocation(["reset", "wt3", "--save-ahead-as"])).toMatchObject({ action: "usage-error" })
    expect(planCliInvocation(["create", "--branch"])).toMatchObject({ action: "usage-error" })
  })

  test("extra positionals are a usage error (create takes at most name+branch, others one name)", () => {
    expect(planCliInvocation(["reset", "wt3", "wt4"])).toMatchObject({ action: "usage-error" })
    expect(planCliInvocation(["create", "a", "b", "c"])).toMatchObject({ action: "usage-error" })
  })

  test("unknown command errors; bare invocation is the default info screen", () => {
    expect(planCliInvocation(["frobnicate"])).toMatchObject({ action: "usage-error" })
    expect(planCliInvocation([])).toEqual({ action: "default-info" })
  })

  test("the retired merge command teaches the repository landing workflow", () => {
    const refusal = {
      action: "usage-error",
      message:
        "The worktree merge command was retired; push the branch and use the repository's authorized landing workflow.",
    } as const
    expect(planCliInvocation(["merge", "wt5"])).toEqual(refusal)
    expect(planCliInvocation(["merge", "--help"])).toEqual(refusal)
    expect(planCliInvocation(["merge", "-h"])).toEqual(refusal)
    expect(planCliInvocation(["merge"])).toEqual(refusal)
  })
})

describe("assertValidWorktreeName — defense in depth at the API layer", () => {
  test("flag-shaped and empty names throw before any filesystem work", () => {
    expect(() => assertValidWorktreeName("--help")).toThrow(/worktree name/)
    expect(() => assertValidWorktreeName("-f")).toThrow(/worktree name/)
    expect(() => assertValidWorktreeName("")).toThrow(/worktree name/)
  })

  test("normal slot names, scratch names, and paths pass", () => {
    expect(() => assertValidWorktreeName("wt3")).not.toThrow()
    expect(() => assertValidWorktreeName("wt-ci")).not.toThrow()
    expect(() => assertValidWorktreeName("my-feature")).not.toThrow()
    expect(() => assertValidWorktreeName("../hh-wt5")).not.toThrow()
  })
})
