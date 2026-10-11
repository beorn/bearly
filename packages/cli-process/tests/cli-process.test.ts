/**
 * @failure  A CLI's output to a slow pipe loses its tail: a console.log past 64 KiB after the stdout stream was used
 *           (Bun before 1.4.3 drops it on EAGAIN, hh 27071; the first row is the canary that it stays fixed), or a
 *           reader that closes early reads as success instead of a named EPIPE.
 * @level    l2 — real child processes writing into a real pipe whose reader waits before reading.
 * @consumer every CLI entry that adopts @bearly/cli-process (tent, gitomic; hh 27071 census)
 * @testonly none
 */
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import { slowPipeRoundTrip } from "../src/testing.ts"

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}.ts`, import.meta.url))
const FULL = 300_001

describe("a CLI's output reaches a slow reader whole (hh 27071)", () => {
  // Bun 1.4.3 fixed the drop this package was built around: unrouted, the fixture now delivers every byte (it
  // delivered 65,536 while the bug lived). The routed rows stay for consumers on an older Bun (engines.bun >=1.3.13).
  test("control: Bun 1.4.3 no longer drops the tail of an unrouted console.log on a slow pipe (hh 27071)", async () => {
    const run = await slowPipeRoundTrip(["bun", fixture("unrouted-log")])
    expect(run.exitCode).toBe(4)
    expect(run.bytes, "Bun regressed: the unrouted console.drop is back (hh 27071)").toBe(FULL)
  })

  test("routed through the streams, every byte arrives and the exit code is the command's", async () => {
    const run = await slowPipeRoundTrip(["bun", fixture("routed-log")])
    expect({ bytes: run.bytes, exitCode: run.exitCode }).toEqual({ bytes: FULL, exitCode: 4 })
  })

  test("a reader that closes early fails the command by name with its arguments, exit 1, and no stack", async () => {
    const run = await slowPipeRoundTrip(["bun", fixture("routed-log"), "--json"], { closeAfterBytes: 100 })
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toContain("fixture: stdout refused the output of `fixture --json`: EPIPE")
    expect(run.stderr).not.toMatch(/^\s+at /mu)
  })
})
