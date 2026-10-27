/**
 * refactor rename.batch — tsconfig discovery must name the directory it searched
 * and point at --tsconfig; --help must document the flag and its blast radius.
 *
 * Before this, running rename.batch from a directory with no tsconfig printed only
 * {"error":"File not found: /abs/path/tsconfig.json"} — no directory named, no
 * remedy given — while --tsconfig was accepted by the CLI but absent from --help,
 * so the one fix a reader needed was undiscoverable. Pointing --tsconfig at a root
 * tsconfig makes ts-morph load every package into one program (32 GB RSS observed),
 * which --help now warns about.
 *
 * @failure  rename.batch run where no tsconfig.json exists fails with a bare
 *           {"error":"File not found: /abs/tsconfig.json"} that names no directory and
 *           no cure, and --help omits --tsconfig and its monorepo blast radius (32 GB
 *           RSS), so a reader whose repo has no root tsconfig cannot find the flag
 *           (hh 31006).
 * @level    l2 — spawns the real refactor CLI as a child process in a temp cwd.
 * @consumer @dev/5 renaming symbols in a repo with no root tsconfig (30928, 31006)
 * @testonly none
 */
import { describe, expect, test } from "vitest"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const CLI = fileURLToPath(new URL("./refactor.ts", import.meta.url))

function run(args: string[], cwd: string) {
  const result = Bun.spawnSync(["bun", CLI, ...args], { cwd })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

describe("rename.batch tsconfig discovery", () => {
  test("a missing tsconfig names the directory searched and points at --tsconfig", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "refactor-tsconfig-")))
    try {
      const { exitCode, stderr } = run(["rename.batch", "--pattern", "/foo/", "--replace", "bar"], dir)
      expect(exitCode).toBe(1)
      expect(stderr).toContain(dir)
      expect(stderr).toContain("pass --tsconfig <path>")
      const parsed = JSON.parse(stderr.trim()) as { error: string }
      expect(parsed.error).toContain(dir)
      expect(parsed.error).not.toMatch(/^File not found/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("--help documents --tsconfig and warns that a root tsconfig loads every package", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "refactor-help-")))
    try {
      const { stdout } = run(["--help"], dir)
      expect(stdout).toContain("--tsconfig")
      expect(stdout).toContain("every package")
      expect(stdout).toContain("32 GB")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
