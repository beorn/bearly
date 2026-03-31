/**
 * Hot-reload — watch source files and re-exec on change.
 *
 * Only activates when running from source (import.meta.url is a file:// URL
 * pointing into the repo). Bundled builds (server.ts) skip this.
 */

import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, watch, type FSWatcher } from "node:fs"
import { dirname, resolve } from "node:path"
import { spawn } from "node:child_process"
import { createLogger } from "loggily"

const log = createLogger("tribe:reload")

export type HotReloadOpts = {
  /** The calling module's import.meta.url */
  importMetaUrl: string
  /** Additional files to watch (beyond the auto-detected ones) */
  extraFiles?: string[]
  /** Additional directories to watch */
  extraDirs?: string[]
  /** Callback before re-exec (cleanup) */
  onReload?: () => void
  /** Debounce ms (default: 500) */
  debounceMs?: number
}

/**
 * Watch source files for changes and re-exec the current process.
 * Returns a cleanup function that stops watching.
 * Returns null if not running from source (bundled).
 */
export function setupHotReload(opts: HotReloadOpts): (() => void) | null {
  const { importMetaUrl, extraFiles = [], extraDirs = [], onReload, debounceMs = 500 } = opts

  // Only activate for source runs (file:// URLs in the repo)
  if (!importMetaUrl.startsWith("file://")) return null
  const scriptPath = new URL(importMetaUrl).pathname
  const sourceDir = dirname(scriptPath)
  const libTribeDir = resolve(sourceDir, "lib/tribe")

  // Detect all source files to hash
  function getSourceFiles(): string[] {
    const files = [scriptPath, ...extraFiles]
    const dirs = [libTribeDir, ...extraDirs]
    for (const dir of dirs) {
      try {
        if (existsSync(dir)) {
          for (const f of readdirSync(dir)) {
            if (f.endsWith(".ts")) files.push(resolve(dir, f))
          }
        }
      } catch { /* best effort */ }
    }
    return files.sort()
  }

  function computeHash(): string {
    const hash = createHash("md5")
    for (const f of getSourceFiles()) {
      try { hash.update(readFileSync(f)) } catch { /* missing */ }
    }
    return hash.digest("hex").slice(0, 12)
  }

  let currentHash = computeHash()
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  const watchers: FSWatcher[] = []

  function onChange(filename: string | null): void {
    if (filename && !filename.endsWith(".ts") && !filename.endsWith(".tsx")) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      const newHash = computeHash()
      if (newHash === currentHash) return
      log.info?.(`Source changed (${currentHash} → ${newHash}), re-execing`)
      currentHash = newHash
      onReload?.()
      // Re-exec with same args
      const child = spawn(process.execPath, process.argv.slice(1), {
        stdio: "inherit",
        env: process.env,
      })
      child.on("exit", (code) => process.exit(code ?? 0))
    }, debounceMs)
  }

  // Watch source directory and lib/tribe
  try {
    watchers.push(watch(sourceDir, { persistent: false }, (_e, f) => onChange(f)))
  } catch { /* dir missing */ }

  if (existsSync(libTribeDir)) {
    try {
      watchers.push(watch(libTribeDir, { persistent: false }, (_e, f) => onChange(f)))
    } catch { /* dir missing */ }
  }

  for (const dir of extraDirs) {
    if (existsSync(dir)) {
      try {
        watchers.push(watch(dir, { persistent: false }, (_e, f) => onChange(f)))
      } catch { /* dir missing */ }
    }
  }

  log.info?.(`Watching ${getSourceFiles().length} source files for hot-reload`)

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    for (const w of watchers) w.close()
  }
}
