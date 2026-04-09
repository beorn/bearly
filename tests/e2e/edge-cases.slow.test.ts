/**
 * E2E test for the batch refactor tool.
 *
 * Tests all edge cases discovered during batch refactoring by:
 * 1. Running symbols.find on the fixture
 * 2. Verifying ALL expected symbols are found (bugs 1-3)
 * 3. Running conflict detection (bug 4)
 * 4. Applying rename to a temp copy
 * 5. Verifying TypeScript compiles after rename
 */

import { describe, test, expect, beforeAll } from "vitest"
import { spawnSync } from "child_process"
import { cpSync, mkdtempSync, readFileSync } from "fs"
import { join, dirname } from "path"
import { tmpdir } from "os"

const PLUGIN_ROOT = join(dirname(import.meta.filename), "../..")
const FIXTURES_ROOT = join(PLUGIN_ROOT, "tests/fixtures/edge-cases")

// Helper to run refactor CLI
function runRefactor(args: string, cwd = PLUGIN_ROOT): string {
  const result = spawnSync("bun", ["tools/refactor.ts", ...args.split(" ")], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, FORCE_COLOR: "0" },
  })
  if (result.error) throw result.error
  return result.stdout
}

describe("E2E: Edge Cases", () => {
  // Symbols that should NOT appear as symbol names (bug 2 - destructuring patterns)
  const INVALID_SYMBOL_NAMES = ["{ widgetDir, widgetName }", "{ widgetPath, widgetRoot }", "{ widgetPath }"]

  describe("symbols.find", () => {
    let symbols: Array<{
      symbolKey: string
      name: string
      kind: string
      file: string
      line: number
      refCount: number
    }>

    beforeAll(() => {
      const output = runRefactor(`symbols.find --pattern widget --tsconfig ${FIXTURES_ROOT}/tsconfig.json`)
      symbols = JSON.parse(output) as typeof symbols
    })

    test("finds expected number of widget symbols", () => {
      // Should find many widget-related symbols
      expect(symbols.length).toBeGreaterThan(10)
    })

    test("Bug 1: finds local variables inside functions", () => {
      // widgetRoot defined inside processWidget()
      const localWidgetRoots = symbols.filter((s) => s.name === "widgetRoot" && s.file.includes("all-cases.ts"))
      expect(localWidgetRoots.length).toBeGreaterThanOrEqual(1)

      // widgetDir defined inside nested()
      const nestedWidgetDirs = symbols.filter((s) => s.name === "widgetDir" && s.file.includes("all-cases.ts"))
      expect(nestedWidgetDirs.length).toBeGreaterThanOrEqual(1)
    })

    test("Bug 2: finds individual destructured identifiers", () => {
      // Should find widgetDir from: const { widgetDir, widgetName } = config
      expect(symbols.some((s) => s.name === "widgetDir")).toBe(true)
      expect(symbols.some((s) => s.name === "widgetName")).toBe(true)

      // Should find array destructuring elements
      expect(symbols.some((s) => s.name === "firstWidgetItem")).toBe(true)
      expect(symbols.some((s) => s.name === "secondWidgetItem")).toBe(true)
    })

    test("Bug 2: does NOT include destructuring pattern text as symbol name", () => {
      for (const invalid of INVALID_SYMBOL_NAMES) {
        expect(symbols.some((s) => s.name === invalid)).toBe(false)
      }

      // No symbol names should contain { or ,
      expect(symbols.some((s) => s.name.includes("{"))).toBe(false)
      expect(symbols.some((s) => s.name.includes(","))).toBe(false)
    })

    test("Bug 3: finds arrow function parameter destructuring", () => {
      // Should find multiple widgetPath symbols from destructured parameters:
      // - processContext arrow function
      // - handleContext function
      // - asyncProcess async arrow function
      // - forEach callback
      // Note: Destructured parameters are classified as "variable" (the binding element)
      const widgetPathSymbols = symbols.filter((s) => s.name === "widgetPath")
      // Should have at least 4 widgetPath symbols (from the 4 functions above)
      expect(widgetPathSymbols.length).toBeGreaterThanOrEqual(4)
    })

    test("finds interface properties", () => {
      expect(symbols.some((s) => s.kind === "property")).toBe(true)
    })

    test("finds types and interfaces", () => {
      expect(symbols.some((s) => s.name === "WidgetConfig")).toBe(true)
      expect(symbols.some((s) => s.name === "WidgetState")).toBe(true)
      expect(symbols.some((s) => s.name === "WidgetManager")).toBe(true)
    })

    test("finds class members", () => {
      expect(symbols.some((s) => s.name === "WidgetService")).toBe(true)
      expect(symbols.some((s) => s.name === "getWidgetPath")).toBe(true)
    })
  })

  describe("rename.batch --check-conflicts", () => {
    let conflictReport: {
      conflicts: Array<{
        from: string
        to: string
        existingSymbol: string
        suggestion: string
      }>
      safe: Array<{
        from: string
        to: string
      }>
    }

    beforeAll(() => {
      const output = runRefactor(
        `rename.batch --pattern '/widget/i' --replace gadget --check-conflicts --tsconfig ${FIXTURES_ROOT}/tsconfig.json`,
      )
      conflictReport = JSON.parse(output) as typeof conflictReport
    })

    test("Bug 4: detects conflicts when target name already exists", () => {
      // widgetStorage → gadgetStorage should conflict because gadgetStorage exists
      const storageConflict = conflictReport.conflicts.find((c) => c.from === "widgetStorage")
      expect(storageConflict).toBeDefined()
      expect(storageConflict?.to).toBe("gadgetStorage")
    })

    test("Bug 4: identifies safe renames", () => {
      // Symbols without existing gadget* counterparts should be safe
      expect(conflictReport.safe.length).toBeGreaterThan(0)

      // topLevelWidget → topLevelGadget should be safe (no topLevelGadget exists)
      expect(conflictReport.safe.some((s) => s.from === "topLevelWidget")).toBe(true)
    })

    test("conflict report includes existing symbol location", () => {
      const conflict = conflictReport.conflicts[0]
      if (conflict) {
        expect(conflict.existingSymbol).toBeDefined()
        expect(conflict.existingSymbol).toContain("all-cases.ts")
      }
    })
  })

  describe("full rename workflow", () => {
    let tempDir: string

    beforeAll(() => {
      // Copy fixture to temp directory
      tempDir = mkdtempSync(join(tmpdir(), "refactor-test-"))
      cpSync(FIXTURES_ROOT, tempDir, { recursive: true })
    })

    test("creates valid editset", () => {
      const editsetPath = join(tempDir, "editset.json")

      // Create editset, skipping conflicts
      runRefactor(
        `rename.batch --pattern '/widget/i' --replace gadget --skip widgetStorage,widgetDatabase,widgetLocal --output ${editsetPath} --tsconfig ${tempDir}/tsconfig.json`,
      )

      const editset = JSON.parse(readFileSync(editsetPath, "utf-8")) as {
        refs: unknown[]
        edits: unknown[]
        from: string
        to: string
      }
      expect(editset.refs.length).toBeGreaterThan(0)
      expect(editset.edits.length).toBeGreaterThan(0)
      expect(editset.from).toBe("widget")
      expect(editset.to).toBe("gadget")
    })

    test("applies editset and TypeScript compiles", () => {
      const editsetPath = join(tempDir, "editset.json")

      // Apply the editset
      const applyOutput = runRefactor(`editset.apply ${editsetPath}`)
      const result = JSON.parse(applyOutput) as { applied: number }
      expect(result.applied).toBeGreaterThan(0)

      // Verify TypeScript compiles
      const tscResult = spawnSync("bunx", ["tsc", "--noEmit"], {
        cwd: tempDir,
        encoding: "utf-8",
      })

      // If tsc fails, show the error
      if (tscResult.status !== 0) {
        console.error("tsc stderr:", tscResult.stderr)
        console.error("tsc stdout:", tscResult.stdout)
      }

      expect(tscResult.status).toBe(0)
    })

    test("all safe widget* symbols are renamed to gadget*", () => {
      const content = readFileSync(join(tempDir, "src/all-cases.ts"), "utf-8")

      // These should be renamed
      expect(content).toContain("topLevelGadget")
      expect(content).toContain("processGadget")
      expect(content).toContain("gadgetRoot")
      expect(content).toContain("gadgetPath")
      expect(content).toContain("GadgetConfig")
      expect(content).toContain("GadgetState")
      expect(content).toContain("GadgetManager")
      expect(content).toContain("GadgetService")

      // Conflicting symbols should NOT be renamed
      expect(content).toContain("widgetStorage") // kept due to conflict
      expect(content).toContain("widgetDatabase") // kept due to conflict
      expect(content).toContain("widgetLocal") // kept due to conflict
    })
  })
})
