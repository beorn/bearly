import { spawn, spawnSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

export const SUBMODULE_ALTERNATE_LOCATION = "superproject"
export const SUBMODULE_ALTERNATE_ERROR_STRATEGY = "info"
const MAX_CONCURRENT_SUBMODULE_UPDATES = 20

export type SubmoduleGitResult = Readonly<{
  exitCode: number
  stdout: string
  stderr: string
}>

export type MaterializeSubmodulesResult = SubmoduleGitResult &
  Readonly<{
    borrowed: number
    remoteFallbacks: number
  }>

export type MaterializeSubmodulesOptions = Readonly<{
  worktree: string
  /** `undefined` discovers the main worktree; the current worktree disables borrowing. */
  referenceWorktree?: string
  /** Restrict only the top-level materialization pass; nested submodules still recurse. */
  paths?: readonly string[]
  env?: NodeJS.ProcessEnv
  log?: (message: string) => void
}>

function stripRepositoryEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...environment }
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete clean[key]
  return clean
}

function git(repo: string, args: readonly string[], env: NodeJS.ProcessEnv): SubmoduleGitResult {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env })
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  }
}

function gitAsync(repo: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<SubmoduleGitResult> {
  return new Promise((_resolve) => {
    const child = spawn("git", ["-C", repo, ...args], { env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let settled = false
    const settle = (result: SubmoduleGitResult): void => {
      if (settled) return
      settled = true
      _resolve(result)
    }
    child.stdout.on("data", (chunk) => (stdout += String(chunk)))
    child.stderr.on("data", (chunk) => (stderr += String(chunk)))
    child.on("error", (error) => settle({ exitCode: -1, stdout, stderr: stderr || error.message }))
    child.on("close", (code) => settle({ exitCode: code ?? -1, stdout, stderr }))
  })
}

function success(): SubmoduleGitResult {
  return { exitCode: 0, stdout: "", stderr: "" }
}

/** Persist Git's documented alternate fallback policy in one repository. */
export function configureSubmoduleAlternatePolicy(
  repo: string,
  environment: NodeJS.ProcessEnv = process.env,
): SubmoduleGitResult {
  const env = stripRepositoryEnvironment(environment)
  for (const [key, value] of [
    ["submodule.alternateLocation", SUBMODULE_ALTERNATE_LOCATION],
    ["submodule.alternateErrorStrategy", SUBMODULE_ALTERNATE_ERROR_STRATEGY],
  ] as const) {
    const configured = git(repo, ["config", "--local", key, value], env)
    if (configured.exitCode !== 0) return configured
  }
  return success()
}

type WorktreeEntry = { path: string; branch?: string }

function parseWorktrees(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | undefined
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith("worktree ")) {
      if (current !== undefined) entries.push(current)
      current = { path: line.slice("worktree ".length) }
    } else if (current !== undefined && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length)
    } else if (line === "" && current !== undefined) {
      entries.push(current)
      current = undefined
    }
  }
  if (current !== undefined) entries.push(current)
  return entries
}

/** The checked-out main worktree is the canonical local object source. */
export function resolveMainWorktree(repo: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const env = stripRepositoryEnvironment(environment)
  const listed = git(repo, ["worktree", "list", "--porcelain"], env)
  if (listed.exitCode !== 0) return undefined
  const entries = parseWorktrees(listed.stdout)
  return entries.find((entry) => entry.branch === "refs/heads/main")?.path ?? entries[0]?.path
}

function canonical(pathname: string): string {
  return existsSync(pathname) ? realpathSync(pathname) : resolve(pathname)
}

type Submodule = Readonly<{ name: string; path: string }>

function submodules(repo: string, env: NodeJS.ProcessEnv): Submodule[] | SubmoduleGitResult {
  // Topology comes from the checked-out commit, never an untracked or dirty
  // `.gitmodules` created by an in-progress `git submodule add`.
  if (git(repo, ["cat-file", "-e", "HEAD:.gitmodules"], env).exitCode !== 0) return []
  const configured = git(repo, ["config", "--blob", "HEAD:.gitmodules", "--get-regexp", "^submodule\\..*\\.path$"], env)
  if (configured.exitCode === 1 && configured.stdout.trim() === "" && configured.stderr.trim() === "") return []
  if (configured.exitCode !== 0) return configured
  return configured.stdout
    .split(/\r?\n/u)
    .filter((line) => line !== "")
    .map((line): Submodule | undefined => {
      const match = /^(submodule\.(.+)\.path)\s+(.+)$/u.exec(line)
      return match?.[2] === undefined || match[3] === undefined ? undefined : { name: match[2], path: match[3] }
    })
    .filter((submodule): submodule is Submodule => submodule !== undefined)
}

