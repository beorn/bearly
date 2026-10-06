/**
 * @failure Process callers lose empty argv or confuse listed FDs, acquired links and unavailable reads.
 * @level l0
 * @consumer Removely path-holder census, ag-backends native correlation, hab-sysmon context
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import * as sources from "../src/index.ts"

describe("pure process-source interpretation", () => {
  it("preserves argv fields while removing only the final terminator", () => {
    for (const [input, expected] of [
      ["", []],
      ["exe\0\0 spaced \0", ["exe", "", " spaced "]],
      ["exe\0\0", ["exe", ""]],
      ["unterminated", ["unterminated"]],
    ] as const) {
      expect(sources.parseProcessArgv(input)).toEqual(expected)
    }
  })

  it("keeps acquired link kinds distinct from malformed link evidence", () => {
    for (const [input, expected] of [
      ["/tmp/file (deleted)", "path"],
      ["socket:[123]", "socket"],
      ["pipe:[4]", "pipe"],
      ["anon_inode:[eventpoll]", "anonymous"],
      ["socket:[bad]", "malformed"],
      ["", "malformed"],
    ] as const) {
      expect(sources.classifyProcessLink(input)).toBe(expected)
    }
  })

  it("preserves named error evidence without turning unexpected errors into absence", () => {
    for (const [code, reason] of [
      ["ENOENT", "vanished"],
      ["ESRCH", "vanished"],
      ["EACCES", "denied"],
      ["EPERM", "denied"],
      ["ENOSYS", "unsupported"],
      ["EOPNOTSUPP", "unsupported"],
      ["EIO", "unexpected"],
    ] as const) {
      expect(sources.classifyProcessSourceError(Object.assign(new Error("actual detail"), { code }))).toEqual({
        reason,
        code,
        detail: "actual detail",
      })
    }
    expect(sources.classifyProcessSourceError("opaque failure")).toEqual({
      reason: "unexpected",
      detail: "opaque failure",
    })
  })

  it("counts a successful listing separately from acquired and unreadable targets", () => {
    expect(sources.summarizeProcessFileDescriptors([])).toEqual({ entryCount: 0, targets: [], unreadableCount: 0 })
    const links = [{ name: "0", target: "/dev/null" }, { name: "1" }, { name: "2", target: "malformed" }] as const
    expect(sources.summarizeProcessFileDescriptors(links)).toEqual({
      entryCount: 3,
      targets: [
        { name: "0", target: "/dev/null", kind: "path" },
        { name: "2", target: "malformed", kind: "malformed" },
      ],
      unreadableCount: 1,
    })
    expect(links).toEqual([{ name: "0", target: "/dev/null" }, { name: "1" }, { name: "2", target: "malformed" }])
  })
})
