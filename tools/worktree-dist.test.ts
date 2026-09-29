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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
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

/**
 * @failure Root's worktree composition skips setup, changes defaults, or hides a required failure.
 * @level l2
 * @consumer Bearly create and root's worktree creator use the same public setup operation.
 * @testonly none
 * CLI parsing and installDependencies alone cannot witness the setup sequence.
 */
describe("public worktree setup", () => {
  function fixture(): string {
    writePkg(root, { name: "setup-root", workspaces: ["pkgs/*"], scripts: { prepare: "echo hooks >> hooks-ran" } })
    writePkg(join(root, "pkgs", "built"), {
      name: "setup-built",
      exports: { ".": "./dist/index.js" },
      scripts: { build: "mkdir -p dist && echo ready > dist/index.js" },
    })
    writeFileSync(join(root, ".envrc"), "# setup fixture\n")
    const bin = join(root, "bin")
    mkdirSync(bin)
    writeFileSync(join(bin, "direnv"), '#!/bin/sh\nprintf allowed > "$2/direnv-ran"\n')
    chmodSync(join(bin, "direnv"), 0o755)
    return bin
  }

  function setup(options?: { install?: boolean; direnv?: boolean; hooks?: boolean }, bin = join(root, "bin")) {
    const source = join(import.meta.dirname, "worktree.ts")
    return spawnSync(
      "bun",
      [
        "--eval",
        `import { setupWorktree } from ${JSON.stringify(source)}; await setupWorktree(${JSON.stringify(root)}, ${JSON.stringify(options)});`,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        timeout: 15_000,
      },
    )
  }

  test.each([
    { label: "defaults", options: undefined, install: true, direnv: true, hooks: true },
    { label: "install disabled", options: { install: false }, install: false, direnv: true, hooks: true },
    { label: "direnv disabled", options: { direnv: false }, install: true, direnv: false, hooks: true },
    { label: "hooks disabled", options: { hooks: false }, install: true, direnv: true, hooks: false },
  ])("$label preserves independent setup flags", ({ options, install, direnv, hooks }) => {
    fixture()
    const result = setup(options)
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(root, "pkgs", "built", "dist", "index.js"))).toBe(install)
    expect(existsSync(join(root, "direnv-ran"))).toBe(direnv)
    expect(existsSync(join(root, "hooks-ran"))).toBe(hooks)
    if (hooks) expect(readFileSync(join(root, "hooks-ran"), "utf8")).toBe("hooks\n")
  })

  test("required installation failure names its target and prevents later setup", () => {
    fixture()
    writeFileSync(join(root, "bun.lock"), "invalid frozen lockfile\n")
    const result = setup()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(root)
    expect(result.stderr).toContain("install")
    expect(existsSync(join(root, "direnv-ran"))).toBe(false)
    expect(existsSync(join(root, "hooks-ran"))).toBe(false)
  })

  test.each([
    {
      label: "declared prepare failure",
      packageJson: JSON.stringify({ name: "setup-root", scripts: { prepare: "echo hook-failure >&2; exit 7" } }),
      diagnostic: "hook-failure",
    },
    { label: "malformed package metadata", packageJson: "{ invalid package metadata", diagnostic: "hooks" },
  ])("$label rejects instead of reporting hooks installed", ({ packageJson, diagnostic }) => {
    fixture()
    writeFileSync(join(root, "package.json"), packageJson)
    const result = setup({ install: false, direnv: false })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(root)
    expect(result.stderr).toContain("prepare")
    expect(result.stderr).toContain(diagnostic)
    expect(result.stdout).not.toContain("Hooks installed")
  })

  test("optional unavailable direnv reports degradation and continues required hooks", () => {
    const bin = fixture()
    writeFileSync(join(bin, "direnv"), "#!/bin/sh\necho fixture-direnv-unavailable >&2\nexit 127\n")
    const result = setup({ install: false })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain(root)
    expect(result.stderr).toContain("direnv")
    expect(result.stderr).toContain("fixture-direnv-unavailable")
    expect(readFileSync(join(root, "hooks-ran"), "utf8")).toBe("hooks\n")
  })

  test("create retains setup defaults and respects all disabled flags", () => {
    // A private Git fixture stays inside the owning checkout, not the shared tmpfs.
    const base = mkdtempSync(join(process.cwd(), ".worktree-create-"))
    try {
      const repo = join(base, "repo")
      const bin = join(base, "bin")
      mkdirSync(repo)
      mkdirSync(bin)
      writeFileSync(join(bin, "direnv"), '#!/bin/sh\nprintf allowed > "$2/direnv-ran"\n')
      chmodSync(join(bin, "direnv"), 0o755)
      writePkg(repo, {
        name: "create-fixture",
        scripts: { prepare: "echo hooks >> hooks-ran" },
        workspaces: ["pkgs/*"],
      })
      writePkg(join(repo, "pkgs", "built"), {
        name: "create-built",
        exports: { ".": "./dist/index.js" },
        scripts: { build: "mkdir -p dist && echo ready > dist/index.js" },
      })
      writeFileSync(join(repo, ".envrc"), "# fixture\n")
      const git = (args: string[]) => {
        const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" })
        if (result.status !== 0) throw new Error(`fixture git ${args.join(" ")}: ${result.stderr}`)
      }
      git(["init", "-q", "--template=", "-b", "main"])
      git(["config", "user.name", "Setup Fixture"])
      git(["config", "user.email", "setup@example.test"])
      git(["config", "worktree.poolRoot", base])
      git(["add", "."])
      git(["commit", "-qm", "fixture"])
      const source = join(import.meta.dirname, "worktree.ts")
      for (const [name, options, enabled] of [
        ["defaults", { base: "HEAD" }, true],
        ["disabled", { base: "HEAD", install: false, direnv: false, hooks: false }, false],
      ] as const) {
        const result = spawnSync(
          "bun",
          [
            "--eval",
            `import { createWorktree } from ${JSON.stringify(source)}; await createWorktree(${JSON.stringify(name)}, undefined, ${JSON.stringify(options)});`,
          ],
          {
            cwd: repo,
            encoding: "utf8",
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
            timeout: 15_000,
          },
        )
        expect(result.status, result.stderr + result.stdout).toBe(0)
        const checkout = join(base, `repo-${name}`)
        expect(existsSync(join(checkout, "pkgs", "built", "dist", "index.js"))).toBe(enabled)
        expect(existsSync(join(checkout, "direnv-ran"))).toBe(enabled)
        expect(existsSync(join(checkout, "hooks-ran"))).toBe(enabled)
        if (enabled) expect(readFileSync(join(checkout, "hooks-ran"), "utf8")).toBe("hooks\n")
      }
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
