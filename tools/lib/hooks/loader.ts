/**
 * Listener loader — scans ~/.claude/hooks.d/ (user) and <project>/.claude/hooks.d/
 * (project) for listener modules.
 *
 * A listener file exports a default (or named `listener`) object matching the
 * `Listener` shape. Modules that fail to load, or export the wrong shape, are
 * skipped with a stderr warning — one malformed listener must not break hook
 * dispatch for the rest of the tree.
 *
 * Why `~/.claude/hooks.d/`? Hooks are part of Claude Code's coordination
 * surface, so they live under Claude Code's config root alongside `settings.json`
 * and `hooks/`. Project-local listeners belong next to the project's own
 * `.claude/` so they travel with the repo.
 */

import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Listener } from "./types.ts"

export interface LoadOptions {
  userDir?: string
  projectDir?: string
  projectPath?: string
}

function isListenerShape(value: unknown): value is Listener {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.name === "string" && typeof v.handle === "function"
}

function debugEnabled(): boolean {
  return Boolean(process.env.BEARLY_HOOKS_DEBUG || process.env.KM_HOOKS_DEBUG)
}

async function loadDir(dir: string): Promise<Listener[]> {
  if (!existsSync(dir)) return []
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const listeners: Listener[] = []
  for (const entry of entries) {
    if (entry.startsWith(".")) continue
    if (!entry.endsWith(".ts") && !entry.endsWith(".mts") && !entry.endsWith(".js") && !entry.endsWith(".mjs")) {
      continue
    }
    const filePath = join(dir, entry)
    try {
      const mod = await import(pathToFileURL(filePath).href)
      const candidate = mod.default ?? mod.listener
      if (isListenerShape(candidate)) {
        listeners.push(candidate)
      } else if (debugEnabled()) {
        process.stderr.write(`[bearly hooks] ${filePath}: no default export with { name, handle }\n`)
      }
    } catch (err) {
      process.stderr.write(
        `[bearly hooks] failed to load ${filePath}: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }
  return listeners
}

export async function loadListeners(opts: LoadOptions = {}): Promise<Listener[]> {
  const userDir = opts.userDir ?? join(homedir(), ".claude", "hooks.d")
  const projectDir =
    opts.projectDir ?? (opts.projectPath ? join(opts.projectPath, ".claude", "hooks.d") : undefined)
  const [userListeners, projectListeners] = await Promise.all([
    loadDir(userDir),
    projectDir ? loadDir(projectDir) : Promise.resolve([]),
  ])
  return [...userListeners, ...projectListeners]
}
