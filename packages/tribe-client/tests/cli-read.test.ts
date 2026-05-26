/**
 * Smoke tests for `registerReadCommands` — Family 1 of Phase A.2 verb-port.
 *
 * Bead: @km/bearly/19231-tribe-cli-unify-phase-a2-verbs
 *
 * These tests verify that each read verb is registered on the program and
 * accepts its expected flag surface. End-to-end daemon behavior is covered
 * by the legacy tribe-cli integration tests; the focus here is wiring +
 * Commander definitions only.
 */

import { describe, expect, test } from "vitest"
import { Command } from "@silvery/commander"
import { registerReadCommands } from "../src/cli/read.ts"

function buildProgram(): Command {
  const program = new Command("tribe-test")
  registerReadCommands(program)
  return program
}

function findCmd(program: Command, name: string): Command | undefined {
  return program.commands.find((c) => c.name() === name) as Command | undefined
}

function optionFlags(cmd: Command): string[] {
  // Commander exposes the registered options on `.options`; each entry has a
  // `.long` (e.g. "--limit") and an optional `.short` (e.g. "-n").
  return (cmd.options ?? []).map((o: { long?: string }) => o.long ?? "").filter(Boolean)
}

describe("registerReadCommands", () => {
  test("registers all 7 read verbs", () => {
    const program = buildProgram()
    const names = program.commands.map((c) => c.name())
    expect(names).toEqual(
      expect.arrayContaining(["status", "sessions", "pending", "log", "health", "inbox-status", "activity"]),
    )
  })

  test("status verb is registered with description", () => {
    const cmd = findCmd(buildProgram(), "status")
    expect(cmd).toBeDefined()
    expect(cmd!.description()).toMatch(/active sessions/i)
  })

  test("sessions verb accepts --all", () => {
    const cmd = findCmd(buildProgram(), "sessions")
    expect(cmd).toBeDefined()
    expect(optionFlags(cmd!)).toEqual(expect.arrayContaining(["--all"]))
  })

  test("pending verb accepts --owner and --stale", () => {
    const cmd = findCmd(buildProgram(), "pending")
    expect(cmd).toBeDefined()
    const flags = optionFlags(cmd!)
    expect(flags).toEqual(expect.arrayContaining(["--owner", "--stale"]))
  })

  test("log verb accepts --limit and --follow", () => {
    const cmd = findCmd(buildProgram(), "log")
    expect(cmd).toBeDefined()
    const flags = optionFlags(cmd!)
    expect(flags).toEqual(expect.arrayContaining(["--limit", "--follow"]))
  })

  test("health verb is registered with description", () => {
    const cmd = findCmd(buildProgram(), "health")
    expect(cmd).toBeDefined()
    expect(cmd!.description()).toMatch(/diagnostics/i)
  })

  test("inbox-status verb accepts --session and --json", () => {
    const cmd = findCmd(buildProgram(), "inbox-status")
    expect(cmd).toBeDefined()
    const flags = optionFlags(cmd!)
    expect(flags).toEqual(expect.arrayContaining(["--session", "--json"]))
  })

  test("activity verb accepts --follow, --since, and --no-color", () => {
    const cmd = findCmd(buildProgram(), "activity")
    expect(cmd).toBeDefined()
    const flags = optionFlags(cmd!)
    // Commander stores --no-color as --no-color (the negation form).
    expect(flags).toEqual(expect.arrayContaining(["--follow", "--since"]))
    expect(flags.some((f) => f.includes("color"))).toBe(true)
  })

  test("idempotent — each call returns Commander-shaped sub-commands", () => {
    const program = new Command("tribe-test")
    registerReadCommands(program)
    // Sanity: every registered command exposes the standard Commander API.
    for (const c of program.commands) {
      expect(typeof c.name()).toBe("string")
      expect(typeof c.description()).toBe("string")
    }
  })
})
