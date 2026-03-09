import { execSync } from "child_process"

/**
 * Find files matching a glob pattern using ripgrep.
 *
 * @param glob - Glob pattern to match (e.g. "**\/*.md", "**\/package.json")
 * @param searchPath - Directory to search in
 * @param excludeNodeModules - Filter out paths containing node_modules (default: false)
 */
export function findFiles(glob: string, searchPath: string, excludeNodeModules = false): string[] {
  try {
    const output = execSync(`rg --files --glob "${glob}" "${searchPath}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
    let files = output.trim().split("\n").filter(Boolean)
    if (excludeNodeModules) {
      files = files.filter((f) => !f.includes("node_modules"))
    }
    return files
  } catch {
    return []
  }
}
