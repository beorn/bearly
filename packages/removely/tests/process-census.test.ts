import { describe, expect, test } from "vitest"
import { censusProcessCwds, type ProcessCwdCensusDeps } from "../src/index.ts"

function linuxDeps(overrides: Partial<ProcessCwdCensusDeps> = {}): ProcessCwdCensusDeps {
  return {
    platform: "linux",
    uid: 501,
    maxProcesses: 8,
    listLinuxPids: () => [10, 11, 12],
    linuxPidUid: (pid) => (pid === 11 ? 777 : 501),
    linuxPidCwd: (pid) => `/work/${pid}`,
    runDarwinLsof: () => ({ status: 1, stdout: "", stderr: "unused" }),
    ...overrides,
  }
}

describe("censusProcessCwds", () => {
  test("returns typed pid/cwd rows for only the current uid", () => {
    expect(censusProcessCwds(linuxDeps())).toEqual({
      available: true,
      rows: [
        { pid: 10, cwd: "/work/10" },
        { pid: 12, cwd: "/work/12" },
      ],
      reason: "Linux /proc census",
    })
  })

  test("returns unavailable, never a partial row set, when an in-scope cwd is unreadable", () => {
    const result = censusProcessCwds(
      linuxDeps({
        linuxPidCwd: (pid) => {
          if (pid === 12) throw Object.assign(new Error("permission denied"), { code: "EACCES" })
          return `/work/${pid}`
        },
      }),
    )

    expect(result).toEqual({
      available: false,
      reason: "cannot read /proc/12/cwd: EACCES",
    })
    expect("rows" in result).toBe(false)
  })

  test("fails loud when the bounded observation population is exceeded", () => {
    expect(
      censusProcessCwds(
        linuxDeps({
          maxProcesses: 2,
        }),
      ),
    ).toEqual({
      available: false,
      reason: "process count exceeds 2",
    })
  })

  test("parses a uid-scoped macOS lsof census into the same rows", () => {
    const result = censusProcessCwds(
      linuxDeps({
        platform: "darwin",
        runDarwinLsof: (uid) => {
          expect(uid).toBe(501)
          return {
            status: 0,
            stdout: "p10\0\nn/work/10\0p12\0\nn/work/12\0",
            stderr: "",
          }
        },
      }),
    )

    expect(result).toEqual({
      available: true,
      rows: [
        { pid: 10, cwd: "/work/10" },
        { pid: 12, cwd: "/work/12" },
      ],
      reason: "macOS lsof census",
    })
  })
})
