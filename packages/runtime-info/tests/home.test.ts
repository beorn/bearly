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
