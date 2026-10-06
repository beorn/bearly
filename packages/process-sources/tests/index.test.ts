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

  /**
   * @failure FD exhaustion compares the hard limit or turns a zero/unlimited soft limit into missing evidence.
   * @level l0
   * @consumer hab-sysmon Linux FD usage
   * @testonly none
   */
  it("reads only the open-file soft limit, preserving zero and unlimited", () => {
    for (const [soft, hard, expected] of [
      ["1024", "524288", 1024],
      ["0", "1024", 0],
      ["unlimited", "unlimited", "unlimited"],
      ["9007199254740991", "unlimited", Number.MAX_SAFE_INTEGER],
    ] as const) {
      const contents = `Limit                     Soft Limit           Hard Limit           Units\nMax processes             8192                 8192                 processes\nMax open files            ${soft}              ${hard}              files\n`
      expect(sources.parseProcessOpenFileLimit(contents)).toBe(expected)
    }
  })

  /**
   * @failure Missing or malformed limits falsely look like healthy FD headroom.
   * @level l0
   * @consumer hab-sysmon Linux FD availability
   * @testonly none
   */
  it("keeps absent, ambiguous and invalid open-file limits unavailable", () => {
    for (const contents of [
      "",
      "Max processes 1024 524288 processes\n",
      "Max open files nope 524288 files\n",
      "Max open files -1 524288 files\n",
      "Max open files 1.5 524288 files\n",
      "Max open files 1e3 524288 files\n",
      "Max open files Infinity unlimited files\n",
      "Max open files 9007199254740992 unlimited files\n",
      "Max open files 1024\n",
      "Max open files 1024 524288 bytes\n",
      "Max open files 1024 524288 files\nMax open files 4096 524288 files\n",
    ]) {
      expect(sources.parseProcessOpenFileLimit(contents)).toBeUndefined()
    }
  })
})
