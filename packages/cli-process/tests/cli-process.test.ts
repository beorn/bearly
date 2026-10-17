/**
 * @failure  A CLI's output to a slow pipe loses its tail: a console.log past 64 KiB after the stdout stream was used
 *           (Bun before 1.4.3 drops it on EAGAIN, hh 27071; the first row proves the drop on an older Bun and
 *           guards the fix from 1.4.3), or a reader that closes early reads as success instead of a named EPIPE.
 * @level    l2 — real child processes writing into a real pipe whose reader waits before reading.
 * @consumer every CLI entry that adopts @bearly/cli-process (tent, gitomic; hh 27071 census)
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import { slowPipeRoundTrip } from "../src/testing.ts"

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}.ts`, import.meta.url))
const FULL = 300_001

/** The Bun the fixtures run under: the child writes, so its version decides whether the unrouted drop exists. */
function childBunVersion(): readonly [number, number, number] {
  const out = spawnSync("bun", ["--version"], { encoding: "utf8" })
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(out.stdout ?? "")
  if (out.status !== 0 || match === null) {
    throw new Error(`bun --version answered status ${String(out.status)}: ${JSON.stringify(out.stdout ?? "")}`)
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

const CHILD_BUN = childBunVersion()
const [major, minor, patch] = CHILD_BUN
/** Bun 1.4.3 stopped dropping an unrouted console.log's tail on a full non-blocking pipe (hh 27071). */
const DROPS_UNROUTED = major < 1 || (major === 1 && (minor < 4 || (minor === 4 && patch < 3)))

describe("a CLI's output reaches a slow reader whole (hh 27071)", () => {
  // The control records the historical drop on an older Bun; supported Bun >=1.4.3 must deliver every byte.
  // Running this suite on 1.3.14 also proves the fast-reader EPIPE regression below remains detectable.
  test(`control: an unrouted console.log on a slow pipe, on Bun ${CHILD_BUN.join(".")} (hh 27071)`, async () => {
    const run = await slowPipeRoundTrip(["bun", fixture("unrouted-log")])
    expect(run.exitCode).toBe(4)
    expect(
      run.bytes < FULL,
      `Bun ${CHILD_BUN.join(".")} delivered ${String(run.bytes)} of ${String(FULL)} unrouted bytes; expected ` +
        (DROPS_UNROUTED ? "a dropped tail before Bun 1.4.3" : "every byte from Bun 1.4.3 (the drop is back)"),
    ).toBe(DROPS_UNROUTED)
  })

  test("routed through the streams, every byte and late write arrives with the command's exit code", async () => {
    for (const late of [false, true]) {
      const run = await slowPipeRoundTrip(["bun", fixture("routed-log"), ...(late ? ["--late"] : [])])
      expect({ bytes: run.bytes, exitCode: run.exitCode }).toEqual({ bytes: FULL + (late ? 6 : 0), exitCode: 4 })
      if (late) expect(run.stdout.toString().endsWith("later\n")).toBe(true)
    }
  })

  test.each([0, 1])(
    "a reader that closes early after %ss fails the command by name with its arguments, exit 1, and no stack",
    async (delaySeconds) => {
      const run = await slowPipeRoundTrip(["bun", fixture("routed-log"), "--json"], {
        closeAfterBytes: 100,
        delaySeconds,
      })
      expect(run.exitCode, `reader delay ${String(delaySeconds)}s`).toBe(1)
      expect(run.stderr).toContain("fixture: stdout refused the output of `fixture --json`: EPIPE")
      expect(run.stderr).not.toMatch(/^\s+at /mu)
    },
  )
})
