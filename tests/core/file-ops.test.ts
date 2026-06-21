/**
 * file-ops.test.ts - Tests for batch file rename operations
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest"
import fs from "fs"
import path from "path"

// Silence console.error from library logging (tests use spies when they need output)
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
})
import {
  applyReplacement,
  findFilesToRename,
  checkFileConflicts,
  createFileRenameProposal,
  verifyFileEditset,
  applyFileRenames,
  findFilesToMovePrefix,
  createDirectoryMoveProposal,
  dedupeEdits,
} from "../../tools/lib/core/file-ops"
import type { Edit } from "../../tools/lib/core/types"

// Test fixture directory
const FIXTURE_DIR = path.join(import.meta.dirname, "../fixtures/file-ops-test")

function setupFixtures() {
  // Clean up and recreate fixture directory
  if (fs.existsSync(FIXTURE_DIR)) {
    fs.rmSync(FIXTURE_DIR, { recursive: true })
  }
  fs.mkdirSync(FIXTURE_DIR, { recursive: true })

  // Create test files
  fs.writeFileSync(path.join(FIXTURE_DIR, "widget.ts"), 'export const widget = "test"')
  fs.writeFileSync(path.join(FIXTURE_DIR, "widget-loader.ts"), 'import { widget } from "./widget"')
  fs.writeFileSync(path.join(FIXTURE_DIR, "WidgetConfig.ts"), "export interface WidgetConfig {}")
  fs.mkdirSync(path.join(FIXTURE_DIR, "testing"), { recursive: true })
  fs.writeFileSync(path.join(FIXTURE_DIR, "testing/fake-widget.ts"), "export class FakeWidget {}")

  // Create a file that would conflict (gadget.ts already exists)
  fs.writeFileSync(path.join(FIXTURE_DIR, "gadget.ts"), 'export const gadget = "existing"')
}

function cleanupFixtures() {
  if (fs.existsSync(FIXTURE_DIR)) {
    fs.rmSync(FIXTURE_DIR, { recursive: true })
  }
}

// Pure function tests - no fixtures needed
describe("applyReplacement", () => {
  test("replaces lowercase", () => {
    expect(applyReplacement("widget-loader.ts", "widget", "gadget")).toBe("gadget-loader.ts")
  })

  test("preserves PascalCase", () => {
    expect(applyReplacement("WidgetConfig.ts", "widget", "gadget")).toBe("GadgetConfig.ts")
  })

  test("preserves UPPERCASE", () => {
    expect(applyReplacement("WIDGET_ROOT.ts", "widget", "gadget")).toBe("GADGET_ROOT.ts")
  })

  test("handles multiple occurrences", () => {
    expect(applyReplacement("widget-widget.ts", "widget", "gadget")).toBe("gadget-gadget.ts")
  })

  test("handles mixed case in same file", () => {
    expect(applyReplacement("WidgetLoader-widget.ts", "widget", "gadget")).toBe("GadgetLoader-gadget.ts")
  })
})

// Read-only tests share fixtures (setup once)
describe("read-only file operations", () => {
  beforeAll(setupFixtures)
  afterAll(cleanupFixtures)

  describe("findFilesToRename", () => {
    test("finds files matching pattern", async () => {
      const ops = await findFilesToRename("widget", "gadget", "**/*.ts", FIXTURE_DIR)

      expect(ops.length).toBe(4)
      const paths = ops.map((op) => op.oldPath)
      expect(paths).toContain("widget.ts")
      expect(paths).toContain("widget-loader.ts")
      expect(paths).toContain("WidgetConfig.ts")
      expect(paths).toContain("testing/fake-widget.ts")
    })

    test("computes correct new paths", async () => {
      const ops = await findFilesToRename("widget", "gadget", "**/*.ts", FIXTURE_DIR)

      const widgetOp = ops.find((op) => op.oldPath === "widget.ts")
      expect(widgetOp?.newPath).toBe("gadget.ts")

      const loaderOp = ops.find((op) => op.oldPath === "widget-loader.ts")
      expect(loaderOp?.newPath).toBe("gadget-loader.ts")

      const configOp = ops.find((op) => op.oldPath === "WidgetConfig.ts")
      expect(configOp?.newPath).toBe("GadgetConfig.ts")
    })

    test("respects glob filter", async () => {
      const ops = await findFilesToRename("widget", "gadget", "*.ts", FIXTURE_DIR)

      // Should only find files in root, not in subdirectories
      expect(ops.length).toBe(3)
      const paths = ops.map((op) => op.oldPath)
      expect(paths).not.toContain("testing/fake-widget.ts")
    })
  })

  describe("checkFileConflicts", () => {
    test("detects target exists conflict", async () => {
      const ops = await findFilesToRename("widget", "gadget", "**/*.ts", FIXTURE_DIR)
      const report = checkFileConflicts(ops, FIXTURE_DIR)

      // widget.ts -> gadget.ts should conflict because gadget.ts exists
      expect(report.conflicts.length).toBeGreaterThan(0)
      const widgetConflict = report.conflicts.find((c) => c.oldPath === "widget.ts")
      expect(widgetConflict).toBeDefined()
      expect(widgetConflict?.reason).toBe("target_exists")
    })

    test("identifies safe renames", async () => {
      const ops = await findFilesToRename("widget", "gadget", "**/*.ts", FIXTURE_DIR)
      const report = checkFileConflicts(ops, FIXTURE_DIR)

      // widget-loader.ts -> gadget-loader.ts should be safe
      const loaderOp = report.safe.find((op) => op.oldPath === "widget-loader.ts")
      expect(loaderOp).toBeDefined()
    })
  })

  describe("createFileRenameProposal", () => {
    test("creates editset with file ops", async () => {
      const editset = await createFileRenameProposal("widget", "gadget", "**/*.ts", FIXTURE_DIR)

      expect(editset.operation).toBe("file-rename")
      expect(editset.pattern).toBe("widget")
      expect(editset.replacement).toBe("gadget")
      // Should exclude conflicting widget.ts -> gadget.ts
      expect(editset.fileOps.length).toBe(3)
    })

    test("includes checksums", async () => {
      const editset = await createFileRenameProposal("widget", "gadget", "**/*.ts", FIXTURE_DIR)

      for (const op of editset.fileOps) {
        expect(op.checksum).toBeDefined()
        expect(op.checksum.length).toBe(16) // SHA256 truncated to 16 chars
      }
    })
  })

  describe("verifyFileEditset", () => {
    test("valid when files unchanged", async () => {
      const editset = await createFileRenameProposal("widget", "gadget", "**/*.ts", FIXTURE_DIR)
      const result = verifyFileEditset(editset, FIXTURE_DIR)

      expect(result.valid).toBe(true)
      expect(result.drifted.length).toBe(0)
    })
  })
})

