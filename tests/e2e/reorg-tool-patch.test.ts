/**
 * reorg-tool-patch.test.ts — end-to-end proof for the v0.7 reorg tool patch (km bead 20187).
 *
 * Exercises the three gating capabilities in ONE flow against a realistic mini-repo:
 *   1. dependency-NAME rename  (@km/code → @ag/code across package.json)
 *   2. bead-safe exclusion     (@km/**\/*.md is never rewritten)
 *   3. directory/prefix move    (apps/silvercode → apps/ag, with imports rewritten)
 *
 * The load-bearing assertion is bead-safety: the @km bead markdown must be BYTE-IDENTICAL after
 * all three operations run.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { createDependencyRenameEditset } from "../../tools/lib/backends/package-json"
import { createPatternReplaceProposal } from "../../tools/lib/backends/ripgrep"
import { createDirectoryMoveProposal, applyFileRenames } from "../../tools/lib/core/file-ops"
import { applyEditset } from "../../tools/lib/core/apply"

/** Minimal shape for asserting on parsed package.json (km's ts-reset types JSON.parse as unknown). */
type PkgJson = { name?: string; dependencies?: Record<string, string> }

let dir: string
let logSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

  dir = mkdtempSync(join(tmpdir(), "reorg-e2e-"))
  // Declaring package.
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "@km/code", version: "1.0.0", main: "./apps/silvercode/index.ts" }, null, 2),
  )
  // Code under the prefix to be moved.
  mkdirSync(join(dir, "apps/silvercode/sub"), { recursive: true })
  writeFileSync(join(dir, "apps/silvercode/index.ts"), "// belongs to @km/code\nexport const x = 1\n")
  writeFileSync(join(dir, "apps/silvercode/sub/util.ts"), 'import { x } from "../index"\nexport const y = x\n')
  // A consumer package outside the moved prefix.
  mkdirSync(join(dir, "apps/consumer"), { recursive: true })
  writeFileSync(
    join(dir, "apps/consumer/package.json"),
    JSON.stringify({ name: "@km/consumer", dependencies: { "@km/code": "workspace:*" } }, null, 2),
  )
  writeFileSync(join(dir, "apps/consumer/use.ts"), 'import { x } from "../silvercode/index"\nexport const z = x\n')
  // A bead node that mentions @km/code AND a wikilink — must survive untouched.
  mkdirSync(join(dir, "@km"), { recursive: true })
  writeFileSync(join(dir, "@km/bead.md"), "# Bead\n\nTracks @km/code. See [[apps/silvercode/index]].\n")
})

afterEach(() => {
  logSpy.mockRestore()
  errorSpy.mockRestore()
  rmSync(dir, { recursive: true, force: true })
})

describe("v0.7 reorg tool patch — e2e (20187)", () => {
  test("dep-rename + bead-safe exclusion + dir-move compose, bead stays byte-identical", async () => {
    const cwd0 = process.cwd()
    try {
      process.chdir(dir)
      const beadBefore = readFileSync("@km/bead.md", "utf-8")

      // ---- DRY-RUN PROOFS (proposals) ----

      // (1) dep-name rename targets package.json name + consumer dep key, never the bead.
      const depEditset = createDependencyRenameEditset("@km/code", "@ag/code", dir)
      expect(depEditset.edits.some((e) => e.file === "package.json")).toBe(true)
      expect(depEditset.edits.some((e) => e.file === "apps/consumer/package.json")).toBe(true)
      expect(depEditset.edits.some((e) => e.file.endsWith(".md"))).toBe(false)

      // (2) bead-safe text replacement excludes @km/**/*.md.
      const textEditset = createPatternReplaceProposal("@km/code", "@ag/code", ["**/*.ts", "!@km/**/*.md"])
      expect(textEditset.refs.some((r) => r.file.includes("@km/"))).toBe(false)
      expect(textEditset.refs.some((r) => r.file.endsWith("index.ts"))).toBe(true)

      // (3) dir-move produces move ops + import rewrites; no link edit touches the bead.
      const moveEditset = await createDirectoryMoveProposal("apps/silvercode", "apps/ag", "**/*", dir, {
        excludeGlobs: ["@km/**/*.md"],
      })
      expect(moveEditset.fileOps.length).toBe(2)
      expect(moveEditset.importEdits.some((e) => e.file.endsWith("use.ts"))).toBe(true)
      expect(moveEditset.importEdits.some((e) => e.file.includes("@km/"))).toBe(false)

      // ---- APPLY (phased, like a real reorg: each phase is recomputed against the live tree) ----
      applyEditset(textEditset, false) // rewrites the code comment (changes index.ts)
      applyEditset(depEditset, false) // rewrites package.json names/deps
      // Recompute the move against the post-text tree so its checksums are fresh.
      const moveToApply = await createDirectoryMoveProposal("apps/silvercode", "apps/ag", "**/*", dir, {
        excludeGlobs: ["@km/**/*.md"],
      })
      const moveResult = applyFileRenames(moveToApply, false, dir)
      expect(moveResult.applied).toBe(2)
      expect(moveResult.linkEditsApplied).toBeGreaterThanOrEqual(1)

      // ---- FINAL STATE ----
      // dep-name rename landed.
      expect((JSON.parse(readFileSync("package.json", "utf-8")) as PkgJson).name).toBe("@ag/code")
      const consumerPkg = JSON.parse(readFileSync("apps/consumer/package.json", "utf-8")) as PkgJson
      expect(consumerPkg.dependencies?.["@ag/code"]).toBe("workspace:*")
      expect(consumerPkg.dependencies?.["@km/code"]).toBeUndefined()

      // text replacement rewrote the code comment (it moved with the file).
      expect(existsSync("apps/ag/index.ts")).toBe(true)
      expect(existsSync("apps/silvercode/index.ts")).toBe(false)
      expect(readFileSync("apps/ag/index.ts", "utf-8")).toContain("// belongs to @ag/code")

      // directory move rewrote the external importer.
      expect(readFileSync("apps/consumer/use.ts", "utf-8")).toContain("../ag/index")

      // BEAD SAFETY: the @km bead is byte-identical — none of the three operations touched it.
      expect(readFileSync("@km/bead.md", "utf-8")).toBe(beadBefore)
    } finally {
      process.chdir(cwd0)
    }
  })
})
