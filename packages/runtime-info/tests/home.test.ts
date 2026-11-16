/**
 * @failure Configured homes and tilde paths escape the caller's environment (#25237).
 * @level l0
 * @consumer Ag configuration and neutral Inhab/RSS callers.
 * @testonly none
 */
import { homedir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { expandHomePath, nativeHome, userHome } from "../src/home.ts"
import { linuxUserRuntimeDir } from "../src/index.ts"

describe("linux uid runtime directory", () => {
  test.each([
    [0, "/run/user/0"],
    [-0, "/run/user/0"],
    [3001, "/run/user/3001"],
    [Number.MAX_SAFE_INTEGER, `/run/user/${Number.MAX_SAFE_INTEGER}`],
  ])("formats uid %p as %s", (uid, expected) => {
    expect(linuxUserRuntimeDir(uid)).toBe(expected)
  })

  test.each([
    ["negative", -1, "number -1"],
    ["fractional", 3001.5, "number 3001.5"],
    ["NaN", Number.NaN, "number NaN"],
    ["infinite", Number.POSITIVE_INFINITY, "number Infinity"],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1, `number ${Number.MAX_SAFE_INTEGER + 1}`],
    ["string", "3001" as unknown as number, 'string "3001"'],
    ["undefined", undefined as unknown as number, "undefined"],
  ])("rejects a %s uid and names it", (_label, uid, described) => {
    expect(() => linuxUserRuntimeDir(uid)).toThrow(RangeError)
    expect(() => linuxUserRuntimeDir(uid)).toThrow(/linuxUserRuntimeDir: uid must be a safe non-negative integer/)
    expect(() => linuxUserRuntimeDir(uid)).toThrow(`got ${described}`)
  })

  test.each([
    ["bigint", 1n, "bigint 1n"],
    ["cycling object", cyclicUid(), "object (unserializable)"],
    ["object holding a bigint", { uid: 1n }, "object (unserializable)"],
    [
      "object whose toJSON throws",
      {
        toJSON: () => {
          throw new Error("toJSON boom")
        },
      },
      "object (unserializable)",
    ],
    ["plain object", { uid: 1 }, 'object {"uid":1}'],
    ["null", null, "null"],
    ["symbol", Symbol("uid"), "symbol Symbol(uid)"],
    ["function", () => 1, "function"],
  ])("reports a %s uid as a RangeError, never a TypeError from the message", (_label, uid, described) => {
    let thrown: unknown
    try {
      linuxUserRuntimeDir(uid as unknown as number)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RangeError)
    expect((thrown as RangeError).message).toBe(
      `linuxUserRuntimeDir: uid must be a safe non-negative integer, got ${described}`,
    )
  })
})

function cyclicUid(): Record<string, unknown> {
  const uid: Record<string, unknown> = {}
  uid.self = uid
  return uid
}

describe("caller home policy", () => {
  test.each(["linux", "darwin", "win32"] as const)("selects and normalizes the %s home", (platform) => {
    const key = platform === "win32" ? "USERPROFILE" : "HOME"
    const other = platform === "win32" ? "HOME" : "USERPROFILE"
    expect(userHome({ [key]: " /configured ", [other]: "/other" }, platform)).toBe("/configured")
    for (const env of [{ [key]: " " }, { [other]: "/other" }, {}]) {
      expect(userHome(env, platform)).toBe(homedir())
    }
    const env = { [key]: "/configured", [other]: "/other" }
    expect(expandHomePath("~", env, platform)).toBe("/configured")
    expect(expandHomePath("~/a/../b", env, platform)).toBe(join("/configured", "b"))
    expect(expandHomePath("~someone/a", env, platform)).toBe("~someone/a")
    expect(expandHomePath("plain/a", env, platform)).toBe("plain/a")
  })

  test("observes native home independently and reads configured defaults at call time", () => {
    const key = process.platform === "win32" ? "USERPROFILE" : "HOME"
    const original = process.env[key]
    try {
      process.env[key] = "/first-home"
      expect(userHome()).toBe("/first-home")
      process.env[key] = "/second-home"
      expect(expandHomePath("~/file")).toBe(join("/second-home", "file"))
      expect(nativeHome()).toBe(homedir())
    } finally {
      if (original === undefined) delete process.env[key]
      else process.env[key] = original
    }
  })
})
