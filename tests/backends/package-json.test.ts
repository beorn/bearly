/**
 * package-json.test.ts - Tests for the package-json backend.
 *
 * Covers two capabilities:
 *   1. Path-field rename (pre-existing): main/module/types/exports/... updated when a file moves.
 *   2. Dependency-NAME rename (20187): rename a package identifier (@km/code → @ag/code) across
 *      dependencies/devDependencies/peerDependencies/optionalDependencies/overrides keys plus the
 *      declaring package's own `name` field — WITHOUT touching path fields or prose.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import type { Edit } from "../../tools/lib/core/types"
import {
  findDependencyNameEdits,
  createDependencyRenameEditset,
  findPackageJsonEdits,
} from "../../tools/lib/backends/package-json"

/**
 * Apply edits to a file's content (offset-descending) and return the new content.
 * Mirrors core/apply.ts applyEditset's splice logic so we validate offsets against the real file.
 */
function applyEditsToFile(absPath: string, edits: Edit[]): string {
  let content = readFileSync(absPath, "utf-8")
  const sorted = [...edits].sort((a, b) => b.offset - a.offset)
  for (const edit of sorted) {
    content = content.slice(0, edit.offset) + edit.replacement + content.slice(edit.offset + edit.length)
  }
  return content
}

describe("package-json backend — dependency-NAME rename (20187)", () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pkgjson-deprename-"))

    // Declaring package: owns the name being renamed + has a path field that must NOT change.
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "@km/code",
          version: "1.0.0",
          description: "the @km/code package",
          main: "./src/index.ts",
          exports: { ".": "./src/index.ts" },
          dependencies: { zod: "^3.0.0" },
        },
        null,
        2,
      ),
    )

    // Consumer package: references the renamed package as a dependency key in several maps.
    mkdirSync(join(dir, "consumer"), { recursive: true })
    writeFileSync(
      join(dir, "consumer/package.json"),
      JSON.stringify(
        {
          name: "@km/consumer",
          dependencies: { "@km/code": "workspace:*", zod: "^3.0.0" },
          devDependencies: { "@km/code": "1.0.0" },
          peerDependencies: { "@km/code": "*" },
          optionalDependencies: { other: "^1.0.0" },
        },
        null,
        2,
      ),
    )

    // Unrelated package: must be left completely untouched.
    mkdirSync(join(dir, "unrelated"), { recursive: true })
    writeFileSync(
      join(dir, "unrelated/package.json"),
      JSON.stringify({ name: "@km/other", dependencies: { zod: "^3.0.0" } }, null, 2),
    )
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("finds the declaring package's name value", () => {
    const edits = findDependencyNameEdits("@km/code", "@ag/code", dir)
    const nameEdit = edits.find((e) => e.file === "package.json")
    expect(nameEdit).toBeDefined()
    expect(nameEdit!.replacement).toBe('"@ag/code"')

    // The edit must land on the `name` value, not on the description prose.
    const content = readFileSync(join(dir, "package.json"), "utf-8")
    expect(content.slice(nameEdit!.offset, nameEdit!.offset + nameEdit!.length)).toBe('"@km/code"')
  })

  test("finds dependency keys across dependencies/devDependencies/peerDependencies", () => {
    const edits = findDependencyNameEdits("@km/code", "@ag/code", dir)
    const consumerEdits = edits.filter((e) => e.file === "consumer/package.json")
    // 3 maps name @km/code as a key (deps, devDeps, peerDeps).
    expect(consumerEdits.length).toBe(3)
    for (const e of consumerEdits) {
      expect(e.replacement).toBe('"@ag/code"')
    }
  })

  test("does NOT touch path fields, prose, or unrelated packages", () => {
    const edits = findDependencyNameEdits("@km/code", "@ag/code", dir)

    // No edit on the unrelated package.
    expect(edits.some((e) => e.file.startsWith("unrelated/"))).toBe(false)

    // Apply to the declaring package and confirm path fields + description survive untouched
    // (description still mentions @km/code as prose — name renames don't touch prose).
    const applied = applyEditsToFile(
      join(dir, "package.json"),
      edits.filter((e) => e.file === "package.json"),
    )
    const pkg = JSON.parse(applied)
    expect(pkg.name).toBe("@ag/code")
    expect(pkg.main).toBe("./src/index.ts")
    expect(pkg.exports["."]).toBe("./src/index.ts")
    expect(pkg.description).toBe("the @km/code package")
  })

  test("applied consumer edits rename the dependency keys, preserving versions", () => {
    const edits = findDependencyNameEdits("@km/code", "@ag/code", dir)
    const applied = applyEditsToFile(
      join(dir, "consumer/package.json"),
      edits.filter((e) => e.file === "consumer/package.json"),
    )
    const pkg = JSON.parse(applied)
    expect(pkg.dependencies["@ag/code"]).toBe("workspace:*")
    expect(pkg.dependencies["@km/code"]).toBeUndefined()
    expect(pkg.dependencies.zod).toBe("^3.0.0")
    expect(pkg.devDependencies["@ag/code"]).toBe("1.0.0")
    expect(pkg.peerDependencies["@ag/code"]).toBe("*")
  })

  test("returns no edits when the name is absent", () => {
    const edits = findDependencyNameEdits("@km/does-not-exist", "@ag/nope", dir)
    expect(edits.length).toBe(0)
  })

  test("createDependencyRenameEditset produces an applyable editset", () => {
    const editset = createDependencyRenameEditset("@km/code", "@ag/code", dir)
    expect(editset.operation).toBe("rename")
    expect(editset.from).toBe("@km/code")
    expect(editset.to).toBe("@ag/code")
    expect(editset.edits.length).toBe(4) // 1 name + 3 dep keys
    expect(editset.refs.length).toBe(editset.edits.length)
    // Every ref carries a checksum for drift protection.
    for (const ref of editset.refs) {
      expect(ref.checksum.length).toBeGreaterThan(0)
    }
  })
})

describe("package-json backend — path rename is unaffected by dep-name rename", () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pkgjson-pathrename-"))
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@km/code", main: "./src/old.ts", types: "./src/old.ts" }, null, 2),
    )
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("findPackageJsonEdits still renames path fields", () => {
    const edits = findPackageJsonEdits("src/old.ts", "src/new.ts", dir)
    expect(edits.length).toBeGreaterThan(0)
    expect(edits.every((e) => e.file === "package.json")).toBe(true)
  })
})
