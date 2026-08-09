/**
 * dir.move works on a single file as well as a directory. What it cannot see is a path
 * this repository doesn't list — an ignored file, or anything inside a nested repository
 * or submodule. That used to surface as a bare "No files found under prefix", which reads
 * as "your path is wrong" and sent people looking for a file/directory limitation that
 * doesn't exist.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest"
import { spawnSync, execFileSync } from "child_process"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { tmpdir } from "os"

import { listCandidateFiles } from "../../tools/lib/core/file-ops"

const PLUGIN_ROOT = join(dirname(import.meta.filename), "../..")

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" })
}

function runRefactor(cwd: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("bun", [join(PLUGIN_ROOT, "tools/refactor.ts"), ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, FORCE_COLOR: "0" },
  })
  if (result.error) throw result.error
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

describe("dir.move — what the prefix can see", () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "dir-move-visibility-"))
    mkdirSync(join(dir, "pkg"), { recursive: true })
    writeFileSync(join(dir, "pkg/solo.ts"), "export const x = 1\n")
    writeFileSync(join(dir, "pkg/other.ts"), 'import { x } from "./solo"\nexport const y = x\n')
    writeFileSync(join(dir, ".gitignore"), "ignored.ts\n")
    writeFileSync(join(dir, "ignored.ts"), "export const i = 1\n")
    git(dir, "init", "-q")
    git(dir, "add", "pkg", ".gitignore")
    git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("a single tracked FILE moves — the prefix is not directory-only", () => {
    const out = runRefactor(dir, [
      "dir.move",
      "--old",
      "pkg/solo.ts",
      "--new",
      "pkg/renamed.ts",
      "--output",
      join(dir, "m.json"),
    ])
    expect(out.status).toBe(0)
    const parsed = JSON.parse(out.stdout) as { fileCount: number; importEditCount: number }
    expect(parsed.fileCount).toBe(1)
    expect(parsed.importEditCount).toBe(1) // pkg/other.ts imports it
  })

  test("an unlistable path fails loudly and names what was searched", () => {
    const out = runRefactor(dir, [
      "dir.move",
      "--old",
      "ignored.ts",
      "--new",
      "moved.ts",
      "--output",
      join(dir, "m2.json"),
    ])
    expect(out.status).toBe(1)
    const message = out.stderr + out.stdout
    expect(message).toContain("ignored.ts")
    expect(message).toContain("git ls-files")
    expect(message).toContain("submodule")
  })

  test("listCandidateFiles reports where its list came from", async () => {
    const listed = await listCandidateFiles("**/*", dir)
    expect(listed.source).toBe("git")
    expect(listed.files).toContain("pkg/solo.ts")
    expect(listed.files).not.toContain("ignored.ts")
  })
})
