/**
 * One error for every missing provider credential.
 *
 * `X_API_KEY not set` names the check that fired, not the requirement. It reads
 * as "your key is wrong", but by far the commonest cause is that the process
 * never loaded an env file at all — a different fix, in a different place. In a
 * direnv-managed repo that is the default state of every git worktree: `.env`
 * is git-ignored and untracked, so `git worktree add` does not carry it across,
 * and a worktree whose `.envrc` has not been `direnv allow`ed loads nothing
 * whatsoever. Both states report zero keys, and neither is a bad credential.
 *
 * So discriminate before reporting. If no `*_API_KEY` is set at all, no env
 * file reached this process — say that, and name the file that would supply it.
 * If others are set, the env file did load and this key really is absent from
 * it or misspelled.
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { gitEnvironmentWithoutRootOverrides } from "removely"

/** Git answers for `cwd`, never for the repository a leaked GIT_DIR or GIT_WORK_TREE names (hh 26003). */
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnvironmentWithoutRootOverrides(),
    stdio: ["ignore", "pipe", "ignore"],
  }).trim()
}

/**
 * Resolve current seat identity for loud error reporting.
 *
 * Takes identity from explicit launch environment (SEAT, TENT_SEAT, or TRIBE_NAME).
 * Identity is never inferred from cwd, worktree path, or decoded tokens.
 */
export function currentSeat(): string {
  if (process.env.SEAT) return process.env.SEAT
  if (process.env.TENT_SEAT) return process.env.TENT_SEAT
  if (process.env.TRIBE_NAME) return process.env.TRIBE_NAME
  return "seat: none declared"
}

/**
 * Provider credentials managed by @bearly/llm.
 * Only these keys are loaded from declared env files into process.env.
 */
export const PROVIDER_KEY_NAMES: ReadonlySet<string> = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "XAI_API_KEY",
  "PERPLEXITY_API_KEY",
  "OPENROUTER_API_KEY",
])

/**
 * Parse standard KEY=VALUE lines from an .env file without external dependencies.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const rawLine of content.split("\n")) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    const key = match[1]!
    let val = match[2]!.trim()
    const doubleQuoted = val.match(/^"((?:\\.|[^"\\])*)"(?:\s+#.*)?$/)
    const singleQuoted = val.match(/^'([^']*)'(?:\s+#.*)?$/)
    if (doubleQuoted) {
      val = doubleQuoted[1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\")
    } else if (singleQuoted) {
      val = singleQuoted[1]!
    } else {
      const commentIdx = val.indexOf(" #")
      if (commentIdx !== -1) {
        val = val.slice(0, commentIdx).trim()
      }
    }
    result[key] = val
  }
  return result
}

/**
 * The `.env` paths a direnv-managed checkout or habitat would load, most local first:
 * the cwd, the enclosing working tree, the main checkout it belongs to, and
 * any enclosing habitat container root.
 *
 * Two rev-parse traps, both hit for real while building this:
 *
 * - `--show-toplevel` stops at a linked worktree, so it can never name the
 *   main checkout that actually holds the untracked `.env`. `--git-common-dir`
 *   is the only form that crosses back.
 * - `--git-common-dir` inside a submodule resolves to the SUBMODULE's gitdir
 *   under `<main>/.git/modules/…`, whose parent is a path no checkout ever
 *   occupies. Climb out via `--show-superproject-working-tree` first.
 */
export function envFileCandidates(cwd: string = process.cwd()): string[] {
  if (process.env.HAB_ENV_FILE) {
    return [process.env.HAB_ENV_FILE]
  }
  const candidates = [join(cwd, ".env")]
  const add = (dir: string) => {
    const path = join(dir, ".env")
    if (!candidates.includes(path)) candidates.push(path)
  }
  try {
    // Climb out of any submodule nesting; bounded so a pathological repo cannot
    // spin here. 8 levels is far past anything real.
    let root = cwd
    for (let depth = 0; depth < 8; depth++) {
      const superproject = git(["rev-parse", "--show-superproject-working-tree"], root)
      if (!superproject) break
      root = superproject
    }
    const toplevel = git(["rev-parse", "--show-toplevel"], root)
    add(toplevel)
    const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], root)
    const commonParent = dirname(commonDir)
    add(commonParent)

    // In habitat layouts (e.g. /hh with /hh/dev as CODE checkout and /hh/dev-wt* as seat worktrees):
    // The superproject rev-parse cannot see /hh because dev is gitignored in the /hh state repo.
    // Climb up from root, toplevel, and commonParent to find the enclosing habitat container root.
    const searchRoots = [root, toplevel, commonParent]
    for (const start of searchRoots) {
      let cur = dirname(resolve(start))
      while (cur && cur !== dirname(cur)) {
        if (existsSync(join(cur, ".env")) || existsSync(join(cur, "main.hab")) || existsSync(join(cur, "hh.hab.tsx"))) {
          add(cur)
          break
        }
        cur = dirname(cur)
      }
    }

    if (process.env.HH_CONTAINER_ROOT) {
      const container = resolve(process.env.HH_CONTAINER_ROOT)
      const resolvedCwd = resolve(cwd)
      const resolvedRoot = resolve(root)
      if (resolvedCwd.startsWith(container) || resolvedRoot.startsWith(container)) {
        add(container)
      }
    }
  } catch {
    // No git on PATH, or not a repo. cwd is then the only path we can honestly
    // name, and we still name it. Non-fatal by construction: this runs only
    // while building an error that is about to be thrown anyway.
  }
  return candidates
}

