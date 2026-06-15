/**
 * Worktree vendor-resolution readiness — @km/infra/19945.
 *
 * A vendor workspace package that does not resolve through node_modules makes a
 * bare `import "<name>"` throw before any code runs — the wt5 plateau
 * (2026-06-15): `vendor/mdspec` was uninitialized after a frozen install ran
 * before `git submodule update --init`, so focused Vitest died in module
 * resolution and two sub-agent waves degraded to source-only review.
 *
 * `bun worktree audit` must catch this. Two zero-false-positive signals:
 *   - parseUninitializedSubmodules  — the ROOT CAUSE (empty vendor submodule)
 *   - classifyWorkspaceSymlink /
 *     unresolvedWorkspaceSymlinks   — the SYMPTOM (present-but-broken symlink)
 *
 * A wholly-MISSING root symlink is deliberately NOT flagged: bun only hoists a
 * workspace package to the root node_modules when something resolves it there,
 * so a healthy slot legitimately lacks root entries for nested-resolved or
 * unimported packages (verified against a live km slot: 9 such packages).
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { classifyWorkspaceSymlink, parseUninitializedSubmodules, unresolvedWorkspaceSymlinks } from "./worktree.ts"

let root: string

function writePkg(dir: string, pkg: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2))
  return dir
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wt-symlink-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("classifyWorkspaceSymlink", () => {
  test("symlink → dir with package.json → resolves (null)", () => {
    const target = writePkg(join(root, "vendor", "ok"), { name: "ok" })
    const nm = join(root, "node_modules")
    mkdirSync(nm, { recursive: true })
    symlinkSync(target, join(nm, "ok"))
    expect(classifyWorkspaceSymlink(join(nm, "ok"))).toBeNull()
  })

  test("no entry at all → 'missing'", () => {
    mkdirSync(join(root, "node_modules"), { recursive: true })
    expect(classifyWorkspaceSymlink(join(root, "node_modules", "nope"))).toBe("missing")
  })

  test("symlink → nonexistent target → 'dangling'", () => {
    const nm = join(root, "node_modules")
    mkdirSync(nm, { recursive: true })
    symlinkSync(join(root, "vendor", "gone"), join(nm, "gone"))
    expect(classifyWorkspaceSymlink(join(nm, "gone"))).toBe("dangling")
  })

  test("symlink → empty dir (uninitialized submodule) → 'no-manifest'", () => {
    const emptyTarget = join(root, "vendor", "empty")
    mkdirSync(emptyTarget, { recursive: true }) // dir exists, no package.json
    const nm = join(root, "node_modules")
    mkdirSync(nm, { recursive: true })
    symlinkSync(emptyTarget, join(nm, "empty"))
    expect(classifyWorkspaceSymlink(join(nm, "empty"))).toBe("no-manifest")
  })

  test("real directory with package.json (not a symlink) → resolves (null)", () => {
    const dir = writePkg(join(root, "node_modules", "real"), { name: "real" })
    expect(classifyWorkspaceSymlink(dir)).toBeNull()
  })
})

describe("unresolvedWorkspaceSymlinks — present-but-broken only, no false positives", () => {
  function setup(): { nm: string } {
    writePkg(root, { name: "fixture-root", workspaces: ["vendor/*"] })
    const nm = join(root, "node_modules")
    mkdirSync(nm, { recursive: true })
    return { nm }
  }

  test("healthy slot (every entry resolves) → no findings", () => {
    const { nm } = setup()
    const good = writePkg(join(root, "vendor", "good"), { name: "good" })
    symlinkSync(good, join(nm, "good"))
    expect(unresolvedWorkspaceSymlinks(root)).toEqual([])
  })

  test("uninitialized-submodule symlink (→ empty dir) → flagged 'no-manifest'", () => {
    const { nm } = setup()
    // mdspec IS a workspace member (has package.json) but its node_modules
    // entry points at an empty dir — the wt5 signature.
    writePkg(join(root, "vendor", "mdspec"), { name: "mdspec" })
    const empty = join(root, "stale-target")
    mkdirSync(empty, { recursive: true })
    symlinkSync(empty, join(nm, "mdspec"))
    const found = unresolvedWorkspaceSymlinks(root)
    expect(found).toEqual([
      {
        name: "mdspec",
        packageDir: join("vendor", "mdspec"),
        nodeModulesPath: join("node_modules", "mdspec"),
        reason: "no-manifest",
      },
    ])
  })

  test("dangling symlink → flagged 'dangling'", () => {
    const { nm } = setup()
    writePkg(join(root, "vendor", "foo"), { name: "foo" })
    symlinkSync(join(root, "vendor", "foo", "GONE"), join(nm, "foo"))
    const found = unresolvedWorkspaceSymlinks(root)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ name: "foo", reason: "dangling" })
  })

  test("MISSING root entry is NOT flagged (bun nests/omits unimported workspace pkgs — the false-positive lesson)", () => {
    setup()
    // Workspace member with NO node_modules entry at all. A healthy slot has
    // many of these; flagging them would be noise.
    writePkg(join(root, "vendor", "nested-only"), { name: "nested-only" })
    expect(unresolvedWorkspaceSymlinks(root)).toEqual([])
  })
})

describe("parseUninitializedSubmodules", () => {
  test("flags only '-'-prefixed (uninitialized) lines", () => {
    const out = parseUninitializedSubmodules(
      [
        " 2794693b606a vendor/bearly (tribe-v0.7.0)",
        "-39bad98317 vendor/mdspec",
        "+6b9137c383 vendor/flexily (v0.7.2-14)",
        "-01fab657bf vendor/silvery",
        "U8e0c01d9f8 vendor/terminfo.dev",
      ].join("\n"),
    )
    expect(out).toEqual(["vendor/mdspec", "vendor/silvery"])
  })

  test("all initialized → empty", () => {
    expect(parseUninitializedSubmodules(" abc vendor/a (v1)\n def vendor/b (v2)\n")).toEqual([])
  })

  test("empty output → empty", () => {
    expect(parseUninitializedSubmodules("")).toEqual([])
  })
})
