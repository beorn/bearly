import { describe, expect, test } from "vitest"
import { buildContext } from "../src/lib/context-files"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("buildContext multi-file", () => {
  test("concatenates multiple contextFiles in argv order, separated by ---", async () => {
    const dir = mkdtempSync(join(tmpdir(), "buildContext-"))
    const a = join(dir, "a.txt")
    const b = join(dir, "b.txt")
    const c = join(dir, "c.txt")
    writeFileSync(a, "FIRST")
    writeFileSync(b, "SECOND")
    writeFileSync(c, "THIRD")

    try {
      const result = await buildContext("topic", {
        contextFiles: [a, b, c],
        withHistory: false,
      })
      expect(result).toBeDefined()
      // All three contents present
      expect(result).toContain("FIRST")
      expect(result).toContain("SECOND")
      expect(result).toContain("THIRD")
      // In argv order
      expect(result!.indexOf("FIRST")).toBeLessThan(result!.indexOf("SECOND"))
      expect(result!.indexOf("SECOND")).toBeLessThan(result!.indexOf("THIRD"))
      // Separated by the canonical divider
      expect(result).toMatch(/FIRST\n\n---\n\nSECOND/)
      expect(result).toMatch(/SECOND\n\n---\n\nTHIRD/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("contextArg + multiple contextFiles all included", async () => {
    const dir = mkdtempSync(join(tmpdir(), "buildContext-"))
    const a = join(dir, "a.txt")
    const b = join(dir, "b.txt")
    writeFileSync(a, "FILE_A")
    writeFileSync(b, "FILE_B")

    try {
      const result = await buildContext("topic", {
        contextArg: "INLINE_TEXT",
        contextFiles: [a, b],
        withHistory: false,
      })
      expect(result).toBeDefined()
      expect(result).toContain("INLINE_TEXT")
      expect(result).toContain("FILE_A")
      expect(result).toContain("FILE_B")
      // contextArg comes first, then files
      expect(result!.indexOf("INLINE_TEXT")).toBeLessThan(result!.indexOf("FILE_A"))
      expect(result!.indexOf("FILE_A")).toBeLessThan(result!.indexOf("FILE_B"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("legacy contextFile still works (single string)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "buildContext-"))
    const a = join(dir, "a.txt")
    writeFileSync(a, "LEGACY")

    try {
      const result = await buildContext("topic", {
        contextFile: a,
        withHistory: false,
      })
      expect(result).toBe("LEGACY")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("legacy contextFile + new contextFiles concatenate (legacy first)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "buildContext-"))
    const legacy = join(dir, "legacy.txt")
    const a = join(dir, "a.txt")
    const b = join(dir, "b.txt")
    writeFileSync(legacy, "LEGACY_FILE")
    writeFileSync(a, "NEW_A")
    writeFileSync(b, "NEW_B")

    try {
      const result = await buildContext("topic", {
        contextFile: legacy,
        contextFiles: [a, b],
        withHistory: false,
      })
      expect(result).toBeDefined()
      expect(result!.indexOf("LEGACY_FILE")).toBeLessThan(result!.indexOf("NEW_A"))
      expect(result!.indexOf("NEW_A")).toBeLessThan(result!.indexOf("NEW_B"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("empty contextFiles returns undefined when nothing else provided", async () => {
    const result = await buildContext("topic", {
      contextFiles: [],
      withHistory: false,
    })
    expect(result).toBeUndefined()
  })

  test("no options at all returns undefined", async () => {
    const result = await buildContext("topic", { withHistory: false })
    expect(result).toBeUndefined()
  })
})
