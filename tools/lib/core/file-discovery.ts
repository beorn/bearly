import { spawnSync } from "child_process"

/**
 * Find files matching a glob pattern using ripgrep.
 *
 * @param glob - Glob pattern to match (e.g. "**\/*.md", "**\/package.json")
 * @param searchPath - Directory to search in
 * @param excludeNodeModules - Filter out paths containing node_modules (default: false)
 */
export function findFiles(glob: string, searchPath: string, excludeNodeModules = false): string[] {
  const res = spawnSync("rg", ["--files", "--glob", glob, searchPath], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  })
  // A missing rg binary must FAIL LOUD, not read as "no files": the silent []
  // here made every discovery-based backend test pass vacuously on machines
  // with rg and fail inscrutably on machines without it (2026-07-02 bearly CI
  // red — GitHub runners ship no ripgrep). rg exit 1 = no matches (a real,
  // empty result); anything else is an environment/usage error.
  if (res.error) {
    throw new Error(`findFiles requires ripgrep (rg) in PATH: ${res.error.message}`)
  }
  if (res.status !== 0 && res.status !== 1) {
    throw new Error(`rg --files failed (exit ${res.status}): ${res.stderr?.slice(0, 300)}`)
  }
  let files = (res.stdout ?? "").trim().split("\n").filter(Boolean)
  if (excludeNodeModules) {
    files = files.filter((f) => !f.includes("node_modules"))
  }
  return files
}
