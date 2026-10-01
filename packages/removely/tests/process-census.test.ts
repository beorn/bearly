import { describe, expect, test } from "vitest"
import { darwinProcessCwds } from "../src/process-census.ts"

describe("darwinProcessCwds", () => {
  test("parses a uid-scoped lsof census into pid/cwd rows", () => {
    const uid = process.getuid?.()
    const rows = darwinProcessCwds((asked) => {
      expect(asked).toBe(uid)
      return { status: 0, stdout: "p10\0\nn/work/10\0p12\0\nn/work/12\0", stderr: "" }
    })

    expect(rows).toEqual([
      { pid: 10, cwd: "/work/10" },
      { pid: 12, cwd: "/work/12" },
    ])
  })

  test.each([
    ["an lsof failure", { status: 1, stdout: "", stderr: "lsof: no permission" }, "lsof: no permission"],
    [
      "an lsof that could not run",
      { status: null, stdout: "", stderr: "", error: "lsof is unavailable" },
      "lsof is unavailable",
    ],
    ["a non-absolute cwd", { status: 0, stdout: "p10\0\nnwork\0", stderr: "" }, "non-absolute cwd for pid 10"],
    ["an empty answer", { status: 0, stdout: "", stderr: "" }, "no process cwds"],
  ])("throws on %s, never a partial row set", (_case, result, message) => {
    expect(() => darwinProcessCwds(() => result)).toThrow(message)
  })

  test("fails loud when the bounded observation population is exceeded", () => {
    const stdout = "p10\0\nn/work/10\0p11\0\nn/work/11\0p12\0\nn/work/12\0"
    expect(() => darwinProcessCwds(() => ({ status: 0, stdout, stderr: "" }), 2)).toThrow("process count exceeds 2")
  })
})
