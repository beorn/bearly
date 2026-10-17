/**
 * @failure A runtime-specific child argv layout prevents the package's root and
 *          sealed deep-path contracts from being exercised in CI.
 * @level l3: real child import of the package's declared surface
 * @consumer Node and Bun package consumers
 */
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url))
const IMPORT_SCRIPT = `import { readFileSync } from "node:fs";
const name = JSON.parse(readFileSync(0, "utf8"));
const root = await import(name);
if (Object.keys(root).length !== 0) throw new Error("package root unexpectedly exports values");
let sealed = false;
try {
  readFileSync("index.mjs", "utf8");
  await import(name + "/index.mjs");
} catch (error) {
  // The real file exists and the root already loaded it; only resolution refusal seals this path.
  if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED" && error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  sealed = true;
}
if (!sealed) throw new Error("package deep path unexpectedly imported");
`

describe("@bearly/github exports", () => {
  test("the root imports without values or output and deep paths stay sealed", () => {
    const result = spawnSync("node", ["--input-type=module", "--eval", IMPORT_SCRIPT], {
      encoding: "utf8",
      cwd: PLUGIN_DIR,
      input: JSON.stringify("@bearly/github"),
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(result.stdout).toBe("")
  })
})
