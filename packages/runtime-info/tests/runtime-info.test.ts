import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, test } from "vitest"
import {
  composeRuntimeInfo,
  formatRuntimeInfo,
  formatRuntimeInfoLine,
  readGitState,
  readRuntimeSourceReceipt,
  readWorkspaceInstallState,
  workspaceDepEdges,
  type RuntimeInfoDeps,
} from "../src/index.ts"

describe("@bearly/runtime-info", () => {
  test("formats semver+sha and keeps dirty visible", () => {
    expect(formatRuntimeInfo({ version: "1.2.3", sha: "abc1234", dirty: false })).toBe("1.2.3+abc1234")
    expect(formatRuntimeInfo({ version: "1.2.3", sha: "abc1234", dirty: true })).toBe("1.2.3+abc1234-dirty")
    expect(formatRuntimeInfoLine("inhab", { version: "1.2.3", sha: "abc1234", dirty: true })).toBe(
      "inhab 1.2.3+abc1234-dirty",
    )
  })

  test("git unavailable degrades to an explicit unknown SHA", () => {
    expect(formatRuntimeInfo({ version: "1.2.3", sha: null, dirty: false })).toBe("1.2.3+unknown")
  })

  test("reads injected git state without requiring a live checkout", () => {
    const deps: RuntimeInfoDeps = {
      cwd: "/repo",
      sh: (cmd, args) => {
        if (cmd === "git" && args.includes("rev-parse")) return { status: 0, stdout: "deadbee\n" }
        if (cmd === "git" && args.includes("status")) return { status: 0, stdout: " M src/index.ts\n" }
        return { status: 1, stdout: "" }
      },
    }
    expect(readGitState(deps)).toEqual({ sha: "deadbee", dirty: true })
  })

  test("status inspection failure invalidates the SHA instead of reporting a false clean identity", () => {
    const deps: RuntimeInfoDeps = {
      cwd: "/repo",
      sh: (_cmd, args) => (args.includes("rev-parse") ? { status: 0, stdout: "deadbee\n" } : { status: 1, stdout: "" }),
    }

    expect(readGitState(deps)).toEqual({ sha: null, dirty: false })
  })

  test.each(["abc123", "not-a-sha", "deadbee\ncafebabe", "a".repeat(65)])(
    "malformed successful HEAD output fails closed: %s",
    (head) => {
      const deps: RuntimeInfoDeps = {
        cwd: "/repo",
        sh: (_cmd, args) =>
          args.includes("rev-parse") ? { status: 0, stdout: `${head}\n` } : { status: 0, stdout: "" },
      }

      expect(readGitState(deps)).toEqual({ sha: null, dirty: false })
    },
  )

  test("the default Git probe ignores inherited repository-scoped GIT_* variables", () => {
    const sourceRoot = resolve(import.meta.dirname, "../../..")
    const foreign = mkdtempSync(join(tmpdir(), "runtime-info-foreign-"))
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: foreign })
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: foreign })
      execFileSync("git", ["config", "user.name", "Runtime Info Test"], { cwd: foreign })
      writeFileSync(join(foreign, "foreign.txt"), "foreign\n")
      execFileSync("git", ["add", "foreign.txt"], { cwd: foreign })
      execFileSync("git", ["commit", "-q", "-m", "test: seed foreign repo"], { cwd: foreign })

      const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: sourceRoot,
        encoding: "utf8",
      }).trim()
      const dirty =
        execFileSync("git", ["status", "--porcelain"], { cwd: sourceRoot, encoding: "utf8" }).trim().length > 0
      const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
        cwd: foreign,
        encoding: "utf8",
      }).trim()
      const output = execFileSync(
        process.execPath,
        [
          "-e",
          'import { nodeRuntimeInfoDeps, readGitState } from "./packages/runtime-info/src/index.ts"; console.log(JSON.stringify(readGitState(nodeRuntimeInfoDeps(process.cwd()))))',
        ],
        {
          cwd: sourceRoot,
          encoding: "utf8",
          env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: foreign },
        },
      )

      expect(JSON.parse(output)).toEqual({ sha, dirty })
    } finally {
      rmSync(foreign, { recursive: true, force: true })
    }
  })

  test("composes runtime info from an explicit version and injected deps", () => {
    const deps: RuntimeInfoDeps = { cwd: "/repo", sh: () => ({ status: 1, stdout: "" }) }
    expect(composeRuntimeInfo("0.0.0", deps)).toEqual({ version: "0.0.0", sha: null, dirty: false })
  })

  test("records a verified clean full-SHA source receipt", () => {
    const sha = "a".repeat(40)
    const deps: RuntimeInfoDeps = {
      cwd: "/physical/deployment-1",
      sh: (_cmd, args) => (args.includes("rev-parse") ? { status: 0, stdout: `${sha}\n` } : { status: 0, stdout: "" }),
    }

    expect(readRuntimeSourceReceipt(deps)).toEqual({
      path: "/physical/deployment-1",
      sha,
      verification: "verified",
      dirty: "clean",
    })
  })

  test("labels a verified dirty source receipt", () => {
    const sha = "b".repeat(40)
    const deps: RuntimeInfoDeps = {
      cwd: "/physical/development",
      sh: (_cmd, args) =>
        args.includes("rev-parse") ? { status: 0, stdout: `${sha}\n` } : { status: 0, stdout: " M src/index.ts\n" },
    }

    expect(readRuntimeSourceReceipt(deps)).toMatchObject({
      sha,
      verification: "verified",
      dirty: "dirty",
    })
  })

  test.each([
    {
      name: "missing Git identity",
      sh: (_cmd: string, args: readonly string[]) =>
        args.includes("rev-parse") ? { status: 128, stdout: "" } : { status: 0, stdout: "" },
      cause: /rev-parse.*status 128/u,
    },
    {
      name: "status inspection failure",
      sh: (_cmd: string, args: readonly string[]) =>
        args.includes("rev-parse") ? { status: 0, stdout: `${"c".repeat(40)}\n` } : { status: 128, stdout: "" },
      cause: /status.*status 128/u,
    },
    {
      name: "instrument failure",
      sh: () => ({
        status: 1,
        stdout: "",
        failure: { kind: "instrument" as const, cause: "spawn EAGAIN" },
      }),
      cause: /spawn EAGAIN/u,
    },
    {
      name: "abbreviated SHA",
      sh: (_cmd: string, args: readonly string[]) =>
        args.includes("rev-parse") ? { status: 0, stdout: "deadbee\n" } : { status: 0, stdout: "" },
      cause: /full Git SHA/u,
    },
  ])("fails closed with typed uncertainty for $name", ({ sh, cause }) => {
    expect(readRuntimeSourceReceipt({ cwd: "/repo", sh })).toMatchObject({
      path: "/repo",
      sha: null,
      verification: "unproven",
      dirty: "unknown",
      cause: expect.stringMatching(cause),
    })
  })
})