/**
 * Return the primary declared habitat .env file path (found or expected).
 */
export function declaredHabitatEnvFile(cwd: string = process.cwd()): string {
  if (process.env.HAB_ENV_FILE) return process.env.HAB_ENV_FILE
  const candidates = envFileCandidates(cwd)
  const existing = candidates.find((p) => existsSync(p))
  if (existing) return existing
  if (process.env.HH_CONTAINER_ROOT) return join(process.env.HH_CONTAINER_ROOT, ".env")
  return candidates[candidates.length - 1] ?? join(cwd, ".env")
}

let envLoaded = false
let loadedEnvFilePath: string | null = null
let envLoadFailure: { path: string; error: string } | null = null

export function getLoadedEnvFile(): string | null {
  return loadedEnvFilePath
}

export function getEnvLoadFailure(): { path: string; error: string } | null {
  return envLoadFailure
}

/**
 * Ensure provider credentials from the declared habitat env file are loaded
 * into process.env if they were not already present in the launch environment.
 */
export function ensureProviderKeysLoaded(
  cwd: string = process.cwd(),
  options?: { reload?: boolean; reset?: boolean },
): boolean {
  if (options?.reload || options?.reset) {
    envLoaded = false
    loadedEnvFilePath = null
    envLoadFailure = null
    if (options?.reset) return false
  }
  if (envLoaded) return loadedEnvFilePath !== null
  if (process.env.LLM_NO_ENV_AUTOLOAD === "1" && !process.env.HAB_ENV_FILE) return false

  if (process.env.HAB_ENV_FILE) {
    if (existsSync(process.env.HAB_ENV_FILE)) {
      try {
        const content = readFileSync(process.env.HAB_ENV_FILE, "utf8")
        const vars = parseEnvFile(content)
        for (const [key, val] of Object.entries(vars)) {
          if (PROVIDER_KEY_NAMES.has(key) && (process.env[key] === undefined || process.env[key] === "")) {
            process.env[key] = val
          }
        }
        if (process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
          process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY
        }
        loadedEnvFilePath = process.env.HAB_ENV_FILE
        envLoaded = true
        return true
      } catch (err) {
        envLoadFailure = {
          path: process.env.HAB_ENV_FILE,
          error: err instanceof Error ? err.message : String(err),
        }
        envLoaded = true
        return false
      }
    } else {
      envLoadFailure = {
        path: process.env.HAB_ENV_FILE,
        error: "file does not exist",
      }
      envLoaded = true
      return false
    }
  }

  const candidates = envFileCandidates(cwd)
  const target = candidates.find((p) => existsSync(p))
  if (!target) {
    envLoadFailure = {
      path: declaredHabitatEnvFile(cwd),
      error: "no env file found",
    }
    envLoaded = true
    return false
  }

  try {
    const content = readFileSync(target, "utf8")
    const vars = parseEnvFile(content)
    for (const [key, val] of Object.entries(vars)) {
      if (PROVIDER_KEY_NAMES.has(key) && (process.env[key] === undefined || process.env[key] === "")) {
        process.env[key] = val
      }
    }
    // Also alias GEMINI_API_KEY -> GOOGLE_GENERATIVE_AI_API_KEY if unset
    if (process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY
    }
    loadedEnvFilePath = target
    envLoaded = true
    return true
  } catch (err) {
    envLoadFailure = {
      path: target,
      error: err instanceof Error ? err.message : String(err),
    }
    envLoaded = true
    return false
  }
}

/** True when any provider credential at all reached this process. */
function anyProviderKeySet(): boolean {
  return Object.entries(process.env).some(([name, value]) => name.endsWith("_API_KEY") && !!value)
}

/**
 * Build the error thrown when a provider's key is absent.
 *
 * Keeps the `<VAR> not set` prefix every existing caller, log and doc greps
 * for, and appends the cause the reader actually needs. Fails loud naming the
 * declared env file and the seat.
 */
export function missingApiKeyError(envVar: string, cwd: string = process.cwd()): Error {
  const seat = currentSeat()
  const seatDesc = seat.startsWith("seat:") ? seat : `seat ${seat}`
  const declaredFile = getLoadedEnvFile() ?? declaredHabitatEnvFile(cwd)

  if (envLoadFailure && envLoadFailure.error !== "no env file found") {
    return new Error(
      `${envVar} not set for ${seatDesc} — attempted to load declared env file (${envLoadFailure.path}) but failed: ${envLoadFailure.error}.`,
    )
  }

  if (anyProviderKeySet()) {
    return new Error(
      `${envVar} not set for ${seatDesc}. Other *_API_KEY variables are set, so an env file did load ` +
        `(from ${declaredFile} or launch environment) — this key is missing from it or misspelled.`,
    )
  }

  const candidates = envFileCandidates(cwd)
  const present = candidates.filter((path) => existsSync(path))
  const remedy = present.length
    ? `${present.join(" and ")} exists for ${seatDesc} but did not reach this process — run \`direnv allow\` here ` +
      `(a freshly created git worktree is never allowed yet), then \`direnv reload\`.`
    : `no env file exists at ${candidates.join(" or ")} for ${seatDesc} — create one in the main checkout; ` +
      `worktrees inherit it through .envrc rather than getting their own copy.`

  return new Error(
    `${envVar} not set for ${seatDesc} — and no *_API_KEY is set at all, so this process loaded no env file. ${remedy}`,
  )
}
