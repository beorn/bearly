/**
 * The shell entry point shares the library's refusal predicate.
 *
 * These tests exist because the three hand-rolled containment checks this
 * package replaced were all SHELL-adjacent, and the one written in bash was the
 * one that drifted furthest. The contract asserted here is narrow and specific:
 * argv parsing is strict, refusal is loud, and the exit code distinguishes
 * "you asked me to delete the wrong thing" (2) from "you called me wrong" (64).
 * A shell caller that cannot tell those apart will paper over both.
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test, vi } from "vitest"
import { parseArgs, runCli } from "../src/cli.ts"
import { safeRemoveSync } from "../src/index.ts"

const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "removely-cli-")))

afterAll(() => {
  safeRemoveSync(root, { within: realpathSync(tmpdir()), allowMissing: true })
})

function makeDir(name: string): string {
  const path = join(root, name)
  mkdirSync(join(path, "nested"), { recursive: true })
  writeFileSync(join(path, "nested", "f.txt"), "x")
  return path
}

/** Silence the CLI's stderr while still letting us assert on it. */
function captureStderr(): { messages: string[]; restore: () => void } {
  const messages: string[] = []
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    messages.push(args.map(String).join(" "))
  })
  return { messages, restore: () => spy.mockRestore() }
}

describe("parseArgs", () => {
  test("reads the target, the root, and the flags", () => {
    const parsed = parseArgs(["/tmp/a", "--within", "/tmp", "--allow-missing", "--allowed-root", "/tmp"])
    expect(parsed).toEqual({
      target: "/tmp/a",
      within: "/tmp",
      allowMissing: true,
      allowedRoots: ["/tmp"],
    })
  })

  test("refuses a missing --within rather than inventing one", () => {
    expect(() => parseArgs(["/tmp/a"])).toThrow(/missing --within/u)
  })

  test("refuses an empty target — the unset-shell-variable shape", () => {
    expect(() => parseArgs(["", "--within", "/tmp"])).toThrow(/missing target/u)
  })

  test("refuses a flag value that is really the next flag", () => {
    expect(() => parseArgs(["/tmp/a", "--within", "--allow-missing"])).toThrow(/--within requires a value/u)
  })

  test("refuses an unknown flag instead of ignoring it", () => {
    expect(() => parseArgs(["/tmp/a", "--within", "/tmp", "--recursive"])).toThrow(/unknown flag --recursive/u)
  })
})

describe("runCli", () => {
  test("--help prints usage and exits successfully", () => {
    const output: string[] = []
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => output.push(args.map(String).join(" ")))
    try {
      expect(runCli(["--help"])).toBe(0)
      expect(output.join("\n")).toMatch(/usage: removely/u)
    } finally {
      spy.mockRestore()
    }
  })

  test("exit 0 removes a target inside the root", () => {
    const target = makeDir("inside")
    expect(runCli([target, "--within", root])).toBe(0)
    expect(existsSync(target)).toBe(false)
  })

  test("exit 2 REFUSES a target outside the root, and the target survives", () => {
    const outsider = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "removely-cli-out-")))
    const owned = makeDir("owner")
    const captured = captureStderr()

    try {
      expect(runCli([outsider, "--within", owned])).toBe(2)
      expect(captured.messages.join("\n")).toMatch(/REFUSED/u)
    } finally {
      captured.restore()
    }
    expect(existsSync(outsider), "a refused delete must not happen").toBe(true)
    safeRemoveSync(outsider, { within: realpathSync(tmpdir()) })
  })

  test("exit 2 REFUSES a containment root outside the allowed roots", () => {
    const captured = captureStderr()
    try {
      expect(runCli([join(root, "anything"), "--within", root, "--allowed-root", "/nonexistent-allowed-root"])).toBe(2)
      expect(captured.messages.join("\n")).toMatch(/not under an allowed root/u)
    } finally {
      captured.restore()
    }
  })

  test("exit 64 for a usage error, kept distinct from a refusal", () => {
    const captured = captureStderr()
    try {
      expect(runCli(["--within", root])).toBe(64)
      expect(captured.messages.join("\n")).toMatch(/missing target/u)
    } finally {
      captured.restore()
    }
  })

  test("--allow-missing tolerates an absent target; without it, absence is an error", () => {
    const absent = join(root, "never-created")
    expect(runCli([absent, "--within", root, "--allow-missing"])).toBe(0)

    const captured = captureStderr()
    try {
      expect(runCli([absent, "--within", root])).toBe(2)
      expect(captured.messages.join("\n")).toMatch(/does not exist/u)
    } finally {
      captured.restore()
    }
  })
})
