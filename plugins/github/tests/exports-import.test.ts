/**
 * @failure Node's consumer probe cannot import @bearly/github: its only export
 *          is ./package.json, and Node 22+ refuses that specifier without
 *          `with { type: "json" }`. verify-publishable uses bare `import(s)`,
 *          so Release fails here and never publishes sibling packages
 *          (bearly run 38979712814 blocked @bearly/pacing@0.3.0).
 * @level l1
 * @consumer beorn/verify-publishable import-development probe
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, test } from "vitest"

const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url))
const MANIFEST = JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8")) as {
  exports?: Record<string, string>
}

// Same eval the hosted verifier runs (verify-publishable src/probes.ts importScript).
const IMPORT_SCRIPT = `const specifiers = JSON.parse(process.argv[1]);
for (const specifier of specifiers) {
  try {
    await import(specifier);
  } catch (error) {
    console.error(specifier + ": " + (error?.stack ?? String(error)));
    process.exit(1);
  }
}`

function exportedFileUrls(): string[] {
  const exportsMap = MANIFEST.exports
  if (exportsMap === undefined || Object.keys(exportsMap).length === 0) {
    throw new Error("plugins/github must declare a nonempty explicit exports map")
  }
  return Object.values(exportsMap).map((target) => {
    if (typeof target !== "string" || !target.startsWith("./")) {
      throw new Error(`unsupported export target: ${JSON.stringify(target)}`)
    }
    return pathToFileURL(join(PLUGIN_DIR, target)).href
  })
}

describe("@bearly/github exports", () => {
  test("every exported target is importable by Node without JSON import attributes", () => {
    const specifiers = exportedFileUrls()
    expect(specifiers.length).toBeGreaterThan(0)
    const result = spawnSync("node", ["--input-type=module", "--eval", IMPORT_SCRIPT, JSON.stringify(specifiers)], {
      encoding: "utf8",
      cwd: PLUGIN_DIR,
    })
    expect(result.status, result.stderr || result.stdout).toBe(0)
  })
})