// ─── Workspace install-state (the stale-installed-tree class) ───────────────
//
// @failure  plain `bun install` no-ops while a workspace member link is missing;
//           the app crashes at runtime with Cannot-find-module and nothing detects it
// @level    l0 - pure fs + resolver over a tmp fixture
describe("readWorkspaceInstallState", () => {
  const roots: string[] = []
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  /**
   * Fixture: root workspaces ["pkgs/*"]; member `b` depends on member `a` via
   * workspace:*; the root also depends on `b`. `linked` controls whether bun's
   * top-level `node_modules/<name>` links exist (the artifact that goes stale).
   */
  function fixture(opts: { linkA: boolean; linkB: boolean }): string {
    const root = mkdtempSync(join(tmpdir(), "bearly-ws-state-"))
    roots.push(root)
    mkdirSync(join(root, "pkgs", "a"), { recursive: true })
    mkdirSync(join(root, "pkgs", "b"), { recursive: true })
    mkdirSync(join(root, "node_modules"), { recursive: true })
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture-root", workspaces: ["pkgs/*"], dependencies: { b: "workspace:*" } }),
    )
    writeFileSync(join(root, "pkgs", "a", "package.json"), JSON.stringify({ name: "a", main: "index.js" }))
    writeFileSync(join(root, "pkgs", "a", "index.js"), "module.exports = 1\n")
    writeFileSync(
      join(root, "pkgs", "b", "package.json"),
      JSON.stringify({ name: "b", main: "index.js", dependencies: { a: "workspace:*" } }),
    )
    writeFileSync(join(root, "pkgs", "b", "index.js"), "module.exports = 2\n")
    if (opts.linkA) symlinkSync(join(root, "pkgs", "a"), join(root, "node_modules", "a"), "dir")
    if (opts.linkB) symlinkSync(join(root, "pkgs", "b"), join(root, "node_modules", "b"), "dir")
    return root
  }

  test("collects every workspace:* edge (root + members)", () => {
    const root = fixture({ linkA: true, linkB: true })
    const edges = workspaceDepEdges(root)
    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dependent: "fixture-root", dep: "b" }),
        expect.objectContaining({ dependent: "b", dep: "a" }),
      ]),
    )
    expect(edges).toHaveLength(2)
  })

  test("healthy tree: all edges resolve with the real runtime resolver", () => {
    const root = fixture({ linkA: true, linkB: true })
    const state = readWorkspaceInstallState(root)
    expect(state.checkedEdges).toBe(2)
    expect(state.unresolved).toEqual([])
  })

  test("stale tree (the plugin-ag shape): a missing member link is reported as an unresolved edge", () => {
    const root = fixture({ linkA: false, linkB: true })
    const state = readWorkspaceInstallState(root)
    expect(state.unresolved).toEqual([expect.objectContaining({ dependent: "b", dep: "a" })])
  })

  test("resolver seam is honored (no-Bun environments can inject)", () => {
    const root = fixture({ linkA: true, linkB: true })
    const state = readWorkspaceInstallState(root, () => false)
    expect(state.unresolved).toHaveLength(2)
  })
})
