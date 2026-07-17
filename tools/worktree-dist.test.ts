/**
 * Worktree dist-readiness — `needsDistBuild` + `buildMissingDistPackages`.
 *
 * A workspace package whose `exports` resolve only into `./dist/` is
 * unloadable in a fresh worktree until its build runs (no dist/ is
 * committed). `bun worktree create` must leave such packages built so
 * targeted Vitest runs load immediately, and `bun worktree audit` must
 * flag the missing-dist state with the repair command.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildMissingDistPackages, dependencyInstallPlan, installDependencies, needsDistBuild } from "./worktree.ts"

let root: string

function writePkg(dir: string, pkg: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2))
  return dir
}

const DIST_ONLY_EXPORTS = {
  ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" },
  "./api": "./dist/api.mjs",
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wt-dist-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("needsDistBuild", () => {
  test("dist-only exports + build script + missing dist → true", () => {
    const dir = writePkg(join(root, "a"), {
      name: "a",
      exports: DIST_ONLY_EXPORTS,
      scripts: { build: "true" },
    })
    expect(needsDistBuild(dir)).toBe(true)
  })

  test("src-first exports (the silvery/flexily shape) → false", () => {
    const dir = writePkg(join(root, "b"), {
      name: "b",
      exports: { ".": "./src/index.ts", "./plugin": "./src/plugin.ts" },
      scripts: { build: "true" },
    })
    expect(needsDistBuild(dir)).toBe(false)
  })

  test("dist already present → false", () => {
    const dir = writePkg(join(root, "c"), {
      name: "c",
      exports: DIST_ONLY_EXPORTS,
      scripts: { build: "true" },
    })
    mkdirSync(join(dir, "dist"))
    expect(needsDistBuild(dir)).toBe(false)
  })

  test("no build script to produce dist → false", () => {
    const dir = writePkg(join(root, "d"), {
      name: "d",
      exports: DIST_ONLY_EXPORTS,
    })
    expect(needsDistBuild(dir)).toBe(false)
  })

  test("no exports map at all → false", () => {
    const dir = writePkg(join(root, "e"), { name: "e", scripts: { build: "true" } })
    expect(needsDistBuild(dir)).toBe(false)
  })
})

describe("buildMissingDistPackages", () => {
  test("builds only the dist-only package missing its dist", async () => {
    // The build step logs its progress (info/success) — expected CLI output.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    writePkg(root, { name: "fixture-root", workspaces: ["pkgs/*"] })
    const distOnly = writePkg(join(root, "pkgs", "needs-build"), {
      name: "needs-build",
      exports: DIST_ONLY_EXPORTS,
      scripts: { build: "mkdir -p dist" },
    })
    const srcFirst = writePkg(join(root, "pkgs", "src-first"), {
      name: "src-first",
      exports: { ".": "./src/index.ts" },
      scripts: { build: "mkdir -p dist" },
    })

    try {
      await buildMissingDistPackages(root)

      expect(existsSync(join(distOnly, "dist"))).toBe(true)
      expect(existsSync(join(srcFirst, "dist"))).toBe(false)
      // Idempotent: second run sees dist present and changes nothing.
      await buildMissingDistPackages(root)
      expect(needsDistBuild(distOnly)).toBe(false)
    } finally {
      logSpy.mockRestore()
    }
  })
})

describe("dependency installation is immutable and fail-loud (21301)", () => {
  test("Bun workspaces use the frozen lockfile command", () => {
    writePkg(root, { name: "fixture-root" })
    writeFileSync(join(root, "bun.lock"), "lock\n")

    expect(dependencyInstallPlan(root)).toEqual({
      command: "bun",
      args: ["install", "--frozen-lockfile"],
    })
  })

  test("an install failure rejects slot preparation instead of continuing", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    writePkg(root, { name: "fixture-root" })
    writeFileSync(join(root, "bun.lock"), "lock\n")

    try {
      await expect(
        installDependencies(root, {
          run: async () => ({ exitCode: 1, stdout: "", stderr: "lockfile would change" }),
        }),
      ).rejects.toThrow(/bun install --frozen-lockfile failed.*lockfile would change/)
    } finally {
      logSpy.mockRestore()
    }
  })
})
