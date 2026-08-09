/**
 * The one byte→character conversion every byte-speaking backend goes through.
 * Getting this wrong doesn't fail — it silently moves an edit a few characters,
 * so the mapper refuses positions it cannot map exactly.
 */
import { describe, test, expect } from "vitest"
import { createByteToCharMapper, offsetToLineCol, lineColToOffset } from "../../tools/lib/core/text-utils"

describe("createByteToCharMapper", () => {
  test("ascii content maps byte offsets to identical character offsets", () => {
    const map = createByteToCharMapper("hello world")
    expect(map(0)).toBe(0)
    expect(map(6)).toBe(6)
    expect(map(11)).toBe(11)
  })

  test("2-, 3- and 4-byte characters each shift the mapping by their own width", () => {
    // é = 2 bytes, ★ = 3 bytes, 🎉 = 4 bytes (and 2 UTF-16 code units)
    const content = "é★🎉x"
    const map = createByteToCharMapper(content)
    expect(map(0)).toBe(0) // é
    expect(map(2)).toBe(1) // ★
    expect(map(5)).toBe(2) // 🎉
    expect(map(9)).toBe(4) // x — the emoji occupied two string positions
    expect(map(10)).toBe(5) // end of content
    expect(content.slice(map(9), map(10))).toBe("x")
  })

  test("a position inside a multi-byte character is refused, not rounded", () => {
    const map = createByteToCharMapper("★ star")
    expect(() => map(1)).toThrow(/multi-byte/)
    expect(() => map(2)).toThrow(/multi-byte/)
  })

  test("a position past the end is refused", () => {
    const map = createByteToCharMapper("abc")
    expect(map(3)).toBe(3)
    expect(() => map(4)).toThrow(/outside the file/)
    expect(() => map(-1)).toThrow(/outside the file/)
  })

  test("maps every boundary of a realistic mixed line", () => {
    const content = "Intro — a line — with · dots\nsee @tent/@dev owns it\n"
    const map = createByteToCharMapper(content)
    const charOffset = content.indexOf("@tent/@dev")
    const byteOffset = Buffer.byteLength(content.slice(0, charOffset), "utf-8")
    expect(byteOffset).not.toBe(charOffset) // the units genuinely diverge here
    expect(map(byteOffset)).toBe(charOffset)
  })
})

describe("offsetToLineCol / lineColToOffset — character offsets", () => {
  test("round-trip through line/column preserves the character offset", () => {
    const content = "★ head\nsecond line\nthird\n"
    const offset = content.indexOf("second")
    const [line, col] = offsetToLineCol(content, offset)
    expect(lineColToOffset(content, line, col)).toBe(offset)
  })
})
