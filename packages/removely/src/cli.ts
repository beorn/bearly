#!/usr/bin/env bun
/**
 * `removely` — the shell entry point to the guarded removal predicate.
 *
 * This exists so a shell caller does not have to hand-roll containment. Three
 * independent hand-rolled versions had already accreted before this file
 * existed, and they disagreed on all three questions that matter: which root
 * they contained to, whether a path that merely *prefixes* the root counts as
 * inside it, and whether a refusal was loud or silent. One of them refused by
 * returning null.
 *
 * There is exactly ONE refusal predicate in this package and it lives in
 * `index.ts`. This file is argument parsing and an exit code — deliberately no
 * second implementation, because "the shell one drifted" is precisely how the
 * three versions came to disagree.
 *
 * Usage:
 *   removely <target> --within <root> [--allow-missing] [--allowed-root <path>]…
 *
 * Exit codes:
 *   0  removed (or absent with --allow-missing); `--help` also exits 0
 *   2  REFUSED — target is not strictly inside the containment root
 *   64 usage error
 *
 * `HELP` below is the only place the guarantees are stated for a shell caller,
 * who has no docstring and no types. It says what is refused and why, because a
 * refusal whose rule cannot be looked up is a refusal that gets worked around —
 * which is how the three hand-rolled containment checks above came to exist.
 */

import { safeRemoveSync } from "./index.ts"

interface ParsedArgs {
  target: string
  within: string
  allowMissing: boolean
  allowedRoots: string[]
}

const USAGE = "usage: removely <target> --within <root> [--allow-missing] [--allowed-root <path>]…"

/** Every refusal path ends here, so a caller never has to guess where the contract is written down. */
const HELP_POINTER = "Run `removely --help` for what is refused and why."

/**
 * The whole contract, in the one place a caller can reach without a browser.
 *
 * Plain text on purpose: this package has no runtime dependencies and emits no
 * ANSI, so the help reads the same on a terminal, through a pipe and under
 * NO_COLOR. Kept as lines rather than a template literal so no `$` in an
 * example can ever interpolate.
 */
const HELP = [
  "removely — remove a path, but only where it is provably inside a root you name.",
  "",
  USAGE,
  "  removely --help",
  "",
  "ARGUMENTS",
  "  <target>                the file, directory or symlink to remove.",
  "  --within <root>         MANDATORY containment root. The target must resolve to a path",
  "                          strictly inside it. There is no default: a delete that cannot",
  "                          name what it is allowed to touch is refused instead of guessed.",
  "  --allow-missing         Exit 0 when the target does not exist. Without it an absent",
  "                          target is a refusal, so a wrong path stays loud.",
  "  --allowed-root <path>   Repeatable. The policy list that --within itself must sit in.",
  "                          Defaults to the system temporary directory (resolved).",
  "                          Supplying it REPLACES that default; it never adds to it.",
  "",
  "WHAT IS REFUSED, AND WHY",
  "  Strict containment      The target must be a strict descendant of the root.",
  "                          `removely /tmp/work --within /tmp/work` is refused, because",
  "                          equality is not inside, and so is `/tmp/work-evil --within",
  "                          /tmp/work`: a shared prefix is not containment. Both sides are",
  "                          resolved with realpath first, so no symlink along the path can",
  "                          carry the target out of the root.",
  "  Symlink leaf            A target that is itself a symlink is refused rather than",
  "                          followed, because removing it could mean the link or the tree",
  "                          it points at, and those are different deletes.",
  "  Root outside policy     The root named by --within must itself be inside an allowed",
  "                          root, so a correct-looking --within cannot authorize a delete",
  "                          anywhere on the disk.",
  "",
  "  This is hygiene, not a security boundary: it binds cooperative callers, and a shell",
  "  loop running as the same user ignores it entirely.",
  "",
  "EXIT CODES",
  "  0   removed, or absent with --allow-missing. --help also exits 0 and removes nothing.",
  "  2   REFUSED, or the removal itself failed. Nothing outside the root is touched.",
  "  64  usage error: a missing, unknown or malformed argument. Nothing is removed.",
  "",
  "EXAMPLES",
  "  # one scratch directory, contained by the system temp root",
  "  removely /tmp/build-2f9c --within /tmp",
  "",
  "  # teardown that tolerates a fixture another step already removed",
  '  removely "$fixture" --within "$TMPDIR" --allow-missing',
  "",
  "  # a tree outside the system temp: declare the root that may hold it",
  "  removely /srv/cache/run-7 --within /srv/cache --allowed-root /srv",
].join("\n")

/** `--help` anywhere wins, so asking for the contract can never remove anything. */
function helpRequested(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === "--help" || arg === "-h")
}

/**
 * Parse argv, or throw a usage error. Exported so the tests drive the real
 * parser rather than a paraphrase of it.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let target: string | undefined
  let within: string | undefined
  let allowMissing = false
  const allowedRoots: string[] = []

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? ""
    if (arg === "--within" || arg === "--allowed-root") {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value. ${USAGE}`)
      }
      if (arg === "--within") within = value
      else allowedRoots.push(value)
      index++
      continue
    }
    if (arg === "--allow-missing") {
      allowMissing = true
      continue
    }
    if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}. ${USAGE}`)
    if (target !== undefined) throw new Error(`unexpected second target ${arg}. ${USAGE}`)
    target = arg
  }

  // An unset shell variable expands to the empty string, which is the exact
  // input that made 2026-07-31 possible. Refuse it here rather than let it
  // reach the predicate as a missing argument.
  if (target === undefined || target.length === 0) throw new Error(`missing target. ${USAGE}`)
  if (within === undefined || within.length === 0) throw new Error(`missing --within. ${USAGE}`)
  return { target, within, allowMissing, allowedRoots }
}

export function runCli(argv: readonly string[]): number {
  if (helpRequested(argv)) {
    console.log(HELP)
    return 0
  }

  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    console.error(`removely: ${error instanceof Error ? error.message : String(error)}`)
    console.error(HELP_POINTER)
    return 64
  }

  try {
    safeRemoveSync(parsed.target, {
      within: parsed.within,
      allowMissing: parsed.allowMissing,
      allowedRoots: parsed.allowedRoots.length > 0 ? parsed.allowedRoots : undefined,
    })
  } catch (error) {
    console.error(`removely: ${error instanceof Error ? error.message : String(error)}`)
    // The predicate's message says what was refused; this says where the rule
    // is written down. A refusal a caller cannot look up gets worked around.
    console.error(HELP_POINTER)
    return 2
  }
  return 0
}

if (import.meta.main) {
  process.exit(runCli(process.argv.slice(2)))
}