// Destructive tests need fresh fixtures each time
describe("verifyFileEditset mutations", () => {
  beforeEach(setupFixtures)
  afterEach(cleanupFixtures)

  test("detects file changes", async () => {
    const editset = await createFileRenameProposal("widget", "gadget", "**/*.ts", FIXTURE_DIR)

    // Modify a file after creating the editset
    fs.writeFileSync(path.join(FIXTURE_DIR, "widget-loader.ts"), "// modified content")

    const result = verifyFileEditset(editset, FIXTURE_DIR)
    expect(result.valid).toBe(false)
    expect(result.drifted.some((d) => d.includes("widget-loader.ts"))).toBe(true)
  })
})

// Directory / prefix move (20187)
const MOVE_DIR = path.join(import.meta.dirname, "../fixtures/dir-move-test")

function setupMoveFixtures() {
  if (fs.existsSync(MOVE_DIR)) fs.rmSync(MOVE_DIR, { recursive: true })
  fs.mkdirSync(path.join(MOVE_DIR, "pkgA"), { recursive: true })
  fs.mkdirSync(path.join(MOVE_DIR, "pkgB"), { recursive: true })
  fs.mkdirSync(path.join(MOVE_DIR, "shared"), { recursive: true })
  fs.writeFileSync(
    path.join(MOVE_DIR, "pkgA/index.ts"),
    'import { shared } from "../shared/shared"\nimport { u } from "./util"\nexport const a = shared + u\n',
  )
  fs.writeFileSync(path.join(MOVE_DIR, "pkgA/util.ts"), "export const u = 2\n")
  fs.writeFileSync(path.join(MOVE_DIR, "shared/shared.ts"), "export const shared = 3\n")
  // A consumer OUTSIDE the moved dir importing from it — its import must be rewritten.
  fs.writeFileSync(path.join(MOVE_DIR, "pkgB/uses.ts"), 'import { a } from "../pkgA/index"\n')
}

