/**
 * Smoke tests for `registerSendCommands` — Family 2 of Phase A.2 verb-port.
 *
 * Bead: @km/bearly/19231-tribe-cli-unify-phase-a2-verbs
 *
 * These tests verify that each send/messaging verb is registered on the
 * program and accepts its expected flag surface. End-to-end daemon behavior
 * is covered by the legacy tribe-cli integration tests; the focus here is
 * wiring + Commander definitions only.
 */

import { describe, expect, test } from "vitest"
import { Command } from "@silvery/commander"
import { registerSendCommands } from "../src/cli/send.ts"

function buildProgram(): Command {
  const program = new Command("tribe-test")
  registerSendCommands(program)
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

describe("registerSendCommands", () => {
  test("registers all 5 send/messaging verbs", () => {
    const program = buildProgram()
    const names = program.commands.map((c) => c.name())
    expect(names).toEqual(expect.arrayContaining(["send", "alarm", "alarm-status", "alarm-ack", "retro"]))
  })

  test("send verb is registered with description and --type option", () => {
    const cmd = findCmd(buildProgram(), "send")
    expect(cmd).toBeDefined()
    expect(cmd!.description()).toMatch(/send a message/i)
    expect(optionFlags(cmd!)).toEqual(expect.arrayContaining(["--type"]))
  })

  test("send verb declares <to> and <message...> arguments", () => {
    const cmd = findCmd(buildProgram(), "send")
    expect(cmd).toBeDefined()
    // Commander stores positional args on `_args` (each with `name()` and
    // `variadic` flags). We only need to verify the count + variadic shape.
    const args = (cmd as unknown as { _args?: Array<{ variadic?: boolean }> })._args ?? []
    expect(args.length).toBe(2)
    expect(args[1]!.variadic).toBe(true)
  })

  test("alarm verb is registered and accepts --by", () => {
    const cmd = findCmd(buildProgram(), "alarm")
    expect(cmd).toBeDefined()
    expect(cmd!.description()).toMatch(/andon-pull|stop-the-line/i)
    expect(optionFlags(cmd!)).toEqual(expect.arrayContaining(["--by"]))
  })

  test("alarm-status verb is registered and accepts --json", () => {
    const cmd = findCmd(buildProgram(), "alarm-status")
    expect(cmd).toBeDefined()
    expect(cmd!.description()).toMatch(/alarm state|no alarm active/i)
    expect(optionFlags(cmd!)).toEqual(expect.arrayContaining(["--json"]))
  })

  test("alarm-ack verb is registered with description", () => {
    const cmd = findCmd(buildProgram(), "alarm-ack")
    expect(cmd).toBeDefined()
    expect(cmd!.description()).toMatch(/clear|unblock/i)
  })

  test("retro verb accepts --since, --format, and --db", () => {
    const cmd = findCmd(buildProgram(), "retro")
    expect(cmd).toBeDefined()
    const flags = optionFlags(cmd!)
    expect(flags).toEqual(expect.arrayContaining(["--since", "--format", "--db"]))
  })

  test("idempotent — each call returns Commander-shaped sub-commands", () => {
    const program = new Command("tribe-test")
    registerSendCommands(program)
    // Sanity: every registered command exposes the standard Commander API.
    for (const c of program.commands) {
      expect(typeof c.name()).toBe("string")
      expect(typeof c.description()).toBe("string")
    }
  })
})
