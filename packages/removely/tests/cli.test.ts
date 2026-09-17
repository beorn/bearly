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

/** Run the CLI with stdout captured, and hand back what a caller would read. */
function captureHelp(argv: readonly string[]): { code: number; text: string } {
  const output: string[] = []
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(" "))
  })
  try {
    return { code: runCli(argv), text: output.join("\n") }
  } finally {
    spy.mockRestore()
  }
}

describe("runCli", () => {
  test("--help prints usage and exits successfully", () => {
    const { code, text } = captureHelp(["--help"])
    expect(code).toBe(0)
    expect(text).toMatch(/usage: removely/u)
  })

  /**
   * 24601: the help is the only place a shell caller can read the contract —
   * no docstring, no types. Each clause below is a question the operator asked
   * of the one-line usage this replaced, so each is asserted by its own
   * meaning rather than by a word count.
   */
  test("--help explains every argument, including which default --allowed-root replaces", () => {
    const { code, text } = captureHelp(["--help"])
    expect(code).toBe(0)

    expect(text, "what the tool is for").toMatch(/only where it is provably inside a root you name/iu)
    expect(text, "the target").toMatch(/<target>\s+the file, directory or symlink to remove/u)
    expect(text, "--within is mandatory and has no default").toMatch(/--within <root>\s+MANDATORY/u)
    expect(text, "--allow-missing").toMatch(/--allow-missing[\s\S]*Exit 0 when the target does not exist/u)
    expect(text, "--allowed-root repeats").toMatch(/--allowed-root <path>\s+Repeatable/u)
    expect(text, "the system temp default").toMatch(/Defaults to the system temporary directory/u)
    expect(text, "supplied roots REPLACE that default").toMatch(/REPLACES that default; it never adds to it/u)
  })

  test("--help explains what is refused: strict containment, the symlink leaf, the root policy", () => {
    const { text } = captureHelp(["--help"])

    expect(text, "equality is not containment").toMatch(/equality is not inside/u)
    expect(text, "a shared prefix is not containment").toMatch(/a shared prefix is not containment/u)
    expect(text, "both sides are resolved").toMatch(/resolved with realpath first/u)
    expect(text, "the symlink leaf is refused, not followed").toMatch(/Symlink leaf[\s\S]*refused rather than/u)
    expect(text, "--within must itself sit in an allowed root").toMatch(/must itself be inside an allowed/u)
    expect(text, "the honest scope").toMatch(/hygiene, not a security boundary/u)
    expect(text, "the three exit codes a caller branches on").toMatch(
      /0\s+removed[\s\S]*2\s+REFUSED[\s\S]*64\s+usage error/u,
    )
    expect(text, "runnable examples").toMatch(/EXAMPLES[\s\S]*removely \/tmp\/build-2f9c --within \/tmp/u)
  })

  test("-h is the same help, and the text carries no ANSI so a pipe reads what a terminal reads", () => {
    const short = captureHelp(["-h"])
    const long = captureHelp(["--help"])
    expect(short.code).toBe(0)
    expect(short.text).toBe(long.text)
    // eslint-disable-next-line no-control-regex -- asserting the ABSENCE of control bytes is the point
    expect(short.text, "no escape sequences to strip under NO_COLOR or a pipe").not.toMatch(/\[/u)
  })

  test("--help beside a real target prints help and removes nothing", () => {
    const survivor = makeDir("help-not-a-delete")
    const { code, text } = captureHelp([survivor, "--within", root, "--help"])
    expect(code).toBe(0)
    expect(text).toMatch(/usage: removely/u)
    expect(existsSync(survivor), "asking for the contract is never a delete").toBe(true)
  })

  test("a usage error explains the problem, points at the help, and removes nothing", () => {
    const survivor = makeDir("usage-error-survivor")
    const captured = captureStderr()
    try {
      expect(runCli([survivor, "--within", root, "--recursive"])).toBe(64)
      const text = captured.messages.join("\n")
      expect(text, "the problem, named").toMatch(/unknown flag --recursive/u)
      expect(text, "and where the contract is").toMatch(/removely --help/u)
    } finally {
      captured.restore()
    }
    expect(existsSync(survivor), "a call that never parsed cannot have deleted").toBe(true)
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