function cleanupMoveFixtures() {
  if (fs.existsSync(MOVE_DIR)) fs.rmSync(MOVE_DIR, { recursive: true })
}

describe("findFilesToMovePrefix", () => {
  beforeAll(setupMoveFixtures)
  afterAll(cleanupMoveFixtures)

  test("maps every file under the old prefix to the new prefix", async () => {
    const ops = await findFilesToMovePrefix("pkgA", "pkgC", "**/*.ts", MOVE_DIR)
    const byOld = Object.fromEntries(ops.map((o) => [o.oldPath, o.newPath]))
    expect(ops.length).toBe(2)
    expect(byOld["pkgA/index.ts"]).toBe("pkgC/index.ts")
    expect(byOld["pkgA/util.ts"]).toBe("pkgC/util.ts")
    // Move ops are tagged "move", not "rename".
    expect(ops.every((o) => o.type === "move")).toBe(true)
  })

  test("does not match files outside the prefix", async () => {
    const ops = await findFilesToMovePrefix("pkgA", "pkgC", "**/*.ts", MOVE_DIR)
    expect(ops.some((o) => o.oldPath.startsWith("pkgB/"))).toBe(false)
  })

  test("respects the file-type glob", async () => {
    const ops = await findFilesToMovePrefix("pkgA", "pkgC", "**/*.md", MOVE_DIR)
    expect(ops.length).toBe(0)
  })
})

