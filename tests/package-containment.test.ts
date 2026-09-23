/**
 * @failure A bearly package that reaches another package's files by a relative
 *          path works inside this monorepo and breaks in a standalone install;
 *          package.json checks never see it, because the edge lives in source.
 * @level l1
 * @consumer every package under packages/
 */
import { describe, expect, test } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGES = fileURLToPath(new URL("../packages/", import.meta.url))
const SOURCE = /\.(?:[cm]?[jt]sx?)$/u
const SKIP = new Set(["node_modules", "dist"])
// import … from "./x", export … from "./x", import "./x", import("./x"), require("./x")
const RELATIVE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']*)["']/gu

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return []
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return SOURCE.test(name) ? [path] : []
  })
}

/** Every relative import in a package's files whose target resolves outside that package's directory. */
function escapingImports(packageDir: string, files: readonly string[]): string[] {
  const root = packageDir.endsWith(sep) ? packageDir : packageDir + sep
  return files.flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(RELATIVE)]
      .map((match) => match[1] ?? "")
      .filter((specifier) => !(resolve(dirname(file), specifier) + sep).startsWith(root))
      .map((specifier) => `${relative(PACKAGES, file)} imports "${specifier}"`),
  )
}

describe("each package under packages/ stays inside its own directory", () => {
  const packages = readdirSync(PACKAGES).filter((name) => statSync(join(PACKAGES, name)).isDirectory())

  test("the population is the directory listing, and it is not empty", () => {
    // A listing that came back empty or missed a known package would pass every check below vacuously.
    expect(packages.length).toBeGreaterThan(0)
    expect(packages).toContain("watchdog")
  })

  test.each(packages)("packages/%s: no relative import resolves outside the package", (name) => {
    const dir = join(PACKAGES, name)
    const files = sourceFiles(dir)
    expect(files.length, `packages/${name} has no source files to check`).toBeGreaterThan(0)
    expect(escapingImports(dir, files)).toEqual([])
  })
})
