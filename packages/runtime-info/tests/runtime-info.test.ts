import { describe, expect, test } from "vitest"
import {
  composeRuntimeInfo,
  formatRuntimeInfo,
  formatRuntimeInfoLine,
  readGitState,
  type RuntimeInfoDeps,
} from "../src/index.ts"

describe("@bearly/runtime-info", () => {
  test("formats semver+sha and keeps dirty visible", () => {
    expect(formatRuntimeInfo({ version: "1.2.3", sha: "abc1234", dirty: false })).toBe("1.2.3+abc1234")
    expect(formatRuntimeInfo({ version: "1.2.3", sha: "abc1234", dirty: true })).toBe("1.2.3+abc1234-dirty")
    expect(formatRuntimeInfoLine("inhab", { version: "1.2.3", sha: "abc1234", dirty: true })).toBe(
      "inhab 1.2.3+abc1234-dirty",
    )
  })

  test("git unavailable degrades to an explicit unknown SHA", () => {
    expect(formatRuntimeInfo({ version: "1.2.3", sha: null, dirty: false })).toBe("1.2.3+unknown")
  })

  test("reads injected git state without requiring a live checkout", () => {
    const deps: RuntimeInfoDeps = {
      cwd: "/repo",
      sh: (cmd, args) => {
        if (cmd === "git" && args.includes("rev-parse")) return { status: 0, stdout: "deadbee\n" }
        if (cmd === "git" && args.includes("status")) return { status: 0, stdout: " M tools/inhab/cli.ts\n" }
        return { status: 1, stdout: "" }
      },
    }
    expect(readGitState(deps)).toEqual({ sha: "deadbee", dirty: true })
  })

  test("composes runtime info from an explicit version and injected deps", () => {
    const deps: RuntimeInfoDeps = { cwd: "/repo", sh: () => ({ status: 1, stdout: "" }) }
    expect(composeRuntimeInfo("0.0.0", deps)).toEqual({ version: "0.0.0", sha: null, dirty: false })
  })
})