describe("createDirectoryMoveProposal", () => {
  beforeAll(setupMoveFixtures)
  afterAll(cleanupMoveFixtures)

  test("produces move ops plus rewritten imports for external consumers", async () => {
    const editset = await createDirectoryMoveProposal("pkgA", "pkgC", "**/*.ts", MOVE_DIR)
    expect(editset.operation).toBe("file-rename")
    expect(editset.fileOps.length).toBe(2)
    expect(editset.fileOps.every((op) => op.type === "move")).toBe(true)

    // The consumer in pkgB importing "../pkgA/index" must get an import edit.
    const consumerEdit = editset.importEdits.find((e) => e.file.endsWith("uses.ts"))
    expect(consumerEdit).toBeDefined()
    expect(consumerEdit!.replacement).toContain("pkgC")
  })

  test("link edits are deduped (no two edits at the same file+offset)", async () => {
    const editset = await createDirectoryMoveProposal("pkgA", "pkgC", "**/*.ts", MOVE_DIR)
    const keys = editset.importEdits.map((e) => `${e.file}|${e.offset}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test("rewrites imports using the importer and target post-move paths", async () => {
    const editset = await createDirectoryMoveProposal("pkgA", "packages/pkgC", "**/*.ts", MOVE_DIR)

    const editsForMovedIndex = editset.importEdits.filter((e) => e.file.endsWith("pkgA/index.ts"))
    const replacements = editsForMovedIndex.map((e) => e.replacement)
    expect(replacements).toContain('"../../shared/shared"')
    expect(replacements).not.toContain('"../packages/pkgC/util"')

    const utilImportEdit = editsForMovedIndex.find((e) => e.replacement.includes("util"))
    expect(utilImportEdit).toBeUndefined()
  })
})

describe("applyFileRenames applies link edits (20187)", () => {
  beforeEach(setupMoveFixtures)
  afterEach(cleanupMoveFixtures)

  test("moves files AND rewrites the external importer", async () => {
    const editset = await createDirectoryMoveProposal("pkgA", "pkgC", "**/*.ts", MOVE_DIR)
    const result = applyFileRenames(editset, false, MOVE_DIR)

    expect(result.applied).toBe(2) // two files moved
    expect(result.linkEditsApplied).toBeGreaterThanOrEqual(1)

    // Files moved to the new prefix.
    expect(fs.existsSync(path.join(MOVE_DIR, "pkgC/index.ts"))).toBe(true)
    expect(fs.existsSync(path.join(MOVE_DIR, "pkgA/index.ts"))).toBe(false)

    // The external importer's import path was rewritten — the move is not silently broken.
    const uses = fs.readFileSync(path.join(MOVE_DIR, "pkgB/uses.ts"), "utf-8")
    expect(uses).toContain("pkgC/index")
    expect(uses).not.toContain("pkgA/index")
  })

  test("dry run counts link edits without writing", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const editset = await createDirectoryMoveProposal("pkgA", "pkgC", "**/*.ts", MOVE_DIR)
    const result = applyFileRenames(editset, true, MOVE_DIR)

    expect(result.applied).toBe(2)
    expect(result.linkEditsApplied).toBeGreaterThanOrEqual(1)
    // Nothing actually changed on disk.
    expect(fs.existsSync(path.join(MOVE_DIR, "pkgA/index.ts"))).toBe(true)
    expect(fs.readFileSync(path.join(MOVE_DIR, "pkgB/uses.ts"), "utf-8")).toContain("pkgA/index")
    logSpy.mockRestore()
  })
})

describe("dedupeEdits", () => {
  test("removes exact-duplicate edits", () => {
    const edits: Edit[] = [
      { file: "a.ts", offset: 10, length: 3, replacement: "new" },
      { file: "a.ts", offset: 10, length: 3, replacement: "new" },
      { file: "a.ts", offset: 20, length: 2, replacement: "x" },
    ]
    const deduped = dedupeEdits(edits)
    expect(deduped.length).toBe(2)
  })

  test("drops overlapping/conflicting edits at the same offset (keeps one)", () => {
    const errorSpy2 = vi.spyOn(console, "error").mockImplementation(() => {})
    const edits: Edit[] = [
      { file: "a.ts", offset: 10, length: 5, replacement: "first" },
      { file: "a.ts", offset: 10, length: 5, replacement: "second" }, // same span, different text
    ]
    const deduped = dedupeEdits(edits)
    expect(deduped.length).toBe(1)
    errorSpy2.mockRestore()
  })

  test("keeps non-overlapping adjacent edits", () => {
    const edits: Edit[] = [
      { file: "a.ts", offset: 0, length: 5, replacement: "aaaaa" },
      { file: "a.ts", offset: 5, length: 5, replacement: "bbbbb" },
    ]
    expect(dedupeEdits(edits).length).toBe(2)
  })
})

describe("applyFileRenames", () => {
  beforeEach(setupFixtures)
  afterEach(cleanupFixtures)

  test("dry run does not rename files", async () => {
    // Spy on console.log since dry run logs what it would do
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    const editset = await createFileRenameProposal("widget", "gadget", "**/*.ts", FIXTURE_DIR)
    const result = applyFileRenames(editset, true, FIXTURE_DIR)

    expect(result.applied).toBe(3)
    expect(result.skipped).toBe(0)
    expect(logSpy).toHaveBeenCalled()

    // Files should still have old names
    expect(fs.existsSync(path.join(FIXTURE_DIR, "widget-loader.ts"))).toBe(true)
    expect(fs.existsSync(path.join(FIXTURE_DIR, "gadget-loader.ts"))).toBe(false)

    logSpy.mockRestore()
  })

  test("applies renames", async () => {
    const editset = await createFileRenameProposal("widget", "gadget", "**/*.ts", FIXTURE_DIR)
    const result = applyFileRenames(editset, false, FIXTURE_DIR)

    expect(result.applied).toBe(3)
    expect(result.errors.length).toBe(0)

    // Files should have new names
    expect(fs.existsSync(path.join(FIXTURE_DIR, "widget-loader.ts"))).toBe(false)
    expect(fs.existsSync(path.join(FIXTURE_DIR, "gadget-loader.ts"))).toBe(true)
    expect(fs.existsSync(path.join(FIXTURE_DIR, "GadgetConfig.ts"))).toBe(true)
    expect(fs.existsSync(path.join(FIXTURE_DIR, "testing/fake-gadget.ts"))).toBe(true)
  })

  test("skips drifted files", async () => {
    const editset = await createFileRenameProposal("widget", "gadget", "**/*.ts", FIXTURE_DIR)

    // Modify a file
    fs.writeFileSync(path.join(FIXTURE_DIR, "widget-loader.ts"), "// modified")

    const result = applyFileRenames(editset, false, FIXTURE_DIR)

    expect(result.skipped).toBe(1)
    expect(result.errors.some((e) => e.includes("widget-loader.ts"))).toBe(true)

    // Modified file should not be renamed
    expect(fs.existsSync(path.join(FIXTURE_DIR, "widget-loader.ts"))).toBe(true)
  })
})
