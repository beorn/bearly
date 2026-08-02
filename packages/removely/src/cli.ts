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
 *   0  removed (or absent with --allow-missing)
 *   2  REFUSED — target is not strictly inside the containment root
 *   64 usage error
 */

import { safeRemoveSync } from "./index.ts"

interface ParsedArgs {
  target: string
  within: string
  allowMissing: boolean
  allowedRoots: string[]
}

const USAGE = "usage: removely <target> --within <root> [--allow-missing] [--allowed-root <path>]…"

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
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    console.error(`removely: ${error instanceof Error ? error.message : String(error)}`)
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
    return 2
  }
  return 0
}

if (import.meta.main) {
  process.exit(runCli(process.argv.slice(2)))
}