function requiredGitlink(repo: string, path: string, env: NodeJS.ProcessEnv): string | undefined {
  const tree = git(repo, ["ls-tree", "HEAD", "--", path], env)
  if (tree.exitCode !== 0) return undefined
  return /^160000 commit ([0-9a-f]+)\t/mu.exec(tree.stdout)?.[1]
}

function referenceContains(reference: string, sha: string, env: NodeJS.ProcessEnv): boolean {
  return git(reference, ["cat-file", "-e", `${sha}^{commit}`], env).exitCode === 0
}

type MaterializationState = { borrowed: number; remoteFallbacks: number }

type PreparedSubmodule = Readonly<{
  args: readonly string[]
  nestedReference: string | undefined
  path: string
}>

function prepareSubmodules(
  options: MaterializeSubmodulesOptions,
  worktree: string,
  reference: string | undefined,
  env: NodeJS.ProcessEnv,
  state: MaterializationState,
  log: (message: string) => void,
  selectedPaths?: ReadonlySet<string>,
): PreparedSubmodule[] | SubmoduleGitResult {
  const policy = configureSubmoduleAlternatePolicy(worktree, env)
  if (policy.exitCode !== 0) return policy

  const entries = submodules(worktree, env)
  if (!Array.isArray(entries)) return entries
  const prepared: PreparedSubmodule[] = []
  for (const { name, path } of entries) {
    if (selectedPaths !== undefined && !selectedPaths.has(path)) continue
    const required = requiredGitlink(worktree, path, env)
    if (required === undefined) {
      return { exitCode: 1, stdout: "", stderr: `could not resolve gitlink '${path}' in ${worktree}` }
    }
    const referenceSubmodule = reference === undefined ? undefined : join(reference, path)
    const canBorrow = referenceSubmodule !== undefined && referenceContains(referenceSubmodule, required, env)

    // Register the canonical configured URL before applying the command-only
    // local rewrite. This preserves `remote.origin.url` for later real fetches
    // while making the cold clone itself a zero-network local read.
    const initialized = git(worktree, ["submodule", "init", "--", path], env)
    if (initialized.exitCode !== 0) return initialized
    const configuredUrl = git(worktree, ["config", "--get", `submodule.${name}.url`], env)
    if (configuredUrl.exitCode !== 0 || configuredUrl.stdout.trim() === "") {
      return {
        exitCode: configuredUrl.exitCode === 0 ? 1 : configuredUrl.exitCode,
        stdout: configuredUrl.stdout,
        stderr: configuredUrl.stderr || `could not resolve configured URL for submodule '${name}' in ${worktree}`,
      }
    }
    const sourceUrl = configuredUrl.stdout.trim()
    const args = [
      "-c",
      `submodule.alternateLocation=${SUBMODULE_ALTERNATE_LOCATION}`,
      "-c",
      `submodule.alternateErrorStrategy=${SUBMODULE_ALTERNATE_ERROR_STRATEGY}`,
      ...(canBorrow
        ? [
            "-c",
            "protocol.file.allow=always",
            "-c",
            `url.${pathToFileURL(referenceSubmodule).href}.insteadOf=${sourceUrl}`,
          ]
        : []),
      "submodule",
      "update",
      "--init",
      ...(canBorrow ? ["--reference", referenceSubmodule] : []),
      "--",
      path,
    ]
    if (canBorrow) {
      state.borrowed += 1
    } else if (referenceSubmodule !== undefined) {
      state.remoteFallbacks += 1
      log(`[submodules] ${path}: local store lacks ${required.slice(0, 12)}; using the configured remote fallback`)
    }
    prepared.push({ args, nestedReference: canBorrow ? referenceSubmodule : undefined, path })
  }
  return prepared
}

function referenceRoot(options: MaterializeSubmodulesOptions, env: NodeJS.ProcessEnv): string | undefined {
  const discovered =
    options.referenceWorktree === undefined ? resolveMainWorktree(options.worktree, env) : options.referenceWorktree
  return discovered !== undefined && canonical(discovered) !== canonical(options.worktree) ? discovered : undefined
}

function withCounts(result: SubmoduleGitResult, state: MaterializationState): MaterializeSubmodulesResult {
  return { ...result, borrowed: state.borrowed, remoteFallbacks: state.remoteFallbacks }
}

/**
 * Initialize every submodule from its matching checkout in the main worktree.
 *
 * `submodule.alternateLocation=superproject` only follows an alternate already
 * attached to the superproject. Linked worktrees share the superproject object
 * directory directly, so they have no such alternate. `--reference` supplies
 * the missing per-submodule mapping before clone. For a proven matching local
 * store, a command-scoped `url.*.insteadOf` also routes the clone source to
 * that checkout. Git records the configured origin URL, but performs no remote
 * handshake merely to copy refs it already has locally. Nested submodules
 * recurse through the same path mapping. Refs/config/worktrees remain
 * independent.
 */
export function materializeSubmodulesFromLocalWorktree(
  options: MaterializeSubmodulesOptions,
): MaterializeSubmodulesResult {
  const env = stripRepositoryEnvironment(options.env ?? process.env)
  const log = options.log ?? (() => {})
  const state: MaterializationState = { borrowed: 0, remoteFallbacks: 0 }

  const walk = (
    worktree: string,
    reference: string | undefined,
    selectedPaths?: ReadonlySet<string>,
  ): SubmoduleGitResult => {
    const prepared = prepareSubmodules(options, worktree, reference, env, state, log, selectedPaths)
    if (!Array.isArray(prepared)) return prepared
    for (const { args, nestedReference, path } of prepared) {
      const updated = git(worktree, args, env)
      if (updated.exitCode !== 0) return updated

      const nested = walk(join(worktree, path), nestedReference)
      if (nested.exitCode !== 0) return nested
    }
    return success()
  }

  const selectedPaths = options.paths === undefined ? undefined : new Set(options.paths)
  return withCounts(walk(options.worktree, referenceRoot(options, env), selectedPaths), state)
}

/**
 * Parallel materializer for cold worktree/bay paths. Git's former recursive
 * update used `--jobs 20`; preserve that latency contract while retaining the
 * per-submodule local-reference mapping that removes network transfer.
 */
export async function materializeSubmodulesFromLocalWorktreeParallel(
  options: MaterializeSubmodulesOptions,
): Promise<MaterializeSubmodulesResult> {
  const env = stripRepositoryEnvironment(options.env ?? process.env)
  const log = options.log ?? (() => {})
  const state: MaterializationState = { borrowed: 0, remoteFallbacks: 0 }

  const walk = async (
    worktree: string,
    reference: string | undefined,
    selectedPaths?: ReadonlySet<string>,
  ): Promise<SubmoduleGitResult> => {
    const prepared = prepareSubmodules(options, worktree, reference, env, state, log, selectedPaths)
    if (!Array.isArray(prepared)) return prepared
    for (let start = 0; start < prepared.length; start += MAX_CONCURRENT_SUBMODULE_UPDATES) {
      const results = await Promise.all(
        prepared.slice(start, start + MAX_CONCURRENT_SUBMODULE_UPDATES).map(async ({ args, nestedReference, path }) => {
          const updated = await gitAsync(worktree, args, env)
          return updated.exitCode === 0 ? walk(join(worktree, path), nestedReference) : updated
        }),
      )
      const failed = results.find((result) => result.exitCode !== 0)
      if (failed !== undefined) return failed
    }
    return success()
  }

  const selectedPaths = options.paths === undefined ? undefined : new Set(options.paths)
  return withCounts(await walk(options.worktree, referenceRoot(options, env), selectedPaths), state)
}

if (import.meta.main) {
  const worktree = process.argv[2]
  const referenceWorktree = process.argv[3]
  const paths = process.argv.slice(4)
  if (worktree === undefined) {
    console.error("usage: bun submodule-materialize.ts <worktree> [reference-worktree] [path ...]")
    process.exit(2)
  }
  const result = await materializeSubmodulesFromLocalWorktreeParallel({
    worktree,
    ...(referenceWorktree === undefined ? {} : { referenceWorktree }),
    ...(paths.length === 0 ? {} : { paths }),
    log: (message) => console.error(message),
  })
  if (result.exitCode !== 0) {
    console.error((result.stderr || result.stdout).trim())
    process.exit(result.exitCode)
  }
  console.error(
    `[submodules] materialized with ${result.borrowed} local store(s) borrowed; ${result.remoteFallbacks} remote fallback(s)`,
  )
}
