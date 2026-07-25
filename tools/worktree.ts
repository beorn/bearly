#!/usr/bin/env bun
/**
 * worktree.ts - Git worktree management with submodule support
 *
 * Creates, removes, and lists git worktrees with proper setup for projects that use:
 * - Git submodules (isolated refs and working trees that borrow local objects)
 * - bun/npm dependencies
 * - direnv
 * - Git hooks
 *
 * Commands:
 *   (default)              - Show worktrees and help
 *   create <name> [branch] - Create worktree at ../<repo>-<name>
 *   remove <name>          - Remove worktree
 *   list                   - Detailed worktree status (with per-submodule HEAD SHAs)
 *
 * Submodule isolation
 * -------------------
 * Each worktree gets an independent submodule gitdir stored at
 * `.git/worktrees/<name>/modules/<path>/`. After `git worktree add`,
 * the materializer populates the working tree and creates that per-worktree
 * module dir while borrowing object history from the matching main checkout.
 * Refs, config, index, and working files stay isolated; repeated history is
 * not downloaded into a private pack first.
 *
 * Note on --recurse-submodules: `git worktree add` does NOT support a
 * `--recurse-submodules` flag (the documentation sometimes suggests
 * otherwise; as of git 2.53 the flag is rejected). The `submodule.recurse`
 * config is respected elsewhere but not for `worktree add`, so the local
 * materializer populates every required gitlink after the worktree is added.
 *
 * On removal, we explicitly clean up `.git/worktrees/<name>/modules/`
 * before calling `git worktree remove` so git's own cleanup never leaves
 * orphans (which can happen on interrupted removes or older git versions).
 */

import { spawnSync } from "node:child_process"
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "fs"
import { tmpdir } from "node:os"
import { join, dirname, basename, isAbsolute, relative, resolve } from "path"
import { $ } from "bun"
import { materializeSubmodulesFromLocalWorktreeParallel } from "./submodule-materialize.ts"

// ANSI colors
const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const RED = "\x1b[31m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const BLUE = "\x1b[34m"
const CYAN = "\x1b[36m"

const info = (msg: string) => console.log(`${BLUE}→${RESET} ${msg}`)
const success = (msg: string) => console.log(`${GREEN}✓${RESET} ${msg}`)
const warn = (msg: string) => console.log(`${YELLOW}⚠${RESET} ${msg}`)
const error = (msg: string) => console.error(`${RED}✗${RESET} ${msg}`)

/** Internal parent→delegate handoff after the parent has fetched and verified the base. */
export const PREPARED_BASE_SHA_ENV = "BEARLY_WORKTREE_PREPARED_BASE_SHA"

/**
 * `git worktree add` runs the clone-wide post-checkout hook before returning.
 * The creator owns submodule initialization immediately afterward, using the
 * matching main-worktree stores as `--reference` sources. Suppress the hook's
 * generic sync so it cannot perform a full remote clone first.
 */
export function worktreeAddEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...environment, KM_NO_AUTO_SUBMODULE_UPDATE: "1" }
}

// ============================================
// Core Functions (exported for library use)
// ============================================

/** Find git root from a starting directory */
export function findGitRoot(startDir: string): string | undefined {
  let current = startDir
  while (current !== dirname(current)) {
    if (existsSync(join(current, ".git"))) {
      return current
    }
    current = dirname(current)
  }
  return undefined
}

/** Parse submodule paths from .gitmodules */
export function getSubmodulePaths(repoRoot: string): string[] {
  const gitmodulesPath = join(repoRoot, ".gitmodules")
  if (!existsSync(gitmodulesPath)) return []

  const content = readFileSync(gitmodulesPath, "utf8")
  const paths: string[] = []
  const regex = /path\s*=\s*(.+)/g
  let match
  while ((match = regex.exec(content.toString())) !== null) {
    const path = match[1]
    if (path) paths.push(path.trim())
  }
  return paths
}

/** Safe shell execution - doesn't throw on non-zero exit */
export async function safeExec(cmd: ReturnType<typeof $>): Promise<{ stdout: string; exitCode: number }> {
  try {
    const result = await cmd.quiet()
    return { stdout: result.stdout.toString(), exitCode: result.exitCode }
  } catch (e) {
    const err = e as { exitCode?: number; stdout?: Buffer }
    return { stdout: err.stdout?.toString() ?? "", exitCode: err.exitCode ?? 1 }
  }
}

/** Check if a commit exists on any remote branch */
export async function commitExistsOnRemote(repoPath: string, commit: string): Promise<boolean> {
  const result = await safeExec($`cd ${repoPath} && git branch -r --contains ${commit} 2>/dev/null`)
  return result.exitCode === 0 && result.stdout.trim().length > 0
}

/** Get list of worktrees */
export async function getWorktrees(
  gitRoot: string,
): Promise<Array<{ path: string; branch: string; isDetached: boolean }>> {
  const result = await $`cd ${gitRoot} && git worktree list --porcelain`.quiet()
  const lines = result.stdout.toString().split("\n")

  const worktrees: Array<{
    path: string
    branch: string
    isDetached: boolean
  }> = []
  let currentPath = ""
  let currentBranch = ""
  let isDetached = false

  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice(9)
    } else if (line.startsWith("branch ")) {
      currentBranch = line.slice(7).replace("refs/heads/", "")
    } else if (line === "detached") {
      currentBranch = "(detached)"
      isDetached = true
    } else if (line === "" && currentPath) {
      // Skip internal .git/modules paths (submodule worktrees)
      if (!currentPath.includes("/.git/modules/")) {
        worktrees.push({
          path: currentPath,
          branch: currentBranch,
          isDetached,
        })
      }
      currentPath = ""
      currentBranch = ""
      isDetached = false
    }
  }

  return worktrees
}

/**
 * Find the per-worktree submodule modules directory.
 *
 * Modern git stores per-worktree submodule clones at
 * `<common-git-dir>/worktrees/<name>/modules/<submodule-path>/`. This returns
 * that path for a given worktree (by name). Returns undefined for the main
 * worktree or if the path can't be resolved.
 */
export async function getWorktreeModulesDir(gitRoot: string, worktreeName: string): Promise<string | undefined> {
  const commonDirResult = await safeExec($`cd ${gitRoot} && git rev-parse --git-common-dir`)
  if (commonDirResult.exitCode !== 0) return undefined
  let commonDir = commonDirResult.stdout.trim()
  if (!commonDir) return undefined
  // git may return relative path; make absolute
  if (!commonDir.startsWith("/")) commonDir = join(gitRoot, commonDir)
  return join(commonDir, "worktrees", worktreeName, "modules")
}

/** Get per-submodule HEAD SHAs for a worktree, keyed by submodule path. */
export async function getSubmoduleHeads(worktreePath: string): Promise<Record<string, string>> {
  const heads: Record<string, string> = {}
  const submodules = getSubmodulePaths(worktreePath)
  for (const sub of submodules) {
    const subPath = join(worktreePath, sub)
    if (!existsSync(join(subPath, ".git"))) continue
    const result = await safeExec($`cd ${subPath} && git rev-parse HEAD 2>/dev/null`)
    if (result.exitCode === 0) {
      heads[sub] = result.stdout.trim().slice(0, 12)
    }
  }
  return heads
}

/** Check for uncommitted changes in a worktree */
export async function getWorktreeStatus(worktreePath: string): Promise<{ dirty: boolean; changes: string[] }> {
  if (!existsSync(worktreePath)) {
    return { dirty: false, changes: [] }
  }

  const result = await safeExec(
    $`cd ${worktreePath} && git status --porcelain --untracked-files=all --ignore-submodules=none 2>/dev/null`,
  )

  const changes = result.stdout.trim().split("\n").filter(Boolean)
  return { dirty: changes.length > 0, changes }
}

// ============================================
// Pool root — configurable slot location
// ============================================
//
// The persistent slot pool (`<repo>-wtN`) historically lives as SIBLINGS of
// the repo (`<repoParent>/<repo>-wtN`), which sprawls the parent directory.
// The `worktree.poolRoot` git config key relocates the pool — typically to a
// contained, git-ignored directory inside the repo
// (`<repo>/.worktrees/<repo>-wtN`). km bead 20888-contained-worktree-pool.
//
//   unset          → sibling parent (historic behavior, zero change)
//   relative value → resolved under the repo root (contained pool)
//   absolute value → used as-is
//   empty value    → loud config error (never a silent sibling fallback)
//
// Existing slots are FOUND in both locations (configured pool first, then the
// legacy sibling), so setting the config never orphans a live slot; creates
// always land at the configured pool.

/** Git config key that relocates the worktree pool. */
export const POOL_ROOT_CONFIG_KEY = "worktree.poolRoot"

/**
 * Read `worktree.poolRoot` from the repo's git config. A path with no `.git`
 * entry has no config surface at all — that is the defined "unset" answer
 * (pure path math on non-repos, e.g. in tests), not an error. For a real
 * repo, `git config --get` exits 1 for "unset" (normal); any other failure
 * throws — a broken git invocation must never silently fall back to the
 * sibling pool.
 */
export function readPoolRootConfig(gitRoot: string): string | undefined {
  if (!existsSync(join(gitRoot, ".git"))) return undefined
  const result = spawnSync("git", ["-C", gitRoot, "config", "--get", POOL_ROOT_CONFIG_KEY], { encoding: "utf8" })
  if (result.status === 0) return (result.stdout ?? "").trim()
  const stderr = (result.stderr ?? "").trim()
  if (result.status === 1 && stderr === "") return undefined
  throw new Error(`git config --get ${POOL_ROOT_CONFIG_KEY} failed in ${gitRoot}: ${stderr || `exit ${result.status}`}`)
}

/**
 * Resolve the pool root directory for a repo. See the section comment for the
 * config contract. `readValue` is injectable for tests; the default reads the
 * repo's git config (shared across linked worktrees, so a config set once on
 * the main checkout applies pool-wide).
 */
export function resolvePoolRoot(
  gitRoot: string,
  readValue: (gitRoot: string) => string | undefined = readPoolRootConfig,
): string {
  const raw = readValue(gitRoot)
  if (raw === undefined) return dirname(gitRoot)
  const value = raw.trim().replace(/\/+$/, "")
  if (value === "") {
    throw new Error(
      `${POOL_ROOT_CONFIG_KEY} is set but empty — set a pool path (e.g. .worktrees) or unset it: ` +
        `git -C ${gitRoot} config --unset ${POOL_ROOT_CONFIG_KEY}`,
    )
  }
  return isAbsolute(value) ? value : join(gitRoot, value)
}

/** Slot directory name inside a pool: `<repoName>-<name>`, unless already prefixed. */
export function slotDirName(repoName: string, name: string): string {
  return name.startsWith(`${repoName}-`) ? name : `${repoName}-${name}`
}

/**
 * Ordered filesystem candidates for a slot: the configured pool first, then
 * the legacy sibling location (deduped when the pool IS the sibling parent).
 */
export function slotPathCandidates(gitRoot: string, name: string, poolRoot: string): string[] {
  const dir = slotDirName(basename(gitRoot), name)
  const candidates = [join(poolRoot, dir), join(dirname(gitRoot), dir)]
  return candidates.filter((candidate, index) => candidates.indexOf(candidate) === index)
}

/**
 * A worktree name must be non-empty and can never be flag-shaped. Defense in
 * depth for library callers: the CLI planner already refuses to treat a
 * `-`-prefixed token as a name (the `bun worktree reset --help` → `<repo>---help`
 * sprawl incident, km bead 20888), but every verb validates again before any
 * filesystem work.
 */
export function assertValidWorktreeName(name: string): void {
  if (name.trim() === "" || name.startsWith("-")) {
    throw new Error(
      `Invalid worktree name ${JSON.stringify(name)} — a worktree name must be non-empty and cannot start with "-"`,
    )
  }
}

// ============================================
// Agent-clone GC (linked isolation worktrees + preserved legacy clones)
// ============================================

/**
 * Agent-isolation paths live under `<gitRoot>/.claude/worktrees/agent-*`.
 * Current paths are registered linked worktrees; older hosts made independent
 * APFS clones in the same directory. GC may remove only the former, after
 * proving that their checked-out history is landed and their tree is clean.
 * Legacy standalone clones and malformed paths are preserved for recovery.
 *
 * Classification mirrors `.claude/lib/classify-clone.sh` (single algorithm,
 * two language-specific implementations for the hooks vs CLI).
 */
export type AgentCloneClass = "broken" | "dirty" | "unique-work" | "clean"

export interface AgentCloneStatus {
  name: string
  path: string
  class: AgentCloneClass
  uncommitted: number
  ageHours: number
  /**
   * Number of nested clones inside this clone (pre-2026-04-23 isolate.sh
   * bug — clones inherited their source's `.claude/worktrees/`). Modern
   * clones reset to HEAD on creation so cascades don't recur, but legacy
   * preserved clones may still hold them.
   */
  cascadeCount: number
}

/** Count nested agent-* clones inside a given clone path. */
export async function countCascades(clonePath: string): Promise<number> {
  const inner = join(clonePath, ".claude", "worktrees")
  if (!existsSync(inner)) return 0
  const result = await safeExec($`ls -1 ${inner} 2>/dev/null`)
  let n = 0
  for (const name of result.stdout.split("\n")) {
    if (name.startsWith("agent-") && existsSync(join(inner, name))) n++
  }
  return n
}

export async function classifyAgentClone(clonePath: string): Promise<AgentCloneClass> {
  if (!existsSync(join(clonePath, ".git"))) return "broken"

  const status = await safeExec(
    $`git -C ${clonePath} status --porcelain --untracked-files=all --ignore-submodules=none 2>/dev/null`,
  )
  if (status.exitCode !== 0) return "broken"
  if (status.stdout.trim().length > 0) return "dirty"

  const headResult = await safeExec($`git -C ${clonePath} rev-parse --verify HEAD^{commit} 2>/dev/null`)
  const head = headResult.stdout.trim()
  if (headResult.exitCode !== 0 || !head) return "broken"

  const inMain = await safeExec(
    $`git -C ${clonePath} merge-base --is-ancestor ${head} refs/remotes/origin/main 2>/dev/null`,
  )
  if (inMain.exitCode !== 0) return "unique-work"

  // Any local-only branch with commits not in origin/main and not on any remote?
  const branches = await safeExec(
    $`git -C ${clonePath} for-each-ref --format='%(objectname) %(refname:short)' refs/heads 2>/dev/null`,
  )
  if (branches.exitCode !== 0) return "broken"
  for (const line of branches.stdout.split("\n")) {
    if (!line.trim()) continue
    const sha = line.split(" ")[0]
    if (!sha) continue
    const reachable = await safeExec(
      $`git -C ${clonePath} merge-base --is-ancestor ${sha} refs/remotes/origin/main 2>/dev/null`,
    )
    if (reachable.exitCode === 0) continue
    const onRemote = await commitExistsOnRemote(clonePath, sha)
    if (onRemote) continue
    return "unique-work"
  }

  return "clean"
}

export async function listAgentClones(rootDir: string): Promise<AgentCloneStatus[]> {
  if (!existsSync(rootDir)) return []
  const out: AgentCloneStatus[] = []
  const result = await safeExec($`ls -1 ${rootDir} 2>/dev/null`)
  for (const name of result.stdout.split("\n")) {
    if (!name || !name.startsWith("agent-")) continue
    const path = join(rootDir, name)
    if (!existsSync(path)) continue
    const cls = await classifyAgentClone(path)
    const stat = await safeExec($`stat -f '%m' ${path} 2>/dev/null`)
    const mtime = parseInt(stat.stdout.trim(), 10) * 1000
    const ageHours = isNaN(mtime) ? 0 : (Date.now() - mtime) / 3600000
    const stProb = await getWorktreeStatus(path)
    const cascadeCount = await countCascades(path)
    out.push({ name, path, class: cls, uncommitted: stProb.changes.length, ageHours, cascadeCount })
  }
  return out
}

export interface GcOptions {
  root?: string
  dryRun?: boolean
  minAgeHours?: number
  /** Deprecated compatibility flag. Unique work is always preserved. */
  includeUniqueWork?: boolean
}

interface GcCandidateProof {
  removable: boolean
  reason: string
}

export interface ProcessCwdCensus {
  available: boolean
  cwdPaths: string[]
  reason: string
}

export interface GcDependencies {
  censusProcessCwds?: () => ProcessCwdCensus | Promise<ProcessCwdCensus>
}

const CWD_CENSUS_TIMEOUT_MS = 2_000
const CWD_CENSUS_MAX_BUFFER = 8 * 1024 * 1024
const CWD_CENSUS_MAX_PROCESSES = 32_768

function unavailableCwdCensus(reason: string): ProcessCwdCensus {
  return { available: false, cwdPaths: [], reason }
}

function currentProcessCwd(): string | undefined {
  try {
    return realpathSync(process.cwd())
  } catch {
    return undefined
  }
}

function censusDarwinProcessCwds(currentCwd: string): ProcessCwdCensus {
  const lsof = ["/usr/sbin/lsof", "/usr/bin/lsof"].find(existsSync)
  if (!lsof) return unavailableCwdCensus("lsof is unavailable")

  const result = spawnSync(lsof, ["-a", "-d", "cwd", "-F0n"], {
    encoding: "utf8",
    timeout: CWD_CENSUS_TIMEOUT_MS,
    maxBuffer: CWD_CENSUS_MAX_BUFFER,
  })
  if (result.error || result.status !== 0 || (result.stderr ?? "").trim() !== "") {
    const stderr = (result.stderr ?? "").trim()
    return unavailableCwdCensus(result.error?.message ?? (stderr || `lsof exit ${result.status}`))
  }

  const cwdPaths = new Set<string>([currentCwd])
  let observedCwds = 0
  for (const rawField of (result.stdout ?? "").split("\0")) {
    const field = rawField.startsWith("\n") ? rawField.slice(1) : rawField
    if (!field.startsWith("n")) continue
    const cwd = field.slice(1)
    if (!isAbsolute(cwd)) return unavailableCwdCensus("lsof returned a non-absolute CWD")
    cwdPaths.add(cwd)
    observedCwds++
  }
  if (observedCwds === 0) return unavailableCwdCensus("lsof returned no process CWDs")
  return { available: true, cwdPaths: [...cwdPaths], reason: "macOS lsof census" }
}

function censusLinuxProcessCwds(currentCwd: string): ProcessCwdCensus {
  let processIds: string[]
  try {
    processIds = readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))
  } catch (error) {
    return unavailableCwdCensus(`cannot enumerate /proc: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (processIds.length > CWD_CENSUS_MAX_PROCESSES) {
    return unavailableCwdCensus(`process count exceeds ${CWD_CENSUS_MAX_PROCESSES}`)
  }

  const cwdPaths = new Set<string>([currentCwd])
  for (const processId of processIds) {
    try {
      const cwd = readlinkSync(`/proc/${processId}/cwd`)
      if (!isAbsolute(cwd)) return unavailableCwdCensus(`/proc/${processId}/cwd is not absolute`)
      cwdPaths.add(cwd)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "ESRCH" || code === "EINVAL") continue
      return unavailableCwdCensus(`cannot read /proc/${processId}/cwd: ${code ?? String(error)}`)
    }
  }
  return { available: true, cwdPaths: [...cwdPaths], reason: "Linux /proc census" }
}

/** Bounded, fail-closed census of process working directories. */
export function censusProcessCwds(): ProcessCwdCensus {
  const currentCwd = currentProcessCwd()
  if (!currentCwd) return unavailableCwdCensus("current process CWD is unavailable")
  if (process.platform === "darwin") return censusDarwinProcessCwds(currentCwd)
  if (process.platform === "linux") return censusLinuxProcessCwds(currentCwd)
  return unavailableCwdCensus(`unsupported platform ${process.platform}`)
}

function proveNoLiveCwd(candidatePath: string, census: ProcessCwdCensus): GcCandidateProof {
  if (!census.available) return { removable: false, reason: `CWD census unavailable: ${census.reason}` }

  let candidate: string
  try {
    candidate = realpathSync(candidatePath)
  } catch {
    return { removable: false, reason: "candidate path proof unavailable" }
  }

  for (const cwdPath of census.cwdPaths) {
    if (!isAbsolute(cwdPath)) return { removable: false, reason: "CWD census returned a non-absolute path" }
    const rel = relative(candidate, resolve(cwdPath))
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      return { removable: false, reason: `live process CWD inside ${candidatePath}` }
    }
  }
  return { removable: true, reason: "no live process CWD" }
}

function proveNoLiveLease(candidatePath: string): GcCandidateProof {
  const leaseFile = join(candidatePath, ".agent-lease.json")
  if (existsSync(leaseFile)) {
    try {
      const content = readFileSync(leaseFile, "utf8")
      const parsed = JSON.parse(content) as { pid?: number; sessionId?: string }
      if (typeof parsed?.pid === "number" && parsed.pid > 0) {
        let alive = false
        try {
          process.kill(parsed.pid, 0)
          alive = true
        } catch (err) {
          alive = (err as NodeJS.ErrnoException).code === "EPERM"
        }
        if (alive) {
          return {
            removable: false,
            reason: `active agent lease held by pid ${parsed.pid} (${parsed.sessionId ?? "agent"})`,
          }
        }
      }
    } catch {
      return { removable: false, reason: "unreadable .agent-lease.json file present" }
    }
  }
  return { removable: true, reason: "no active lease" }
}

async function registeredWorktreePaths(gitRoot: string): Promise<Set<string>> {
  const result = await safeExec($`git -C ${gitRoot} worktree list --porcelain -z`)
  if (result.exitCode !== 0) {
    throw new Error(`git worktree list failed in ${gitRoot}; no paths were removed`)
  }

  const paths = new Set<string>()
  for (const field of result.stdout.split("\0")) {
    if (field.startsWith("worktree ")) paths.add(resolve(field.slice("worktree ".length)))
  }
  return paths
}

/**
 * Prove that a path is a registered linked worktree whose complete reachable
 * history is already on origin/main. `rev-list origin/main..HEAD` counts
 * merge-only commits as well as ordinary commits; a clean tree alone is never
 * sufficient proof.
 */
async function proveGcCandidate(
  gitRoot: string,
  candidatePath: string,
  knownRegistrations?: ReadonlySet<string>,
): Promise<GcCandidateProof> {
  const path = resolve(candidatePath)
  if (path === resolve(gitRoot)) return { removable: false, reason: "main worktree" }

  const registrations = knownRegistrations ?? (await registeredWorktreePaths(gitRoot))
  if (!registrations.has(path)) return { removable: false, reason: "unregistered path" }
  if (!existsSync(path)) return { removable: false, reason: "registered path is missing" }

  const status = await safeExec(
    $`git -C ${path} status --porcelain --untracked-files=all --ignore-submodules=none 2>/dev/null`,
  )
  if (status.exitCode !== 0) return { removable: false, reason: "status proof unavailable" }
  if (status.stdout.trim().length > 0) return { removable: false, reason: "dirty worktree" }

  const head = await safeExec($`git -C ${path} rev-parse --verify HEAD^{commit} 2>/dev/null`)
  if (head.exitCode !== 0 || head.stdout.trim() === "") {
    return { removable: false, reason: "HEAD proof unavailable" }
  }

  const upstream = await safeExec($`git -C ${path} rev-parse --verify refs/remotes/origin/main^{commit} 2>/dev/null`)
  if (upstream.exitCode !== 0 || upstream.stdout.trim() === "") {
    return { removable: false, reason: "origin/main proof unavailable" }
  }

  const unique = await safeExec($`git -C ${path} rev-list --count refs/remotes/origin/main..HEAD 2>/dev/null`)
  if (unique.exitCode !== 0 || !/^\d+$/.test(unique.stdout.trim())) {
    return { removable: false, reason: "unique-history proof unavailable" }
  }
  if (unique.stdout.trim() !== "0") return { removable: false, reason: "unique history" }

  return { removable: true, reason: "registered, clean, and landed" }
}

async function removeGcCandidate(
  gitRoot: string,
  candidatePath: string,
  censusProvider: NonNullable<GcDependencies["censusProcessCwds"]>,
): Promise<void> {
  const liveProof = proveNoLiveCwd(candidatePath, await censusProvider())
  if (!liveProof.removable) {
    throw new Error(`Refusing to remove ${candidatePath}: ${liveProof.reason}`)
  }

  const leaseProof = proveNoLiveLease(candidatePath)
  if (!leaseProof.removable) {
    throw new Error(`Refusing to remove ${candidatePath}: ${leaseProof.reason}`)
  }

  const proof = await proveGcCandidate(gitRoot, candidatePath)
  if (!proof.removable) {
    throw new Error(`Refusing to remove ${candidatePath}: ${proof.reason}`)
  }

  const removal = await safeExec($`git -C ${gitRoot} worktree remove --force ${candidatePath}`)
  if (removal.exitCode !== 0) throw new Error(`git worktree remove failed for ${candidatePath}`)

  const registrations = await registeredWorktreePaths(gitRoot)
  if (existsSync(candidatePath) || registrations.has(resolve(candidatePath))) {
    throw new Error(`git reported success but did not fully remove linked worktree ${candidatePath}`)
  }
}

export async function gcAgentClones(
  opts: GcOptions = {},
  dependencies: GcDependencies = {},
): Promise<{
  deleted: AgentCloneStatus[]
  preserved: AgentCloneStatus[]
}> {
  const gitRoot = findGitRoot(process.cwd())
  if (!gitRoot) {
    error("Not in a git repository")
    process.exit(1)
  }
  const root = opts.root ?? join(gitRoot, ".claude/worktrees")
  const dryRun = opts.dryRun ?? false
  const minAgeHours = opts.minAgeHours ?? 0
  const includeUnique = opts.includeUniqueWork ?? false

  const clones = await listAgentClones(root)
  if (clones.length === 0) {
    info(`No agent clones at ${root}`)
    return { deleted: [], preserved: [] }
  }

  const deleted: AgentCloneStatus[] = []
  const preserved: AgentCloneStatus[] = []
  const reasons = new Map<string, string>()
  const registrations = await registeredWorktreePaths(gitRoot)
  const censusProvider = dependencies.censusProcessCwds ?? censusProcessCwds
  const cwdCensus = await censusProvider()

  if (includeUnique) {
    warn("--include-unique-work is retained for compatibility but is now a safety no-op; unique work is preserved")
  }

  for (const c of clones) {
    const oldEnough = c.ageHours >= minAgeHours
    const liveProof = proveNoLiveCwd(c.path, cwdCensus)
    const leaseProof = proveNoLiveLease(c.path)
    const proof = !oldEnough
      ? { removable: false, reason: `younger than ${minAgeHours}h` }
      : !liveProof.removable
        ? liveProof
        : !leaseProof.removable
          ? leaseProof
          : await proveGcCandidate(gitRoot, c.path, registrations)
    reasons.set(c.path, proof.reason)
    if (proof.removable) {
      deleted.push(c)
    } else {
      preserved.push(c)
    }
  }

  // Report
  console.log(BOLD + (dryRun ? "DRY RUN — " : "") + `Agent clones at ${root}` + RESET)
  console.log(DIM + `  ${clones.length} total · ${deleted.length} to delete · ${preserved.length} to preserve` + RESET)
  console.log("")
  for (const c of clones) {
    const tag = deleted.includes(c) ? RED + "DELETE  " + RESET : GREEN + "PRESERVE" + RESET
    const ageStr = `${c.ageHours.toFixed(1)}h`
    const classSummary = c.class === "dirty" ? `${c.class} (${c.uncommitted} uncommitted)` : c.class
    const why = `${classSummary}; ${reasons.get(c.path) ?? "unproven"}`
    const cascade = c.cascadeCount > 0 ? YELLOW + ` +${c.cascadeCount} nested cascade` + RESET : ""
    console.log(`  ${tag}  ${c.name.padEnd(40)} ${DIM}${ageStr.padStart(7)}${RESET}  ${why}${cascade}`)
  }
  // Surface cascades inside PRESERVED clones — those won't be cleaned by
  // outer deletion. They require deliberate recovery before any cleanup.
  const preservedWithCascade = preserved.filter((c) => c.cascadeCount > 0)
  if (preservedWithCascade.length > 0) {
    console.log("")
    console.log(YELLOW + "  Note: preserved clones contain nested cascades:" + RESET)
    for (const c of preservedWithCascade) {
      console.log(DIM + `    ${c.name} contains ${c.cascadeCount} inner clone(s) at .claude/worktrees/` + RESET)
    }
    console.log(DIM + "  Cascades are pre-2026-04-23 inheritance junk; review the parent before deleting." + RESET)
  }

  if (dryRun || deleted.length === 0) {
    return { deleted, preserved }
  }

  console.log("")
  info(`Removing ${deleted.length} registered linked worktree(s) through Git...`)
  for (const c of deleted) {
    await removeGcCandidate(gitRoot, c.path, censusProvider)
  }
  success(`Removed ${deleted.length} registered linked worktree(s)`)

  return { deleted, preserved }
}

// ============================================
// Audit (read-only health check, no deletes)
// ============================================

/**
 * Audit findings for `bun worktree audit`. Each finding describes a hygiene
 * issue, never a fix — the audit is read-only and never deletes/resets state.
 *
 * Severities:
 *   "error"  — corrupted state that blocks normal use (UU files, mid-rebase, broken submodules)
 *   "warn"   — divergence that will bite eventually (>100 commits behind, dups already on main)
 *   "info"   — drift worth knowing about (formatter-noise siblings, slot-location drift)
 */
export type AuditSeverity = "error" | "warn" | "info"

export interface AuditFinding {
  worktree: string
  branch: string
  severity: AuditSeverity
  /** Stable kebab-case id for tooling/CI to match against. */
  check: string
  message: string
  /** Optional structured payload for JSON consumers. */
  details?: Record<string, unknown>
}

interface WorktreeMeta {
  path: string
  name: string
  branch: string
  isDetached: boolean
}

async function getCommitsAhead(wtPath: string): Promise<number> {
  const r = await safeExec($`cd ${wtPath} && git rev-list --count main..HEAD 2>/dev/null`)
  return parseInt(r.stdout.trim() || "0", 10) || 0
}

async function getCommitsBehind(wtPath: string): Promise<number> {
  const r = await safeExec($`cd ${wtPath} && git rev-list --count HEAD..main 2>/dev/null`)
  return parseInt(r.stdout.trim() || "0", 10) || 0
}

async function lastCommitAgeHours(wtPath: string): Promise<number> {
  const r = await safeExec($`cd ${wtPath} && git log -1 --format=%ct HEAD 2>/dev/null`)
  const ts = parseInt(r.stdout.trim() || "0", 10)
  if (!ts) return 0
  return (Date.now() / 1000 - ts) / 3600
}

async function isMidRebaseOrMerge(wtPath: string): Promise<{ rebase: boolean; merge: boolean }> {
  // .git in a worktree is a file pointing at gitdir; resolve via git rev-parse.
  const r = await safeExec($`cd ${wtPath} && git rev-parse --git-dir 2>/dev/null`)
  const dir = r.stdout.trim()
  if (!dir) return { rebase: false, merge: false }
  const abs = dir.startsWith("/") ? dir : join(wtPath, dir)
  return {
    rebase: existsSync(join(abs, "rebase-merge")) || existsSync(join(abs, "rebase-apply")),
    merge: existsSync(join(abs, "MERGE_HEAD")),
  }
}

async function dupCommitsAlreadyOnMain(wtPath: string): Promise<number> {
  const r = await safeExec($`cd ${wtPath} && git cherry main HEAD 2>/dev/null`)
  let dups = 0
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("- ")) dups++
  }
  return dups
}

async function uniqueCommitsCount(wtPath: string): Promise<number> {
  const r = await safeExec($`cd ${wtPath} && git cherry main HEAD 2>/dev/null`)
  let unique = 0
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("+ ")) unique++
  }
  return unique
}

async function uuFiles(wtPath: string): Promise<string[]> {
  const r = await safeExec(
    $`cd ${wtPath} && git status --porcelain --untracked-files=all --ignore-submodules=none 2>/dev/null`,
  )
  return r.stdout
    .split("\n")
    .filter((l) => l.startsWith("UU ") || l.startsWith("AA ") || l.startsWith("DD "))
    .map((l) => l.slice(3))
}

async function fileSha256(p: string): Promise<string | null> {
  if (!existsSync(p)) return null
  const r = await safeExec($`shasum -a 256 ${p} 2>/dev/null`)
  return r.stdout.split(" ")[0] ?? null
}

/**
 * Canonical pool-slot path: `<poolRoot>/<repoBasename>-wtN`. With the default
 * (sibling) pool root that is the historic `<repoParent>/<repo>-wtN` layout;
 * with a configured `worktree.poolRoot` it is the contained pool (e.g.
 * `<repo>/.worktrees/<repo>-wtN`).
 *
 * Legacy slots live under `<gitRoot>/.claude/worktrees/wtN` (pre-sibling era)
 * or — once a contained pool is configured — at the old sibling location. The
 * audit flags both so they migrate as agents recycle.
 */
export function isCanonicalSlotPath(wtPath: string, gitRoot: string, poolRoot: string): boolean {
  const expectedPrefix = `${join(poolRoot, basename(gitRoot))}-wt`
  if (!wtPath.startsWith(expectedPrefix)) return false
  return /^\d+$/.test(wtPath.slice(expectedPrefix.length))
}

function isLegacySlotPath(wtPath: string, gitRoot: string): boolean {
  const legacyRoot = join(gitRoot, ".claude", "worktrees")
  if (!wtPath.startsWith(legacyRoot + "/")) return false
  return /^wt\d+$/.test(wtPath.slice(legacyRoot.length + 1))
}

/**
 * A slot sitting at the historic sibling location while the configured pool
 * root points elsewhere (i.e. a contained pool is active). Not a defect — a
 * live slot keeps working from the legacy location — but it should migrate on
 * its next recycle.
 */
function isLegacySiblingSlotPath(wtPath: string, gitRoot: string, poolRoot: string): boolean {
  const siblingParent = dirname(gitRoot)
  if (poolRoot === siblingParent) return false
  return isCanonicalSlotPath(wtPath, gitRoot, siblingParent)
}

export interface AuditOptions {
  json?: boolean
  /** Threshold (commits) — flag worktrees this far behind main. Default 100. */
  behindThreshold?: number
  /** Threshold (days) — flag stale unique-work worktrees. Default 14. */
  staleAgeDays?: number
}

/**
 * Run worktree-hygiene audit. Read-only — never writes, never resets, never
 * deletes. Returns findings (also printed unless json=true).
 */
export async function auditWorktrees(opts: AuditOptions = {}): Promise<AuditFinding[]> {
  const gitRoot = findGitRoot(process.cwd())
  if (!gitRoot) {
    error("Not in a git repository")
    process.exit(1)
  }
  const behindThreshold = opts.behindThreshold ?? 100
  const staleAgeHours = (opts.staleAgeDays ?? 14) * 24
  const poolRoot = resolvePoolRoot(gitRoot)

  const raw = await getWorktrees(gitRoot)
  const worktrees: WorktreeMeta[] = raw.map((w) => ({
    path: w.path,
    name: basename(w.path),
    branch: w.branch,
    isDetached: w.isDetached,
  }))

  const findings: AuditFinding[] = []
  const dirtyFileShas = new Map<string, Map<string, string[]>>() // file basename → sha → wts

  for (const wt of worktrees) {
    const isMain = wt.path === gitRoot
    const wtName = wt.name

    // Skip the main worktree from per-worktree drift checks (it's the target).
    if (!isMain) {
      const canonicalSlot = join(poolRoot, slotDirName(basename(gitRoot), wtName))
      if (isLegacySlotPath(wt.path, gitRoot)) {
        findings.push({
          worktree: wtName,
          branch: wt.branch,
          severity: "info",
          check: "slot-location-legacy",
          message: `legacy slot at ${wt.path} — recycle to canonical pool location ${canonicalSlot}`,
          details: { path: wt.path, canonical: canonicalSlot },
        })
      } else if (isLegacySiblingSlotPath(wt.path, gitRoot, poolRoot)) {
        findings.push({
          worktree: wtName,
          branch: wt.branch,
          severity: "info",
          check: "slot-location-legacy-sibling",
          message:
            `slot at legacy sibling location ${wt.path} — the configured pool is ${poolRoot}; ` +
            `migrate on next recycle: bun worktree remove ${wtName} && bun worktree create ${wtName}`,
          details: { path: wt.path, canonical: canonicalSlot, poolRoot },
        })
      } else if (!isCanonicalSlotPath(wt.path, gitRoot, poolRoot)) {
        findings.push({
          worktree: wtName,
          branch: wt.branch,
          severity: "info",
          check: "slot-location-drift",
          message: `worktree at non-canonical path ${wt.path} (canonical: ${join(poolRoot, `${basename(gitRoot)}-wtN`)})`,
          details: { path: wt.path, poolRoot },
        })
      }
    }

    // Detached HEAD with UU files
    const uu = await uuFiles(wt.path)
    if (uu.length > 0) {
      const sev: AuditSeverity = wt.isDetached ? "error" : "warn"
      findings.push({
        worktree: wtName,
        branch: wt.branch,
        severity: sev,
        check: wt.isDetached ? "detached-head-with-uu" : "uu-conflicts",
        message: `${uu.length} unmerged file(s)${wt.isDetached ? " on detached HEAD" : ""}: ${uu.slice(0, 3).join(", ")}${uu.length > 3 ? "..." : ""}`,
        details: { uu },
      })
    }

    // Mid-rebase / mid-merge
    const stuck = await isMidRebaseOrMerge(wt.path)
    if (stuck.rebase || stuck.merge) {
      findings.push({
        worktree: wtName,
        branch: wt.branch,
        severity: "error",
        check: "stuck-merge-state",
        message: stuck.rebase ? "mid-rebase — abort or continue before further use" : "mid-merge — resolve or abort",
        details: stuck,
      })
    }

    // Dist-only workspace packages with no dist/ — slot not vitest-ready
    for (const pkgDir of listWorkspacePackages(wt.path)) {
      if (!needsDistBuild(pkgDir)) continue
      const rel = relative(wt.path, pkgDir)
      findings.push({
        worktree: wtName,
        branch: wt.branch,
        severity: "warn",
        check: "dist-missing",
        message: `${rel} has dist-only exports but no dist/ — targeted vitest cannot load it. Fix: cd ${pkgDir} && bun run build`,
        details: { package: rel },
      })
    }

    // Vendor-resolution readiness (@km/infra/19945) — only for worktrees that
    // are SUPPOSED to run the workspace: main + pool slots (configured pool or
    // the legacy sibling location, where agents run focused vitest; wt5 was
    // the plateau). Non-canonical worktrees (chief's `--fs-only` integration
    // worktrees, ad-hoc clones) deliberately skip submodule init / install, so
    // their submodule + node_modules state is not a readiness defect —
    // flagging it is noise (they are already surfaced via slot-location-drift).
    if (
      isMain ||
      isCanonicalSlotPath(wt.path, gitRoot, poolRoot) ||
      isLegacySiblingSlotPath(wt.path, gitRoot, poolRoot)
    ) {
      // Uninitialized submodules — the ROOT CAUSE of the wt5 plateau. An empty
      // vendor/<pkg> cannot resolve through node_modules and bare imports fail
      // before code runs. Read-only.
      for (const sub of await uninitializedSubmodules(wt.path)) {
        findings.push({
          worktree: wtName,
          branch: wt.branch,
          severity: "error",
          check: "submodule-uninitialized",
          message:
            `submodule ${sub} is not initialized — its workspace package cannot resolve through node_modules ` +
            `and bare imports fail before code runs. Fix: cd ${wt.path} && bun worktree fix-submodules ${wt.path}`,
          details: { submodule: sub },
        })
      }

      // Vendor/workspace packages whose node_modules/<name> symlink is PRESENT
      // but does not resolve (dangling / empty target) — a bare `import
      // "<name>"` dies before code runs. Read-only check.
      for (const u of unresolvedWorkspaceSymlinks(wt.path)) {
        findings.push({
          worktree: wtName,
          branch: wt.branch,
          severity: "warn",
          check: "workspace-symlink-unresolved",
          message:
            `${u.name} → node_modules/${u.name} does not resolve (${u.reason}) — a bare import of ${u.name} ` +
            `fails before code runs (targeted vitest cannot load it). ` +
            `Fix: cd ${wt.path} && bun worktree fix-submodules ${wt.path} && bun install`,
          details: { package: u.packageDir, nodeModulesPath: u.nodeModulesPath, reason: u.reason },
        })
      }
    }

    if (isMain) continue

    // Branch divergence vs main
    const ahead = await getCommitsAhead(wt.path)
    const behind = await getCommitsBehind(wt.path)

    // Dup commits already on main (cherry "-")
    if (ahead > 0) {
      const dups = await dupCommitsAlreadyOnMain(wt.path)
      const unique = await uniqueCommitsCount(wt.path)
      if (dups > 0 && unique === 0) {
        findings.push({
          worktree: wtName,
          branch: wt.branch,
          severity: "warn",
          check: "duplicate-commits-on-main",
          message: `${dups} commit(s) already applied to main (cherry "-"), 0 unique. Reset to main is safe.`,
          details: { dups, unique, ahead },
        })
      }
    }

    if (behind > behindThreshold) {
      findings.push({
        worktree: wtName,
        branch: wt.branch,
        severity: "warn",
        check: "branch-stale-vs-main",
        message: `${behind} commits behind main (threshold: ${behindThreshold})`,
        details: { behind, threshold: behindThreshold },
      })
    }

    // Stale: unique work + last commit > N days ago
    const unique = await uniqueCommitsCount(wt.path)
    if (unique > 0) {
      const ageHours = await lastCommitAgeHours(wt.path)
      if (ageHours > staleAgeHours) {
        findings.push({
          worktree: wtName,
          branch: wt.branch,
          severity: "warn",
          check: "stale-unique-work",
          message: `${unique} unique commit(s), last commit ${(ageHours / 24).toFixed(1)}d ago — rebase or merge before it bitrots`,
          details: { unique, ageDays: ageHours / 24 },
        })
      }
    }

    // Track dirty files for cross-worktree formatter-noise detection
    const status = await getWorktreeStatus(wt.path)
    for (const change of status.changes) {
      // Lines look like " M apps/foo.ts" — strip the 3-char prefix
      const filePath = change.slice(3)
      if (!filePath || change.startsWith("??")) continue
      const abs = join(wt.path, filePath)
      const sha = await fileSha256(abs)
      if (!sha) continue
      const byFile = dirtyFileShas.get(filePath) ?? new Map<string, string[]>()
      const wts = byFile.get(sha) ?? []
      wts.push(wtName)
      byFile.set(sha, wts)
      dirtyFileShas.set(filePath, byFile)
    }
  }

  // Cross-worktree: same dirty file with same sha across ≥2 worktrees → formatter noise
  for (const [filePath, byFile] of dirtyFileShas) {
    for (const [sha, wts] of byFile) {
      if (wts.length >= 2) {
        for (const wtName of wts) {
          findings.push({
            worktree: wtName,
            branch: worktrees.find((w) => w.name === wtName)?.branch ?? "",
            severity: "info",
            check: "formatter-noise-sibling",
            message: `${filePath} has identical bytes (sha ${sha.slice(0, 8)}) across ${wts.length} worktrees — likely formatter run, not real WIP`,
            details: { filePath, sha, siblings: wts },
          })
        }
      }
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ gitRoot, worktrees: worktrees.length, findings }, null, 2))
    return findings
  }

  // Human-readable output
  const counts = { error: 0, warn: 0, info: 0 }
  for (const f of findings) counts[f.severity]++

  console.log(BOLD + `Worktree audit — ${gitRoot}` + RESET)
  console.log(
    DIM +
      `  ${worktrees.length} worktree(s) · ` +
      `${RED}${counts.error} error${RESET}${DIM} · ` +
      `${YELLOW}${counts.warn} warn${RESET}${DIM} · ` +
      `${CYAN}${counts.info} info${RESET}${DIM}` +
      RESET,
  )
  console.log("")

  if (findings.length === 0) {
    success("All worktrees clean.")
    return findings
  }

  const byWt = new Map<string, AuditFinding[]>()
  for (const f of findings) {
    const list = byWt.get(f.worktree) ?? []
    list.push(f)
    byWt.set(f.worktree, list)
  }

  for (const [wtName, fs] of byWt) {
    const wt = worktrees.find((w) => w.name === wtName)
    const branch = wt ? formatBranchColor(wt) : wtName
    console.log(`  ${BOLD}${wtName}${RESET}  ${DIM}(${branch})${RESET}`)
    for (const f of fs) {
      const tag =
        f.severity === "error" ? RED + "✗" + RESET : f.severity === "warn" ? YELLOW + "⚠" + RESET : CYAN + "ℹ" + RESET
      console.log(`    ${tag} ${DIM}[${f.check}]${RESET} ${f.message}`)
    }
  }
  console.log("")
  if (counts.error > 0) {
    console.log(DIM + "Recovery: stuck rebases → `git rebase --abort` in the worktree." + RESET)
  }
  if (counts.warn > 0) {
    console.log(
      DIM + "Cleanup: branches with only `-` commits can be reset to main: `git reset --hard origin/main`." + RESET,
    )
  }

  return findings
}

// ============================================
// Commands
// ============================================

export interface CreateOptions {
  install?: boolean
  direnv?: boolean
  hooks?: boolean
  allowDirty?: boolean // Skip uncommitted changes check
  /**
   * Explicit base ref for a NEW branch / pool slot (`--base <ref>`). Skips the
   * default fetch-then-`origin/main` base resolution — the offline / deliberate
   * escape hatch. Ignored-with-a-loud-error when the target branch already
   * exists (the branch's own tip is the base then; a silently dropped flag
   * would be a silent error).
   */
  base?: string
}

async function checkUncommittedChanges(gitRoot: string, submodules: string[]): Promise<void> {
  info("Checking for uncommitted changes...")
  const issues: string[] = []

  // Check main repo
  const mainStatus = await getWorktreeStatus(gitRoot)
  if (mainStatus.dirty) {
    issues.push(`Main repo has ${mainStatus.changes.length} uncommitted change(s)`)
    for (const change of mainStatus.changes.slice(0, 3)) {
      issues.push(DIM + `    ${change}` + RESET)
    }
    if (mainStatus.changes.length > 3) {
      issues.push(DIM + `    ... and ${mainStatus.changes.length - 3} more` + RESET)
    }
  }

  // Check submodules for uncommitted changes
  for (const submodule of submodules) {
    const subPath = join(gitRoot, submodule)
    if (!existsSync(join(subPath, ".git"))) continue

    const subStatus = await getWorktreeStatus(subPath)
    if (subStatus.dirty) {
      issues.push(`Submodule ${submodule} has ${subStatus.changes.length} uncommitted change(s)`)
    }
  }

  if (issues.length > 0) {
    error("Cannot create worktree - uncommitted changes detected:")
    console.log("")
    for (const issue of issues) {
      console.log(YELLOW + "  " + issue + RESET)
    }
    console.log("")
    console.log("The new worktree would not include these uncommitted changes,")
    console.log("which could lead to confusion about what code is where.")
    console.log("")
    console.log("Options:")
    console.log(CYAN + "  1. Commit your changes first" + RESET)
    console.log(CYAN + "  2. Use --allow-dirty to create anyway — these MAIN-repo" + RESET)
    console.log(CYAN + "     changes stay in main; the new slot just starts without them" + RESET)
    process.exit(1)
  }
  success("Working tree is clean")
}

async function checkUnpushedSubmodules(gitRoot: string, submodules: string[]): Promise<void> {
  info("Checking submodule commits are pushed...")
  const unpushed: string[] = []

  for (const submodule of submodules) {
    const subPath = join(gitRoot, submodule)
    if (!existsSync(join(subPath, ".git"))) continue

    const lsTree = await $`cd ${gitRoot} && git ls-tree HEAD ${submodule}`.quiet()
    const expectedCommit = lsTree.stdout.toString().split(/\s+/)[2]

    if (expectedCommit && !(await commitExistsOnRemote(subPath, expectedCommit))) {
      unpushed.push(`  - ${submodule} (${expectedCommit.slice(0, 8)})`)
    }
  }

  if (unpushed.length > 0) {
    error("Found unpushed submodule commits:")
    for (const line of unpushed) {
      console.log(YELLOW + line + RESET)
    }
    console.log("")
    console.log("Push submodules first:")
    console.log(CYAN + '  git submodule foreach "git push origin HEAD || true"' + RESET)
    process.exit(1)
  }
  success("Submodules OK")
}

//
// Find and kill `dolt sql-server` processes whose cwd is inside the given
// worktree path.
//
// Why this exists: when a worktree has its own .beads/, bd spawns a
// `dolt sql-server` daemon that reparents to launchd (PID 1) and survives
// beyond the session that started it. Git `worktree remove` doesn't know
// about these daemons, so they accumulate — after a few days of agent
// activity, `ps aux | grep 'dolt sql-server'` shows 9+ processes, most
// with cwds pointing at long-deleted .claude/worktrees/agent-<id>/.beads
// subpaths. These zombies contribute to .git/index.lock contention (shared
// git store across worktrees) and flood the tribe health monitor with
// lock warnings that name already-dead PIDs.
//
// Fix: before `git worktree remove` tears down the filesystem, find any
// `dolt sql-server` whose cwd is inside the worktree path and kill it.
// SIGTERM first, SIGKILL after a short grace period for stragglers.
//
async function killWorktreeDoltServers(worktreePath: string): Promise<number> {
  const normalized = worktreePath.endsWith("/") ? worktreePath : `${worktreePath}/`

  const pgrep = await safeExec($`pgrep -f "dolt sql-server"`.quiet())
  if (pgrep.exitCode !== 0) return 0
  const pids = pgrep.stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => parseInt(p, 10))
    .filter((p) => !Number.isNaN(p))
  if (pids.length === 0) return 0

  const toKill: number[] = []
  for (const pid of pids) {
    const cwd = await safeExec($`lsof -p ${pid} -a -d cwd 2>/dev/null`.quiet())
    if (cwd.exitCode !== 0) continue
    if (cwd.stdout.includes(normalized)) toKill.push(pid)
  }
  if (toKill.length === 0) return 0

  for (const pid of toKill) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      // already gone / permission — ignore
    }
  }

  // Grace period, then escalate to SIGKILL for any survivor
  await Bun.sleep(1500)
  for (const pid of toKill) {
    try {
      process.kill(pid, 0) // probe; throws if dead
      process.kill(pid, "SIGKILL")
    } catch {
      // probe failed = already dead, which is the goal
    }
  }

  return toKill.length
}

export interface DependencyInstallPlan {
  readonly command: "bun" | "npm"
  readonly args: readonly string[]
}

export interface InstallDependenciesDeps {
  readonly run?: (
    cwd: string,
    command: DependencyInstallPlan["command"],
    args: readonly string[],
  ) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>
}

export function dependencyInstallPlan(worktreePath: string): DependencyInstallPlan | null {
  const hasBunLock = existsSync(join(worktreePath, "bun.lockb")) || existsSync(join(worktreePath, "bun.lock"))
  const hasPackageJson = existsSync(join(worktreePath, "package.json"))
  if (!hasPackageJson) return null
  if (hasBunLock) return { command: "bun", args: ["install", "--frozen-lockfile"] }
  if (existsSync(join(worktreePath, "package-lock.json"))) return { command: "npm", args: ["ci"] }
  return null
}

async function runDependencyInstall(
  worktreePath: string,
  command: DependencyInstallPlan["command"],
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await safeExec($`cd ${worktreePath} && ${command} ${args} 2>&1`)
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: "" }
}

export async function installDependencies(worktreePath: string, deps: InstallDependenciesDeps = {}): Promise<void> {
  const plan = dependencyInstallPlan(worktreePath)

  if (plan !== null) {
    const display = `${plan.command} ${plan.args.join(" ")}`
    info(`Running ${display}...`)
    const result = await (deps.run ?? runDependencyInstall)(worktreePath, plan.command, plan.args)
    if (result.exitCode !== 0) {
      throw new Error(`${display} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`)
    }
    success("Dependencies installed")
  }

  // bun install hoists workspace packages to root node_modules only when
  // a non-workspace package transitively depends on them. Workspace packages
  // depended on only by other workspace packages can end up nested-only
  // (e.g. vendor/silvery/packages/ag-react/node_modules/@silvery/ag exists,
  // but <root>/node_modules/@silvery/ag is missing). Tests that import
  // @silvery/ag from outside that ag-react subtree fail with
  // "Cannot find package '@silvery/ag'". km-bearly.worktree-create-silvery-symlinks.
  // The fix: after bun install, walk every workspace glob in the root
  // package.json, and for each workspace package whose root-level symlink
  // is missing, create it. Idempotent — existing symlinks are left alone.
  ensureWorkspaceSymlinks(worktreePath)

  // Workspace packages with dist-only exports are unloadable until built —
  // a fresh clone has no dist/, so the first targeted test run dies in
  // module resolution. Build them now so the slot is usable immediately.
  await buildMissingDistPackages(worktreePath)
}

/**
 * Read root package.json's `workspaces` array (if any), expand each glob
 * pattern (only trailing `/*` is supported — the only form km uses), and
 * return absolute paths to every workspace package directory.
 */
function listWorkspacePackages(rootPath: string): string[] {
  const pkgPath = join(rootPath, "package.json")
  if (!existsSync(pkgPath)) return []
  let pkg: { workspaces?: string[] | { packages?: string[] } }
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { workspaces?: string[] | { packages?: string[] } }
  } catch {
    // silent-fallback-allow: malformed package.json disables optional workspace symlink repair only.
    return []
  }
  const globs = Array.isArray(pkg.workspaces)
    ? pkg.workspaces
    : Array.isArray(pkg.workspaces?.packages)
      ? pkg.workspaces.packages
      : []
  const out: string[] = []
  for (const glob of globs) {
    if (!glob.endsWith("/*")) continue
    const parent = join(rootPath, glob.slice(0, -2))
    if (!existsSync(parent)) continue
    let entries: string[]
    try {
      entries = readdirSync(parent)
    } catch {
      continue
    }
    for (const e of entries) {
      const dir = join(parent, e)
      if (existsSync(join(dir, "package.json"))) out.push(dir)
    }
  }
  return out
}

/** Collect every string leaf of a package.json `exports` value. */
function exportLeaves(exports: unknown): string[] {
  if (typeof exports === "string") return [exports]
  if (exports && typeof exports === "object") {
    return Object.values(exports as Record<string, unknown>).flatMap(exportLeaves)
  }
  return []
}

/**
 * A workspace package whose `exports` resolve ONLY into `./dist/` cannot be
 * imported (by Vitest, Bun, or Node) until its build runs — unlike src-first
 * packages whose exports point at `./src/*.ts`. A fresh worktree has no
 * dist/, so targeted test runs fail in module resolution until someone
 * repairs the slot by hand. True when exports are dist-only, a `build`
 * script exists to produce dist/, and dist/ is currently absent.
 */
export function needsDistBuild(pkgDir: string): boolean {
  const pkgPath = join(pkgDir, "package.json")
  if (!existsSync(pkgPath)) return false
  let pkg: { exports?: unknown; scripts?: Record<string, string> }
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as typeof pkg
  } catch {
    // silent-fallback-allow: malformed package.json disables optional dist-build repair only.
    return false
  }
  const leaves = exportLeaves(pkg.exports)
  if (leaves.length === 0 || !leaves.every((l) => l.startsWith("./dist/"))) return false
  if (!pkg.scripts?.build) return false
  return !existsSync(join(pkgDir, "dist"))
}

/**
 * Build every workspace package `needsDistBuild` flags, so a fresh slot is
 * immediately loadable by targeted Vitest runs. Loud on failure (never
 * silent) but non-fatal — same contract as the bun-install step above.
 */
export async function buildMissingDistPackages(worktreePath: string): Promise<void> {
  for (const pkgDir of listWorkspacePackages(worktreePath)) {
    if (!needsDistBuild(pkgDir)) continue
    const rel = relative(worktreePath, pkgDir)
    info(`Building ${rel}/dist (dist-only exports, dist/ missing)...`)
    const result = await safeExec($`cd ${pkgDir} && bun run build`)
    if (result.exitCode !== 0) {
      warn(`dist build FAILED for ${rel} — targeted vitest cannot load it. Repair: cd ${pkgDir} && bun run build`)
    } else {
      success(`Built ${rel}/dist`)
    }
  }
}

/**
 * For every workspace package, ensure <root>/node_modules/<package-name>
 * is a symlink to the package directory. Skip packages that already have
 * an entry (file, dir, or symlink) at that location — bun's existing
 * choices are preserved. Created symlinks are relative so the worktree
 * stays self-contained.
 */
function ensureWorkspaceSymlinks(rootPath: string): void {
  const pkgs = listWorkspacePackages(rootPath)
  if (pkgs.length === 0) return
  const nodeModules = join(rootPath, "node_modules")
  let linked = 0
  for (const pkgDir of pkgs) {
    let manifest: { name?: string; private?: boolean }
    try {
      manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8")) as {
        name?: string
        private?: boolean
      }
    } catch {
      continue
    }
    if (!manifest.name) continue
    const linkPath = join(nodeModules, manifest.name)
    // existsSync follows symlinks; if the target is missing it returns false
    // even when the symlink itself is present. Use a stat probe instead so
    // we don't clobber a broken-but-present symlink (those are bun's choice
    // to flag missing deps, not ours to repair).
    try {
      readdirSync(dirname(linkPath))
    } catch {
      mkdirSync(dirname(linkPath), { recursive: true })
    }
    let alreadyPresent = false
    try {
      // statSync would throw on missing target; readdirSync of the parent
      // and entry-name check is the cheapest probe that doesn't follow.
      const parentEntries = readdirSync(dirname(linkPath))
      alreadyPresent = parentEntries.includes(basename(linkPath))
    } catch {
      alreadyPresent = false
    }
    if (alreadyPresent) continue
    const target = relative(dirname(linkPath), pkgDir)
    try {
      symlinkSync(target, linkPath)
      linked++
    } catch {
      // Race with concurrent install or filesystem issue — log but keep going.
      warn(`failed to symlink ${manifest.name} → ${target}`)
    }
  }
  if (linked > 0) info(`Ensured ${linked} workspace symlink(s) in node_modules`)
}

/** Why a workspace package's `node_modules/<name>` entry fails to resolve. */
export type UnresolvedSymlinkReason = "missing" | "dangling" | "no-manifest"

export interface UnresolvedWorkspaceSymlink {
  /** package.json `name` of the workspace package. */
  name: string
  /** Workspace package directory, relative to the worktree root. */
  packageDir: string
  /** Expected `node_modules` entry, relative to the worktree root. */
  nodeModulesPath: string
  reason: UnresolvedSymlinkReason
}

/**
 * Classify a single expected `node_modules/<name>` entry. Null = resolves
 * (the entry exists, follows to a directory, and that directory has a
 * package.json). Otherwise the reason it does not resolve.
 *
 *   "missing"     no entry at all (symlink absent)
 *   "dangling"    a symlink whose target does not exist
 *   "no-manifest" an entry resolves but has no package.json — the uninitialized
 *                 submodule case (the symlink points at an EMPTY vendor/<pkg>
 *                 dir because `git submodule update --init` has not run)
 */
export function classifyWorkspaceSymlink(linkPath: string): UnresolvedSymlinkReason | null {
  // lstat does NOT follow symlinks: it answers "is there an entry here at all?"
  try {
    lstatSync(linkPath)
  } catch {
    return "missing"
  }
  // stat DOES follow symlinks: a throw means the symlink target is absent.
  let resolved: ReturnType<typeof statSync>
  try {
    resolved = statSync(linkPath)
  } catch {
    return "dangling"
  }
  if (!resolved.isDirectory()) return "no-manifest"
  // A bare `import "<name>"` resolves through the target's package.json; an
  // empty (uninitialized submodule) target dir has none → import fails.
  return existsSync(join(linkPath, "package.json")) ? null : "no-manifest"
}

/**
 * Workspace packages whose `node_modules/<name>` symlink is PRESENT but does
 * NOT resolve to a directory with a package.json — so a bare `import "<name>"`
 * throws before any code runs. This is the wt5 plateau (2026-06-15):
 * `vendor/mdspec` was uninitialized after a frozen install ran before `git
 * submodule update --init`, so `node_modules/mdspec` pointed at an empty
 * submodule dir and focused Vitest died in module resolution.
 * `ensureWorkspaceSymlinks` deliberately leaves a broken-but-present symlink
 * alone, and the audit never verified resolution — this read-only verifier
 * closes that gap. Never repairs.
 *
 * Scope is deliberately PRESENT-BUT-BROKEN, not "missing". A wholly-absent root
 * entry is NOT a reliable bug signal: bun only hoists a workspace package to
 * the root `node_modules` when something resolves it there, so a healthy
 * worktree legitimately lacks root entries for nested-resolved or unimported
 * packages (verified 2026-06-15: 9 such packages in a healthy km slot, several
 * of them declared dependencies, while the actually-broken `mdspec` is not a
 * declared dependency at all). A symlink that EXISTS but dangles was wired up
 * and then broke — that is unambiguous and false-positive-free.
 */
export function unresolvedWorkspaceSymlinks(rootPath: string): UnresolvedWorkspaceSymlink[] {
  const out: UnresolvedWorkspaceSymlink[] = []
  const nodeModules = join(rootPath, "node_modules")
  for (const pkgDir of listWorkspacePackages(rootPath)) {
    let name: string | undefined
    try {
      name = (JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8")) as { name?: string }).name
    } catch {
      // silent-fallback-allow: malformed package.json is the dist-build check's
      // concern; an unreadable manifest cannot be name-resolved here, so skip it.
      continue
    }
    if (!name) continue
    const linkPath = join(nodeModules, name)
    const reason = classifyWorkspaceSymlink(linkPath)
    // "missing" is excluded — see the doc comment (not a reliable bug signal).
    if (reason === "dangling" || reason === "no-manifest") {
      out.push({
        name,
        packageDir: relative(rootPath, pkgDir),
        nodeModulesPath: relative(rootPath, linkPath),
        reason,
      })
    }
  }
  return out
}

/**
 * Submodule paths reported as UNINITIALIZED by `git submodule status` (a `-`
 * prefix). An uninitialized vendor submodule is the ROOT CAUSE of the wt5
 * plateau: until `git submodule update --init` runs, `vendor/<pkg>` is empty,
 * so neither node_modules resolution nor a bare `import "<pkg>"` can work and
 * focused Vitest dies before any code runs. Pure parser — fixture-testable.
 *
 * `git submodule status` line shape (one of):
 *   ` <sha> vendor/foo (v1.2.3)`   initialized, at the recorded commit
 *   `+<sha> vendor/foo (v1.2.3-2)` initialized, at a DIFFERENT commit
 *   `-<sha> vendor/foo`            NOT initialized  ← the one we flag
 *   `U<sha> vendor/foo`            merge conflicts in the submodule
 */
export function parseUninitializedSubmodules(statusOutput: string): string[] {
  const out: string[] = []
  for (const raw of statusOutput.split("\n")) {
    if (raw[0] !== "-") continue
    // "-<sha> <path>" — drop the leading marker, then path is the 2nd field.
    const path = raw.slice(1).trim().split(/\s+/)[1]
    if (path) out.push(path)
  }
  return out
}

async function uninitializedSubmodules(wtPath: string): Promise<string[]> {
  const r = await safeExec($`cd ${wtPath} && git submodule status 2>/dev/null`)
  return parseUninitializedSubmodules(r.stdout)
}

async function allowDirenv(worktreePath: string): Promise<void> {
  if (!existsSync(join(worktreePath, ".envrc"))) return
  info("Allowing direnv...")
  const result = await safeExec($`direnv allow ${worktreePath} 2>/dev/null`)
  if (result.exitCode === 0) success("Direnv allowed")
  else console.log(DIM + "  (direnv not available)" + RESET)
}

async function installHooks(worktreePath: string): Promise<void> {
  if (!existsSync(join(worktreePath, "package.json"))) return
  try {
    const pkg = (await Bun.file(join(worktreePath, "package.json")).json()) as {
      scripts?: { prepare?: string }
    }
    if (pkg.scripts?.prepare) {
      info("Installing hooks...")
      await safeExec($`cd ${worktreePath} && bun run prepare 2>/dev/null`)
      success("Hooks installed")
    }
  } catch {
    // Ignore
  }
}

/**
 * Pick the `git worktree add` branch argument. A pool-slot branch (wtN) is an
 * anonymous, disposable pool resource: on (re)create it must ALWAYS land at
 * origin/main — even when a stale LOCAL wtN branch survives a prior cycle. When
 * the slot last ran a `task/<id>` branch, `bun worktree reset wtN` removes that
 * task branch but leaves the old `wtN` ref pinned at an ancient SHA; reusing it
 * via `branchExists` would silently land the slot N-behind origin/main
 * (@km/inbox/19363). `-B` resets-or-creates `wtN` AT origin/main, so the
 * pool-slot rule MUST precede the branch-exists check. Non-slot names keep
 * tracking their stable upstream.
 *
 * `base` is the START POINT for any branch this call CUTS (pool-slot `-B` and
 * brand-new `-b`): the fetched `origin/main` by default, or the operator's
 * explicit `--base <ref>`. A brand-new branch with NO start point would be cut
 * from the invoking repo's HEAD — the stale-LOCAL-main birth defect
 * (worktree-base-origin-main: `hh-adhoc1` born 226 commits behind). Branches
 * that already exist (local or remote-tracking) keep their own tip; `base`
 * does not apply to them.
 */
export function resolveBranchArg(input: {
  isPoolSlot: boolean
  branchExists: boolean
  remoteBranchExists: boolean
  branchName: string
  base: string
}): string[] {
  if (input.isPoolSlot) return ["-B", input.branchName, input.base]
  if (input.branchExists) return [input.branchName]
  if (input.remoteBranchExists) return [input.branchName]
  return ["-b", input.branchName, input.base]
}

/**
 * Resolve the start point for a branch this create will CUT (pool slot `-B` /
 * brand-new `-b`) — worktree-base-origin-main.
 *
 * Default: `git fetch origin main` FIRST (`--no-recurse-submodules` — only the
 * superproject ref gates base freshness; submodules are fetched on demand by
 * `submodule update --init` later), then base on the freshly-updated
 * `refs/remotes/origin/main`. A failed fetch is FATAL: silently proceeding on
 * the cached remote-tracking ref (or worse, local HEAD) would re-open the
 * born-stale defect this exists to close (`hh-adhoc1` born 226 commits behind;
 * NO SILENT ERRORS). Offline / deliberate re-basing passes `--base <ref>`,
 * which skips the fetch and uses that ref verbatim. Either way the chosen ref
 * must resolve to a commit — fail loud, never fall back to a stale local ref.
 */
async function resolveCreateBase(gitRoot: string, explicitBase: string | undefined): Promise<string> {
  const preparedBase = explicitBase ?? process.env[PREPARED_BASE_SHA_ENV]
  if (preparedBase === undefined) {
    info("Fetching origin main (fresh base for the new branch)...")
    const fetched = await safeExec($`cd ${gitRoot} && git fetch --no-recurse-submodules origin main 2>&1`)
    if (fetched.exitCode !== 0) {
      error("`git fetch origin main` failed — refusing to cut a new branch from a possibly-stale ref:")
      console.log((fetched.stdout ?? "").trim())
      console.log(CYAN + "  Offline? Pass an explicit base: bun worktree create <name> --base <ref>" + RESET)
      process.exit(1)
    }
  }
  const base = preparedBase ?? "refs/remotes/origin/main"
  const resolved = await safeExec($`cd ${gitRoot} && git rev-parse --verify --quiet ${base}^{commit} 2>/dev/null`)
  if (resolved.exitCode !== 0 || resolved.stdout.trim() === "") {
    error(`Base ref does not resolve to a commit: ${base}`)
    console.log(CYAN + "  A new branch is never silently based on local HEAD (worktree-base-origin-main)." + RESET)
    console.log(CYAN + "  Check the remote, or pass an explicit base: bun worktree create <name> --base <ref>" + RESET)
    process.exit(1)
  }
  return base
}

export async function createWorktree(name: string, branch?: string, options: CreateOptions = {}): Promise<void> {
  assertValidWorktreeName(name)
  const { install = true, direnv = true, hooks = true, allowDirty = false, base: explicitBase } = options

  const gitRoot = findGitRoot(process.cwd())
  if (!gitRoot) {
    error("Not in a git repository")
    process.exit(1)
  }

  // Pool cap enforcement (km-tribe.worktree-pool-cap-lru, pillar C).
  // Pool slots are wt0..wt(POOL_CAP-1). Refuse creation beyond cap unless the
  // caller passes an out-of-pool name (feat/*, named scratch worktrees). When
  // at-or-over cap, list the currently-claimed slots so the operator can pick
  // a free one or wait for a release.
  const poolMatch = /^wt(\d+)$/.exec(name)
  if (poolMatch) {
    const slotN = Number(poolMatch[1])
    const POOL_CAP = 10
    if (slotN >= POOL_CAP) {
      error(`Pool slot wt${slotN} exceeds cap (${POOL_CAP} slots: wt0..wt${POOL_CAP - 1})`)
      console.log("")
      console.log(DIM + "  Canonical pool slots are wt0..wt9. Use one of those." + RESET)
      console.log(DIM + "  For scratch worktrees, pick a non-pool name: bun worktree create my-feature" + RESET)
      process.exit(1)
    }
  }

  const repoName = basename(gitRoot)
  const poolRoot = resolvePoolRoot(gitRoot)
  const worktreePath = join(poolRoot, slotDirName(repoName, name))
  // Slot-pattern names (wt0, wt1, ..., wt9) get a plain branch matching the
  // slot id — agents lease `@agent/N` and expect branch `wtN`. Other names
  // get the `feat/` prefix as a courtesy.
  const branchName = branch ?? (/^wt\d+$/.test(name) ? name : `feat/${name}`)

  // Check if the slot already exists — in ANY pool location. Creating a
  // contained slot while its legacy sibling twin is still live would split the
  // slot's identity across two checkouts (two `wt3` dirs, one branch).
  for (const candidate of slotPathCandidates(gitRoot, name, poolRoot)) {
    if (existsSync(candidate)) {
      error(`Directory already exists: ${candidate}`)
      if (candidate !== worktreePath) {
        console.log(
          DIM +
            `  (legacy location — the configured pool is ${poolRoot}; migrate with: ` +
            `bun worktree remove ${name} && bun worktree create ${name})` +
            RESET,
        )
      }
      process.exit(1)
    }
  }

  // A contained pool (inside the repo working tree) MUST be git-ignored:
  // otherwise every slot pollutes `git status` and the next create refuses on
  // "uncommitted changes". Fail loud with the exact fix — never create a slot
  // that dirties the repo. The pool dir itself is created up front so
  // check-ignore evaluates the real path.
  if (worktreePath.startsWith(gitRoot + "/")) {
    mkdirSync(poolRoot, { recursive: true })
    const ignored = await safeExec($`cd ${gitRoot} && git check-ignore -q ${poolRoot}`)
    if (ignored.exitCode !== 0) {
      error(`Contained pool root ${poolRoot} is not git-ignored.`)
      console.log(CYAN + `  Add "${relative(gitRoot, poolRoot)}/" to ${join(gitRoot, ".gitignore")} and retry.` + RESET)
      process.exit(1)
    }
  }

  // Get submodules list (used in multiple checks)
  const submodules = getSubmodulePaths(gitRoot)

  // Check for uncommitted changes in main repo and submodules
  if (!allowDirty) {
    await checkUncommittedChanges(gitRoot, submodules)
  }

  // Check for unpushed submodule commits
  await checkUnpushedSubmodules(gitRoot, submodules)

  // Warn about existing worktrees
  const existingWorktrees = await getWorktrees(gitRoot)
  const otherWorktrees = existingWorktrees.filter((wt) => wt.path !== gitRoot)
  if (otherWorktrees.length > 0) {
    console.log("")
    warn(`${otherWorktrees.length} existing worktree(s):`)
    for (const wt of otherWorktrees) {
      const wtName = basename(wt.path)
      const behindResult = await safeExec($`cd ${wt.path} && git rev-list HEAD..main --count 2>/dev/null`)
      const behind = parseInt(behindResult.stdout.trim(), 10) || 0
      const behindStr = behind > 0 ? YELLOW + `(${behind} behind main)` + RESET : GREEN + "(up to date)" + RESET
      console.log(`  ${wtName.padEnd(22)} ${DIM}${wt.branch.padEnd(22)}${RESET} ${behindStr}`)
    }
    console.log("")
    console.log(DIM + `  Consider cleaning up stale worktrees with: bun worktree remove <name>` + RESET)
    console.log("")
  }

  // Check if branch exists
  const branchExists = await safeExec($`cd ${gitRoot} && git show-ref --verify refs/heads/${branchName} 2>/dev/null`)
  const remoteBranchExists = await safeExec(
    $`cd ${gitRoot} && git show-ref --verify refs/remotes/origin/${branchName} 2>/dev/null`,
  )

  // Slot-pattern names (wtN, where the branch is also `wtN`) are anonymous
  // pool resources, not stable shared branches. A `bun worktree reset` cycle
  // removes the local branch + recreates the slot — if origin/wtN happens to
  // carry stale ahead commits from a prior agent's push, the recreate must
  // start fresh at origin/main, not inherit that state. Without this gate the
  // reset silently lands at the pre-reset SHA (`@km/all/bun-worktree-reset-
  // silent-no-op`). Non-slot names keep the original behavior — they ARE
  // tracking a stable upstream.
  const isPoolSlot = /^wt\d+$/.test(name) && branchName === name

  // Base-ref freshness (worktree-base-origin-main): any branch this create
  // CUTS is based on a freshly-fetched origin/main (or the explicit --base
  // escape hatch) — never on local HEAD / a stale cached ref. Resolved BEFORE
  // preserveAheadBranchRef below so the ahead-of-origin/main preserve check
  // also sees the fresh tip.
  const cutsNewBranch = isPoolSlot || (branchExists.exitCode !== 0 && remoteBranchExists.exitCode !== 0)
  if (explicitBase !== undefined && !cutsNewBranch) {
    error(
      `--base ${explicitBase} conflicts with existing branch ${branchName} — checking out an existing branch keeps that branch's tip.`,
    )
    console.log(CYAN + "  Drop --base to track the existing branch, or pick a new branch name." + RESET)
    process.exit(1)
  }
  const base = cutsNewBranch ? await resolveCreateBase(gitRoot, explicitBase) : "refs/remotes/origin/main"

  const branchArg = resolveBranchArg({
    isPoolSlot,
    branchExists: branchExists.exitCode === 0,
    remoteBranchExists: remoteBranchExists.exitCode === 0,
    branchName,
    base,
  })
  if (isPoolSlot) {
    // -B resets-or-creates the slot branch at the fresh base, even over a stale
    // local wtN ref left by a prior task/<id> cycle (@km/inbox/19363).
    info(`Creating slot branch ${branchName} at ${base} (reset-or-create)`)
  } else if (branchExists.exitCode === 0) {
    info(`Using existing branch: ${branchName}`)
  } else if (remoteBranchExists.exitCode === 0) {
    info(`Tracking remote branch: origin/${branchName}`)
  } else {
    info(`Creating new branch: ${branchName} at ${base}`)
  }

  // PRESERVE-FIRST (L5): a pool slot recreated over a stale local `wtN` branch
  // that is ahead of origin/main would lose those commits to the `-B ...
  // origin/main` reset below. Snapshot them to a durable `wip/…` ref first. (The
  // dirty-worktree case can't reach here — create refuses on an existing dir —
  // so removeWorktree owns that; this closes the orphan-ahead-branch gap.)
  if (isPoolSlot && branchExists.exitCode === 0) {
    await preserveAheadBranchRef(gitRoot, branchName, name)
  }

  // Create worktree
  // Note: git worktree add has no --recurse-submodules flag (as of git 2.53);
  // we init submodules explicitly below. Each init creates an isolated clone
  // under .git/worktrees/<name>/modules/<submodule>/ so worktrees can't
  // collide in each other's vendor/ trees.
  info(`Creating worktree at ${worktreePath}...`)
  const wtResult = await safeExec(
    $`cd ${gitRoot} && git worktree add ${worktreePath} ${branchArg}`.env(worktreeAddEnvironment()),
  )
  if (wtResult.exitCode !== 0) {
    error("Failed to create worktree")
    console.log(wtResult.stdout)
    process.exit(1)
  }
  success("Worktree created")

  // Initialize submodules (per-worktree isolated checkouts). Borrow objects from
  // the matching main-worktree checkout BEFORE clone; the slot keeps its own
  // refs/config/worktree while avoiding a private history download.
  if (submodules.length > 0) {
    info(`Initializing ${submodules.length} submodule(s) (isolated refs, local shared objects)...`)
    const subResult = await materializeSubmodulesFromLocalWorktreeParallel({
      worktree: worktreePath,
      referenceWorktree: gitRoot,
    })
    if (subResult.exitCode !== 0) {
      error("Failed to initialize submodules:")
      console.log(subResult.stderr || subResult.stdout)
      // Clean up
      await $`git worktree remove ${worktreePath} --force`.quiet()
      process.exit(1)
    }
    // Verify isolation — each submodule's .git should point at per-worktree modules dir
    const modulesDir = await getWorktreeModulesDir(gitRoot, basename(worktreePath))
    if (modulesDir && existsSync(modulesDir)) {
      success(`Submodules initialized (isolated; ${subResult.borrowed} local store(s) borrowed)`)
      console.log(DIM + `    ${modulesDir}` + RESET)
    } else {
      success("Submodules initialized")
    }
  }

  // Run package manager install
  if (install) await installDependencies(worktreePath)

  // Allow direnv
  if (direnv) await allowDirenv(worktreePath)

  // Run prepare script for hooks
  if (hooks) await installHooks(worktreePath)

  console.log("")
  success(`Worktree ready: ${worktreePath}`)
  console.log("")
  console.log("Next steps:")
  console.log(CYAN + `  cd ${worktreePath}` + RESET)
  console.log("")
  console.log("To remove later:")
  console.log(CYAN + `  bun worktree remove ${name}` + RESET)
}

// ============================================================================
// Preserve-first — no destructive worktree op discards uncommitted/ahead work
// ============================================================================
//
// The plateau L5 invariant: before ANY destructive slot step (force-remove,
// `-B <slot> origin/main` branch reset, checkout-over), a slot's uncommitted
// working-tree changes (INCLUDING dirt inside a submodule) and its
// ahead-of-origin/main commits are snapshotted to a durable
// `wip/<slot>-preserve-<UTCstamp>` ref, printed loudly, and appended to a
// durable `.git` log line. The snapshot is built from a TEMPORARY index — never
// `git stash`, so the caller's real index/worktree are untouched. Submodule dirt
// is transferred into the MAIN submodule store so it survives the per-worktree
// isolated-store teardown that `removeWorktree` performs — the 21102 loss class,
// where the uncommitted work lived only inside `vendor/silvery`.
//
// There is NO flag that discards. `--force` / `--allow-dirty` mean "don't BLOCK
// on dirt — preserve automatically and continue", never "throw the work away".

export interface PreservedSubmodule {
  path: string
  ref: string
  sha: string
}

export interface PreserveResult {
  preserved: boolean
  ref?: string
  sha?: string
  reason?: "dirty" | "ahead" | "dirty+ahead"
  submodules: PreservedSubmodule[]
}

/** UTC stamp safe as a ref component: `YYYYMMDDTHHMMSSZ`. */
export function preserveStamp(now: Date = new Date()): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
}

// Deterministic identity for preserve/rescue commits — so `commit-tree` never
// fails on a machine without a configured git user (fresh clone / CI).
const PRESERVE_IDENT = ["-c", "user.name=worktree-preserve", "-c", "user.email=preserve@localhost"]

async function resolveGitCommonDir(gitRoot: string): Promise<string> {
  const r = await safeExec($`cd ${gitRoot} && git rev-parse --git-common-dir`)
  let d = r.stdout.trim()
  if (!d) return join(gitRoot, ".git")
  if (!isAbsolute(d)) d = join(gitRoot, d)
  return d
}

async function appendPreserveLog(gitRoot: string, line: string): Promise<void> {
  try {
    const dir = await resolveGitCommonDir(gitRoot)
    appendFileSync(join(dir, "worktree-preserve.log"), line + "\n")
  } catch (e) {
    // Loud, not silent (§ Fail Loud): the ref + commit ARE the durable record;
    // this log is only a convenience index. Surface a broken log, never swallow.
    warn(`preserve: could not append durable log line: ${(e as Error).message}`)
  }
}

/**
 * Snapshot a repo's current index+worktree (all tracked-modified + untracked +
 * deletions) into a commit parented at HEAD, WITHOUT touching the repo's real
 * index. Uses a throwaway index seeded from HEAD. Never uses `git stash`.
 * `gitlinkOverrides` repoints named submodule gitlinks — the superproject
 * snapshot uses it to reference each dirty submodule's own preserve commit.
 * Returns the new commit SHA (written to the shared object store).
 */
async function snapshotDirtyRepo(
  repoPath: string,
  message: string,
  gitlinkOverrides?: Map<string, string>,
): Promise<string> {
  const tmpDir = mkdtempSync(join(tmpdir(), "wt-preserve-idx-"))
  const idxEnv = { ...process.env, GIT_INDEX_FILE: join(tmpDir, "index") }
  try {
    const seed = await safeExec($`cd ${repoPath} && git read-tree HEAD 2>&1`.env(idxEnv))
    if (seed.exitCode !== 0) throw new Error(`preserve: read-tree HEAD failed in ${repoPath}: ${seed.stdout}`)
    const add = await safeExec($`cd ${repoPath} && git add -A 2>&1`.env(idxEnv))
    if (add.exitCode !== 0) throw new Error(`preserve: add -A failed in ${repoPath}: ${add.stdout}`)
    if (gitlinkOverrides) {
      for (const [sub, subSha] of gitlinkOverrides) {
        const cacheinfo = `160000,${subSha},${sub}`
        const upd = await safeExec($`cd ${repoPath} && git update-index --cacheinfo ${cacheinfo} 2>&1`.env(idxEnv))
        if (upd.exitCode !== 0) throw new Error(`preserve: gitlink override for ${sub} failed: ${upd.stdout}`)
      }
    }
    const treeRes = await safeExec($`cd ${repoPath} && git write-tree`.env(idxEnv))
    const tree = treeRes.stdout.trim()
    if (treeRes.exitCode !== 0 || !tree) throw new Error(`preserve: write-tree failed in ${repoPath}`)
    const headRes = await safeExec($`cd ${repoPath} && git rev-parse HEAD`)
    const head = headRes.stdout.trim()
    const commitRes = await safeExec(
      $`cd ${repoPath} && git ${PRESERVE_IDENT} commit-tree ${tree} -p ${head} -m ${message}`,
    )
    const sha = commitRes.stdout.trim()
    if (commitRes.exitCode !== 0 || !sha) throw new Error(`preserve: commit-tree failed in ${repoPath}`)
    return sha
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

export interface PreserveOptions {
  /** Fixed ref slug: `wip/<label>` instead of `wip/<slot>-preserve-<stamp>`. */
  label?: string
  /** Override the UTC stamp (tests). */
  stamp?: string
  /**
   * Preserve ahead-of-origin/main commits when the tree is otherwise clean.
   * removeWorktree passes `deleteBranch` here: a surviving branch already holds
   * the ahead work, so we only snapshot ahead-only state when the branch dies.
   * Dirty state is ALWAYS preserved regardless (its snapshot parents at HEAD, so
   * ahead commits ride along).
   */
  includeAhead?: boolean
}

/**
 * Preserve a live slot's uncommitted (working-tree + submodule) changes and/or
 * ahead-of-origin/main commits to a durable ref BEFORE a destructive step.
 * No-op (`preserved:false`) when the slot is clean and not ahead. Fails LOUD if
 * a dirty submodule cannot be transferred to a durable store — never silently.
 */
export async function preserveSlotState(
  worktreePath: string,
  slotName: string,
  gitRoot: string,
  opts: PreserveOptions = {},
): Promise<PreserveResult> {
  const empty: PreserveResult = { preserved: false, submodules: [] }
  if (!existsSync(worktreePath)) return empty
  const includeAhead = opts.includeAhead ?? true

  // Superproject's OWN file changes (excluding submodule state), + any dirty
  // submodule working tree. A pure gitlink advance (committed submodule move) is
  // NOT the uncommitted-work loss class, so it does not trigger preservation.
  const superFile = await safeExec(
    $`cd ${worktreePath} && git status --porcelain --untracked-files=all --ignore-submodules=all 2>/dev/null`,
  )
  const superFileDirty = superFile.stdout.trim().length > 0

  const dirtySubs: string[] = []
  for (const sub of getSubmodulePaths(worktreePath)) {
    const subPath = join(worktreePath, sub)
    if (!existsSync(join(subPath, ".git"))) continue
    const st = await getWorktreeStatus(subPath)
    if (st.dirty) dirtySubs.push(sub)
  }
  const dirty = superFileDirty || dirtySubs.length > 0

  const aheadRes = await safeExec($`cd ${worktreePath} && git rev-list --count origin/main..HEAD 2>/dev/null`)
  const ahead = parseInt(aheadRes.stdout.trim(), 10) || 0

  if (!dirty && !(ahead > 0 && includeAhead)) return empty

  const stamp = opts.stamp ?? preserveStamp()
  const refShort = opts.label ? `wip/${opts.label}` : `wip/${slotName}-preserve-${stamp}`
  const refFull = `refs/heads/${refShort}`
  const reason: NonNullable<PreserveResult["reason"]> = dirty && ahead > 0 ? "dirty+ahead" : dirty ? "dirty" : "ahead"

  const preservedSubs: PreservedSubmodule[] = []
  let sha: string

  if (dirty) {
    // 1) Snapshot each dirty submodule, then TRANSFER its preserve commit into
    //    the durable MAIN submodule store so it survives removeWorktree tearing
    //    down the per-worktree isolated store.
    const subGitlinks = new Map<string, string>()
    for (const sub of dirtySubs) {
      const subPath = join(worktreePath, sub)
      const subSha = await snapshotDirtyRepo(subPath, `preserve ${refShort} (${sub})`)
      const subRef = await safeExec($`cd ${subPath} && git update-ref ${refFull} ${subSha}`)
      if (subRef.exitCode !== 0) throw new Error(`preserve: update-ref ${refFull} in ${sub} failed: ${subRef.stdout}`)
      const mainSubPath = join(gitRoot, sub)
      if (!existsSync(join(mainSubPath, ".git"))) {
        throw new Error(
          `preserve: cannot durably save dirty submodule ${sub} — main submodule store ${mainSubPath} is not initialized`,
        )
      }
      const fetched = await safeExec($`cd ${mainSubPath} && git fetch -q ${subPath} +${refFull}:${refFull} 2>&1`)
      if (fetched.exitCode !== 0) {
        throw new Error(`preserve: transferring ${sub} preserve ref into main store failed: ${fetched.stdout}`)
      }
      subGitlinks.set(sub, subSha)
      preservedSubs.push({ path: sub, ref: refShort, sha: subSha })
    }
    // 2) Superproject snapshot, gitlinks repointed at the sub preserve commits.
    sha = await snapshotDirtyRepo(worktreePath, `preserve ${refShort} (${slotName})`, subGitlinks)
  } else {
    // clean-but-ahead → the ref points directly at HEAD (no snapshot commit).
    const headRes = await safeExec($`cd ${worktreePath} && git rev-parse HEAD`)
    sha = headRes.stdout.trim()
  }

  const setRef = await safeExec($`cd ${gitRoot} && git update-ref ${refFull} ${sha}`)
  if (setRef.exitCode !== 0) throw new Error(`preserve: writing ${refFull} at ${sha} failed: ${setRef.stdout}`)

  // Loud (§ Fail Loud) — print the recovery ref to the operator.
  console.log("")
  warn(`Preserved ${reason} state of slot ${slotName} before the destructive step:`)
  console.log(CYAN + `    ${refShort}` + RESET + DIM + `  (${sha.slice(0, 12)})` + RESET)
  console.log(DIM + `    recover: git switch ${refShort}   # in ${basename(gitRoot)}` + RESET)
  for (const s of preservedSubs) {
    console.log(
      CYAN + `    ${s.path} → ${refShort}` + RESET + DIM + `  (${s.sha.slice(0, 12)}, in that submodule)` + RESET,
    )
  }
  const subLog = preservedSubs.map((s) => `${s.path}@${s.sha.slice(0, 12)}`).join(",")
  await appendPreserveLog(
    gitRoot,
    `${new Date().toISOString()} slot=${slotName} ref=${refShort} sha=${sha} reason=${reason}` +
      (subLog ? ` submodules=${subLog}` : "") +
      ` path=${worktreePath}`,
  )

  return { preserved: true, ref: refShort, sha, reason, submodules: preservedSubs }
}

/**
 * Preserve a local slot branch that is ahead of origin/main when NO live slot
 * dir exists — the pool-slot recreate `-B <branch> origin/main` would otherwise
 * force-discard those commits. No-op when the branch is not ahead.
 */
async function preserveAheadBranchRef(gitRoot: string, branchName: string, slotName: string): Promise<void> {
  const aheadRes = await safeExec(
    $`cd ${gitRoot} && git rev-list --count origin/main..refs/heads/${branchName} 2>/dev/null`,
  )
  const ahead = parseInt(aheadRes.stdout.trim(), 10) || 0
  if (ahead === 0) return
  const tip = (await safeExec($`cd ${gitRoot} && git rev-parse refs/heads/${branchName}`)).stdout.trim()
  const refShort = `wip/${slotName}-preserve-${preserveStamp()}`
  const setRef = await safeExec($`cd ${gitRoot} && git update-ref refs/heads/${refShort} ${tip}`)
  if (setRef.exitCode !== 0) {
    throw new Error(`preserve: saving ahead branch ${branchName} to ${refShort} failed: ${setRef.stdout}`)
  }
  console.log("")
  warn(`Preserved ${ahead} ahead commit(s) of slot branch ${branchName} before the -B origin/main reset:`)
  console.log(CYAN + `    ${refShort}` + RESET + DIM + `  (${tip.slice(0, 12)})` + RESET)
  await appendPreserveLog(
    gitRoot,
    `${new Date().toISOString()} slot=${slotName} ref=${refShort} sha=${tip} reason=ahead-branch branch=${branchName}`,
  )
}

export interface RemoveOptions {
  deleteBranch?: boolean
  force?: boolean
  /** Fixed preserve ref slug (`wip/<label>`); default `wip/<slot>-preserve-<stamp>`. */
  preserveLabel?: string
}

export interface ResolveTargetOptions {
  /** Pool root to search first; defaults to the historic sibling parent. */
  poolRoot?: string
  /** Filesystem probe, injectable for tests. */
  exists?: (path: string) => boolean
}

/**
 * Resolve a worktree TARGET argument for verbs that operate on an EXISTING
 * worktree (remove/reset). Accepts:
 *   - a filesystem path (absolute, containing a separator, or `.`/`..`) —
 *     used as-is, so a path pasted from `git worktree list` just works
 *   - a dir name already prefixed with `<repoName>-`
 *   - a bare name suffix → looked up in the configured pool first, then the
 *     legacy sibling location (so a live slot is never orphaned by a pool
 *     config flip); when neither exists, the configured pool path is returned
 *     so create-fresh flows land at the canonical location.
 * `create` keeps the bare-name contract on purpose — creating AT an arbitrary
 * path is a different feature, not this resolver.
 */
export function resolveWorktreeTargetPath(gitRoot: string, name: string, options: ResolveTargetOptions = {}): string {
  if (isAbsolute(name) || name.includes("/") || name === "." || name === "..") {
    return resolve(name)
  }
  const poolRoot = options.poolRoot ?? dirname(gitRoot)
  const candidates = slotPathCandidates(gitRoot, name, poolRoot)
  if (candidates.length === 1) return candidates[0]!
  const exists = options.exists ?? existsSync
  return candidates.find((candidate) => exists(candidate)) ?? candidates[0]!
}

export async function removeWorktree(name: string, options: RemoveOptions = {}): Promise<void> {
  assertValidWorktreeName(name)
  const { deleteBranch = false, force = false, preserveLabel } = options

  const gitRoot = findGitRoot(process.cwd())
  if (!gitRoot) {
    error("Not in a git repository")
    process.exit(1)
  }

  const worktreePath = resolveWorktreeTargetPath(gitRoot, name, { poolRoot: resolvePoolRoot(gitRoot) })

  if (!existsSync(worktreePath)) {
    error(`Worktree not found: ${worktreePath}`)
    console.log(DIM + "Accepted forms: a slot name (wt3), a sibling dir name, or a path to the worktree." + RESET)
    console.log("")
    console.log("Current worktrees:")
    const result = await $`cd ${gitRoot} && git worktree list`.quiet()
    console.log(result.stdout.toString())
    process.exit(1)
  }

  // Get branch name before removing
  const branchResult = await $`cd ${worktreePath} && git branch --show-current`.quiet()
  const branchName = branchResult.stdout.toString().trim()

  // Check for uncommitted changes
  if (!force) {
    const status = await getWorktreeStatus(worktreePath)
    if (status.dirty) {
      warn("Worktree has uncommitted changes:")
      for (const change of status.changes.slice(0, 10)) {
        console.log(DIM + `  ${change}` + RESET)
      }
      if (status.changes.length > 10) {
        console.log(DIM + `  ... and ${status.changes.length - 10} more` + RESET)
      }
      console.log(DIM + "Use --force to remove anyway" + RESET)
      process.exit(1)
    }

    // Check submodules too
    const submodules = getSubmodulePaths(worktreePath)
    for (const submodule of submodules) {
      const subPath = join(worktreePath, submodule)
      if (!existsSync(join(subPath, ".git"))) continue

      const subStatus = await getWorktreeStatus(subPath)
      if (subStatus.dirty) {
        warn(`Submodule ${submodule} has uncommitted changes`)
        console.log(DIM + "Use --force to remove anyway" + RESET)
        process.exit(1)
      }
    }
  }

  // PRESERVE-FIRST (L5): before ANY destructive step, snapshot dirty
  // working-tree state (incl. submodule dirt) and — when the branch will be
  // deleted — ahead-of-origin/main commits, to a durable `wip/…` ref. This is
  // the choke point every removal (direct + via resetWorktree) flows through,
  // so no `git worktree remove --force` can silently discard the 21102 class.
  await preserveSlotState(worktreePath, name, gitRoot, {
    label: preserveLabel,
    includeAhead: deleteBranch,
  })

  // Kill any `dolt sql-server` rooted in this worktree BEFORE touching the
  // filesystem. Those daemons reparent to launchd and would otherwise outlive
  // the removal, leaving stale processes that contribute to `.git/index.lock`
  // contention via periodic housekeeping. See killWorktreeDoltServers for the
  // full rationale.
  const doltKilled = await killWorktreeDoltServers(worktreePath)
  if (doltKilled > 0) {
    info(`Stopped ${doltKilled} dolt sql-server(s) rooted in this worktree`)
  }

  // Pre-clean per-worktree submodule modules dir to prevent orphans.
  // On some git versions / interrupted operations, `git worktree remove` leaves
  // .git/worktrees/<name>/modules/* behind. Removing it first ensures a clean
  // exit regardless.
  const modulesDir = await getWorktreeModulesDir(gitRoot, basename(worktreePath))
  if (modulesDir && existsSync(modulesDir)) {
    info("Cleaning per-worktree submodule modules...")
    try {
      rmSync(modulesDir, { recursive: true, force: true })
      success("Per-worktree submodule modules cleaned")
    } catch (e) {
      warn(`Failed to clean ${modulesDir} (continuing): ${(e as Error).message}`)
    }
  }

  // Remove worktree
  info("Removing worktree...")
  const removeResult = await safeExec($`cd ${gitRoot} && git worktree remove ${worktreePath} --force`)
  if (removeResult.exitCode !== 0) {
    error("Failed to remove worktree")
    process.exit(1)
  }
  success("Worktree removed")

  // Prune
  await $`cd ${gitRoot} && git worktree prune`.quiet()

  // Final orphan sweep — defensive, in case git left anything behind
  if (modulesDir && existsSync(modulesDir)) {
    try {
      rmSync(modulesDir, { recursive: true, force: true })
    } catch {
      // ignore — reported above if needed
    }
  }

  // Delete branch if requested
  if (deleteBranch && branchName) {
    if (branchName === "main" || branchName === "master") {
      warn(`Not deleting protected branch: ${branchName}`)
    } else {
      info(`Deleting branch: ${branchName}`)
      await safeExec($`cd ${gitRoot} && git branch -D ${branchName} 2>/dev/null`)
      success("Branch deleted")
    }
  }

  success("Done")
}

export interface ResetOptions {
  /**
   * Proceed past the dirty/ahead safety block and recreate the slot. Work is
   * NOT discarded — removeWorktree preserves it to a durable `wip/…` ref first
   * (L5). Without --force, reset refuses so preservation is an explicit action.
   */
  force?: boolean
  /**
   * Ref-naming label: preserve to `wip/<slug>` instead of the default
   * `wip/<slot>-preserve-<UTCstamp>`. Preservation happens unconditionally in
   * removeWorktree's choke point; this only overrides the ref name.
   */
  saveAheadAs?: string
  /**
   * After remove + before recreate, force-push origin/<name> back to
   * origin/main. Useful when the remote branch has accumulated stale
   * history (e.g. agents pushed slot commits to origin/wtN that were later
   * cherry-picked under different SHAs). Without this, the recreate inherits
   * the remote's stale tracking branch.
   *
   * No-op when there is no origin/<name> branch (the recreate will create
   * fresh from main).
   */
  retargetOrigin?: boolean
  /** Skip dependency install on recreate. */
  install?: boolean
  /** Skip direnv allow on recreate. */
  direnv?: boolean
  /** Skip hook install on recreate. */
  hooks?: boolean
}

/**
 * Reset a worktree to a clean state at origin/main.
 *
 * Thin wrapper over `removeWorktree(force=true) + createWorktree()`. Used to
 * recover a pool slot whose branch has drifted ahead of origin/main or whose
 * working tree has accumulated uncommitted changes. DCG-safe — relies on
 * git's worktree-remove plumbing rather than `git reset --hard`.
 *
 * Refuses without --force if the worktree is dirty or its branch is ahead of
 * origin/main. With --force it PRESERVES that state to a durable `wip/…` ref
 * before recreating (L5) — no path discards. Preservation is unified into
 * removeWorktree's preserve-first choke point.
 *
 * Refuses if invoked from inside the target worktree (the recreate would
 * leave the caller's shell in a removed directory).
 */
export async function resetWorktree(name: string, options: ResetOptions = {}): Promise<void> {
  assertValidWorktreeName(name)
  const { force = false, saveAheadAs, retargetOrigin = false, install = true, direnv = true, hooks = true } = options

  const gitRoot = findGitRoot(process.cwd())
  if (!gitRoot) {
    throw new Error("Not in a git repository")
  }

  const worktreePath = resolveWorktreeTargetPath(gitRoot, name, { poolRoot: resolvePoolRoot(gitRoot) })

  // Refuse to operate from inside the worktree being reset — the recreate
  // would leave the shell with a missing cwd.
  const cwd = process.cwd()
  if (cwd === worktreePath || cwd.startsWith(worktreePath + "/")) {
    throw new Error(`Refusing to reset worktree from inside it: ${worktreePath}. cd to the main repo first.`)
  }
  // Refuse to operate on the main repo itself.
  if (worktreePath === gitRoot) {
    throw new Error(`Refusing to reset main repo (${gitRoot}).`)
  }

  // If the directory doesn't exist, just create it fresh — `reset` is
  // idempotent against a missing slot.
  if (!existsSync(worktreePath)) {
    info(`Worktree ${name} does not exist — creating fresh`)
    await createWorktree(name, undefined, { install, direnv, hooks })
    return
  }

  // Drift check (skipped under --force).
  if (!force) {
    const status = await getWorktreeStatus(worktreePath)
    if (status.dirty) {
      throw new Error(
        `Worktree ${name} has uncommitted changes (${status.changes.length} file(s)). ` +
          `Use --force to preserve them to wip/<slot>-preserve-* and recreate, or commit/save first.`,
      )
    }
    const aheadResult = await safeExec($`cd ${worktreePath} && git rev-list --count origin/main..HEAD 2>/dev/null`)
    const ahead = parseInt(aheadResult.stdout.trim(), 10) || 0
    if (ahead > 0) {
      throw new Error(
        `Worktree ${name} is ${ahead} commit(s) ahead of origin/main. ` +
          `Use --force to preserve them to wip/<slot>-preserve-* and recreate, or push/save first.`,
      )
    }
  }

  // Preservation is UNIFIED into removeWorktree's preserve-first choke point
  // below (dirty working tree + submodule dirt + ahead commits, all captured to
  // a durable `wip/…` ref before the destructive remove). `saveAheadAs` is now
  // just the ref-naming label — it flows through as `preserveLabel`, so the
  // classic `wip/<slug>` name still lands. There is no separate discard path.

  // Query the worktree's branch name BEFORE remove — for slot patterns
  // (wt0..wt9) it matches the slot name, but `feat/<name>` for non-pool names.
  // We need this name for the optional retarget step below.
  let branchName: string | undefined
  if (retargetOrigin) {
    const branchResult = await safeExec($`cd ${worktreePath} && git rev-parse --abbrev-ref HEAD 2>/dev/null`)
    branchName = branchResult.stdout.trim() || undefined
  }

  // Remove the worktree. Under --force, also delete the local branch so the
  // recreate starts from origin/main (or origin/<branchName>) rather than
  // picking up the existing ref with its ahead commits.
  info(`Resetting worktree ${name}...`)
  await removeWorktree(name, { force: true, deleteBranch: force, preserveLabel: saveAheadAs })

  // Retarget origin/<branch> to origin/main if requested. Done AFTER remove
  // so the worktree's own ref doesn't get yanked out from under git's
  // worktree bookkeeping; done BEFORE create so the recreate picks up the
  // retargeted remote tracking branch. No-op when origin/<branch> doesn't exist.
  if (retargetOrigin && branchName && branchName !== "HEAD") {
    const remoteExists = await safeExec(
      $`cd ${gitRoot} && git show-ref --verify refs/remotes/origin/${branchName} 2>/dev/null`,
    )
    if (remoteExists.exitCode === 0) {
      info(`Retargeting origin/${branchName} to origin/main...`)
      const pushResult = await safeExec(
        $`cd ${gitRoot} && git push --force-with-lease=refs/heads/${branchName} origin refs/remotes/origin/main:refs/heads/${branchName}`,
      )
      if (pushResult.exitCode !== 0) {
        throw new Error(
          `Failed to retarget origin/${branchName}: ${pushResult.stdout || "force-with-lease rejected — refetch and retry"}`,
        )
      }
      success(`origin/${branchName} now tracks origin/main`)
    }
  }

  // Recreate. allowDirty: true because main-repo state is the caller's
  // problem, not the reset's — reset is about restoring the slot, not
  // cleaning the workspace.
  await createWorktree(name, undefined, { install, direnv, hooks, allowDirty: true })

  success(`Worktree ${name} reset`)
}

function formatBranchColor(wt: { branch: string; isDetached: boolean }): string {
  if (wt.branch === "main" || wt.branch === "master") return GREEN + wt.branch + RESET
  if (wt.isDetached) return RED + wt.branch + RESET
  return BLUE + wt.branch + RESET
}

async function printWorktreeEntry(
  wt: { path: string; branch: string; isDetached: boolean },
  gitRoot: string,
  detailed: boolean,
): Promise<void> {
  const name = basename(wt.path)
  const isMain = wt.path === gitRoot
  const status = await getWorktreeStatus(wt.path)
  const dirty = status.dirty ? YELLOW + "*" + RESET : ""
  const branchColor = formatBranchColor(wt)

  if (!detailed) {
    const marker = isMain ? CYAN + " (main)" + RESET : ""
    console.log(`  ${name.padEnd(25)} ${branchColor}${dirty}${marker}`)
    return
  }

  let submoduleDirty = ""
  const submodules = getSubmodulePaths(wt.path)
  for (const submodule of submodules) {
    const subPath = join(wt.path, submodule)
    if (!existsSync(join(subPath, ".git"))) continue
    const subStatus = await getWorktreeStatus(subPath)
    if (subStatus.dirty) {
      submoduleDirty = YELLOW + " (submodule changes)" + RESET
      break
    }
  }

  console.log(`${name.padEnd(30)} ${branchColor}${dirty}${submoduleDirty}`)
  console.log(DIM + `  ${wt.path}` + RESET)

  if (status.dirty) {
    for (const change of status.changes.slice(0, 5)) {
      console.log(DIM + `    ${change}` + RESET)
    }
    if (status.changes.length > 5) {
      console.log(DIM + `    ... and ${status.changes.length - 5} more` + RESET)
    }
  }

  // Per-submodule HEAD SHAs — shows divergence across worktrees
  if (submodules.length > 0) {
    const heads = await getSubmoduleHeads(wt.path)
    const modulesDir = isMain ? undefined : await getWorktreeModulesDir(gitRoot, name)
    const isolated = modulesDir && existsSync(modulesDir)
    const isoMarker = isMain ? "" : isolated ? GREEN + " [isolated]" + RESET : YELLOW + " [shared]" + RESET
    console.log(DIM + "  submodules" + RESET + isoMarker)
    for (const sub of submodules) {
      const sha = heads[sub]
      if (sha) {
        console.log(DIM + `    ${sub.padEnd(22)} ${sha}` + RESET)
      } else {
        console.log(DIM + `    ${sub.padEnd(22)} ` + RESET + YELLOW + "(not initialized)" + RESET)
      }
    }
  }
  console.log("")
}

export async function listWorktrees(detailed = false): Promise<void> {
  const gitRoot = findGitRoot(process.cwd())
  if (!gitRoot) {
    error("Not in a git repository")
    process.exit(1)
  }

  console.log(CYAN + "Git Worktrees" + RESET)
  console.log("")

  const worktrees = await getWorktrees(gitRoot)

  for (const wt of worktrees) {
    await printWorktreeEntry(wt, gitRoot, detailed)
  }

  console.log("")
  console.log(DIM + `${worktrees.length} worktree(s)` + RESET)
}

export async function showDefaultInfo(): Promise<void> {
  const gitRoot = findGitRoot(process.cwd())
  if (!gitRoot) {
    error("Not in a git repository")
    process.exit(1)
  }

  const repoName = basename(gitRoot)
  const currentDir = process.cwd()
  const submodules = getSubmodulePaths(gitRoot)

  console.log(CYAN + BOLD + "Git Worktrees" + RESET)
  console.log(DIM + `Repository: ${repoName}` + RESET)
  if (submodules.length > 0) {
    console.log(
      DIM +
        `Submodules: ${submodules.length} (${submodules.slice(0, 3).join(", ")}${submodules.length > 3 ? "..." : ""})` +
        RESET,
    )
  }
  console.log("")

  const worktrees = await getWorktrees(gitRoot)
  const parentDir = dirname(gitRoot)

  // Tree view
  console.log(BOLD + "Worktrees" + RESET)
  console.log(parentDir + "/")

  for (let i = 0; i < worktrees.length; i++) {
    const wt = worktrees[i]
    if (!wt) continue
    // Parent-relative display keeps contained-pool slots honest (e.g.
    // `hh/.worktrees/hh-wt3`), while sibling slots stay a bare basename.
    const name = wt.path.startsWith(parentDir + "/") ? relative(parentDir, wt.path) : wt.path
    const isMain = wt.path === gitRoot
    const isCurrent = wt.path === currentDir || currentDir.startsWith(wt.path + "/")
    const isLast = i === worktrees.length - 1

    // Check for changes
    const status = await getWorktreeStatus(wt.path)

    // Tree prefix (dim lines, white directory name)
    const prefix = DIM + (isLast ? "└── " : "├── ") + RESET

    // Format branch
    let branchColor
    if (wt.branch === "main" || wt.branch === "master") {
      branchColor = GREEN + wt.branch + RESET
    } else if (wt.isDetached) {
      branchColor = RED + wt.branch + RESET
    } else {
      branchColor = BLUE + wt.branch + RESET
    }

    // Format status
    let statusStr = ""
    if (status.dirty) {
      statusStr = YELLOW + ` (${status.changes.length} changes)` + RESET
    }

    // Markers
    const currentMarker = isCurrent ? CYAN + " ◀" + RESET : ""
    const mainMarker = isMain ? DIM + " (primary)" + RESET : ""

    console.log(`${prefix}${name.padEnd(24)} ${branchColor}${statusStr}${currentMarker}${mainMarker}`)
  }

  console.log("")
  console.log(DIM + `${worktrees.length} worktree(s)` + RESET)

  // Usage section
  console.log("")
  console.log(BOLD + "Why this tool?" + RESET)
  console.log(DIM + "  Bare 'git worktree add' doesn't handle:" + RESET)
  console.log(DIM + "  • Submodules (need independent clones, not symlinks)" + RESET)
  console.log(DIM + "  • Dependencies (bun install / npm install)" + RESET)
  console.log(DIM + "  • Hooks (git hooks need reinstalling per worktree)" + RESET)
  console.log(DIM + "  • Direnv (needs 'direnv allow' per worktree)" + RESET)
  console.log(DIM + "  • Validation (uncommitted changes, unpushed submodules)" + RESET)

  console.log("")
  console.log(BOLD + "Commands" + RESET)
  const poolRoot = resolvePoolRoot(gitRoot)
  const slotBase = join(poolRoot, repoName)
  console.log(CYAN + "  bun worktree create <name>" + RESET)
  console.log(DIM + `     Create worktree at ${slotBase}-<name> on branch feat/<name>` + RESET)
  console.log(DIM + `     Example: bun worktree create bugfix  →  ${slotBase}-bugfix` + RESET)
  console.log(DIM + `     (pool root via git config worktree.poolRoot; resolve with: bun worktree path <name>)` + RESET)
  console.log("")
  console.log(CYAN + "  bun worktree create <name> <branch>" + RESET)
  console.log(DIM + "     Create worktree on specific branch" + RESET)
  console.log(DIM + "     Example: bun worktree create test main  →  track main branch" + RESET)
  console.log("")
  console.log(CYAN + "  bun worktree remove <name>" + RESET)
  console.log(DIM + "     Remove worktree (checks for uncommitted changes)" + RESET)
  console.log(
    DIM + "     Use --force to preserve dirt to wip/… then remove, --delete-branch to also delete branch" + RESET,
  )
  console.log("")
  console.log(CYAN + "  bun worktree list" + RESET)
  console.log(DIM + "     Show detailed status including file changes" + RESET)

  if (submodules.length > 0) {
    console.log("")
    console.log(BOLD + "Submodule handling" + RESET)
    console.log(DIM + "  Worktrees are created from the COMMITTED state, not working tree." + RESET)
    console.log(DIM + "  This ensures each worktree is an exact, reproducible copy." + RESET)
    console.log("")
    console.log(DIM + "  Before creating:" + RESET)
    console.log(DIM + "  • Fails if main repo has uncommitted changes" + RESET)
    console.log(DIM + "  • Fails if any submodule has uncommitted changes" + RESET)
    console.log(DIM + "  • Fails if submodule commits aren't pushed to remote" + RESET)
    console.log("")
    console.log(DIM + "  Each worktree gets isolated submodule refs and working files," + RESET)
    console.log(DIM + "  while immutable object history is borrowed from the main checkout." + RESET)
  }
}

function printHelp(): void {
  console.log(`
${BOLD}worktree${RESET} - Git worktree management with submodule support

${BOLD}USAGE${RESET}
  bun worktree                          Show worktrees and help
  bun worktree create <name> [branch]   Create worktree in the pool (see POOL ROOT)
  bun worktree create --branch <branch> Create worktree using branch as name
  bun worktree remove <name>            Remove worktree
  bun worktree reset <name> [--force]   Recreate worktree at origin/main (DCG-safe slot recovery)
  bun worktree path <name>              Print the resolved slot path (pool-aware)
  bun worktree list                     Detailed worktree status
  bun worktree gc                       Prune stale agent-isolation clones (.claude/worktrees/agent-*)

${BOLD}POOL ROOT${RESET}
  Slots are created under the pool root: <poolRoot>/<repo>-<name>.
  Default pool root is the repo's parent dir (sibling layout: ../<repo>-<name>).
  Configure a contained, git-ignored pool inside the repo with git config:
    git config worktree.poolRoot .worktrees    # → <repo>/.worktrees/<repo>-<name>
  A contained pool root MUST be git-ignored (create fails loud otherwise).
  Existing slots are found in both the configured pool and the legacy sibling
  location, so setting the config never orphans a live slot. Scripts and docs
  should resolve slot paths via \`bun worktree path <name>\`, not hardcode them.

  ${DIM}Nothing here discards work: a destructive step first preserves a dirty${RESET}
  ${DIM}or ahead slot to wip/<slot>-preserve-<UTCstamp> (submodule dirt too).${RESET}

${BOLD}CREATE OPTIONS${RESET}
  --branch <name>   Use specific branch (also used as worktree name if no <name>)
  --base <ref>      Base a NEW branch/slot on <ref> instead of the default
                    fetch-then-origin/main (offline / deliberate escape hatch;
                    errors loud if the branch already exists)
  --no-install      Skip dependency installation
  --no-direnv       Skip direnv allow
  --no-hooks        Skip hook installation
  --allow-dirty     Create despite uncommitted changes in the MAIN repo (they stay
                    in main; a stale ahead slot branch is preserved, not reset away)

${BOLD}REMOVE OPTIONS${RESET}
  --delete-branch   Also delete the branch
  -f, --force       Remove despite uncommitted changes — preserves them to wip/… first

${BOLD}RESET OPTIONS${RESET}
  -f, --force            Recreate despite dirt/ahead — PRESERVES to wip/… first (never discards)
  --save-ahead-as <slug> Name the preserve ref wip/<slug> instead of wip/<slot>-preserve-<stamp>
  --retarget-origin      Force-push origin/<name> back to origin/main before recreate
  --no-install           Skip dependency install on recreate
  --no-direnv            Skip direnv allow on recreate
  --no-hooks             Skip hook install on recreate

${BOLD}GC OPTIONS${RESET}
  --root <dir>             Directory to scan (default: <gitRoot>/.claude/worktrees)
  --dry-run                Show what would be deleted, don't delete
  --min-age <hours>        Only delete clones older than this many hours (default 0)
  --include-unique-work    Compatibility no-op; unique work is always preserved

${BOLD}EXAMPLES${RESET}
  bun worktree create my-feature                           # New branch feat/my-feature
  bun worktree create bugfix fix/cursor-pos                # Specific branch
  bun worktree create --branch km-ila18-theme-inherit      # Branch as name
  bun worktree create test main                            # Track main branch
  bun worktree remove my-feature --delete-branch   # Remove and delete branch

${BOLD}HOW IT WORKS${RESET}
  Worktrees are created from COMMITTED state, not your working tree.
  A NEW branch (or pool slot) is cut from a freshly-fetched origin/main —
  never from local HEAD, which may be stale (worktree-base-origin-main);
  \`--base <ref>\` overrides. Existing branches keep their own tip.

  ${BOLD}Before creating, the tool validates:${RESET}
  1. No uncommitted changes in main repo
  2. No uncommitted changes in any submodule
  3. All submodule commits are pushed to remote

  If any check fails, you'll be prompted to commit first.
  Use --allow-dirty to bypass — those MAIN-repo changes stay in main; the new
  slot simply starts without them. Destructive ops on an EXISTING slot never
  discard: dirt + ahead commits (submodule dirt included) are preserved to
  wip/<slot>-preserve-<UTCstamp> first.

${BOLD}Submodule handling:${RESET}
  Each worktree gets independent submodule refs, config, and working files.
  Existing object history is borrowed from the matching main checkout before
  Git uses the remote, so different pins stay possible without full re-clones.

${BOLD}POST-CREATE SETUP${RESET}
  - Materializes submodules from matching local object stores (remote fallback)
  - Runs 'bun install' (or npm if no bun.lock)
  - Runs 'direnv allow' if .envrc present
  - Runs 'bun run prepare' for git hooks
`)
}

// ============================================
// Main CLI
// ============================================

/** Per-subcommand flag spec: which flags are legal, which take a value. */
interface SubcommandSpec {
  /** Max positional args (the name; create also takes an optional branch). */
  maxPositionals: number
  /** Flag → whether it consumes the next argv token as its value. */
  flags: Record<string, { value?: boolean }>
}

const SUBCOMMAND_SPECS: Record<string, SubcommandSpec> = {
  create: {
    maxPositionals: 2,
    flags: {
      "--branch": { value: true },
      "--base": { value: true },
      "--no-install": {},
      "--no-direnv": {},
      "--no-hooks": {},
      "--allow-dirty": {},
    },
  },
  remove: {
    maxPositionals: 1,
    flags: { "--delete-branch": {}, "--force": {}, "-f": {}, "--preserve-label": { value: true } },
  },
  rm: {
    maxPositionals: 1,
    flags: { "--delete-branch": {}, "--force": {}, "-f": {}, "--preserve-label": { value: true } },
  },
  reset: {
    maxPositionals: 1,
    flags: {
      "--force": {},
      "-f": {},
      "--save-ahead-as": { value: true },
      "--retarget-origin": {},
      "--no-install": {},
      "--no-direnv": {},
      "--no-hooks": {},
    },
  },
  path: { maxPositionals: 1, flags: {} },
  list: { maxPositionals: 0, flags: {} },
  ls: { maxPositionals: 0, flags: {} },
  audit: {
    maxPositionals: 0,
    flags: { "--json": {}, "--behind-threshold": { value: true }, "--stale-days": { value: true } },
  },
  gc: {
    maxPositionals: 0,
    flags: { "--root": { value: true }, "--dry-run": {}, "--min-age": { value: true }, "--include-unique-work": {} },
  },
}

/**
 * Create plan options: every toggle resolved, but `base` stays optional —
 * `undefined` means "fetch, then origin/main" (the enforced default), an
 * explicit value is the operator's deliberate `--base <ref>` escape hatch.
 */
export type CreatePlanOptions = Required<Omit<CreateOptions, "base">> & Pick<CreateOptions, "base">

export type CliPlan =
  | { action: "help" }
  | { action: "default-info" }
  | { action: "usage-error"; message: string }
  | { action: "create"; name: string; branch: string | undefined; options: CreatePlanOptions }
  | { action: "remove"; name: string; options: RemoveOptions }
  | { action: "reset"; name: string; options: ResetOptions }
  | { action: "path"; name: string }
  | { action: "list" }
  | { action: "audit"; options: AuditOptions }
  | { action: "gc"; options: GcOptions }

/**
 * Pure CLI planner. Guarantees: live commands treat `-h`/`--help` anywhere as
 * help, while retired commands refuse every spelling; a `-`-prefixed token can
 * never become a worktree name; unknown flags, missing flag values, and extra
 * positionals fail loud. This makes the
 * `bun worktree reset --help` → `<repo>---help` sprawl class (km bead
 * 20888-contained-worktree-pool) unrepresentable in a plan.
 */
export function planCliInvocation(argv: string[]): CliPlan {
  const command = argv[0]
  if (command === "merge") {
    return {
      action: "usage-error",
      message:
        "The worktree merge command was retired; push the branch and use the repository's authorized landing workflow.",
    }
  }
  if (argv.some((arg) => arg === "--help" || arg === "-h")) return { action: "help" }
  if (command === undefined) return { action: "default-info" }
  if (command === "help") return { action: "help" }

  const spec = SUBCOMMAND_SPECS[command]
  if (!spec) return { action: "usage-error", message: `Unknown command: ${command}` }

  const positionals: string[] = []
  const flags = new Set<string>()
  const values = new Map<string, string>()
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith("-")) {
      const flagSpec = spec.flags[arg]
      if (!flagSpec) return { action: "usage-error", message: `Unknown flag for ${command}: ${arg}` }
      if (flagSpec.value) {
        const value = argv[i + 1]
        if (value === undefined || value.startsWith("-")) {
          return { action: "usage-error", message: `${arg} requires a value` }
        }
        values.set(arg, value)
        i++
      } else {
        flags.add(arg)
      }
    } else {
      positionals.push(arg)
    }
  }
  if (positionals.length > spec.maxPositionals) {
    return {
      action: "usage-error",
      message: `Too many arguments for ${command}: ${positionals.slice(spec.maxPositionals).join(" ")}`,
    }
  }

  switch (command) {
    case "create": {
      const branchFromFlag = values.get("--branch")
      const name = positionals[0] ?? branchFromFlag
      if (!name) return { action: "usage-error", message: "Usage: bun worktree create <name> [--branch <branch>]" }
      return {
        action: "create",
        name,
        // Branch priority: --branch flag > positional > default (feat/<name>)
        branch: branchFromFlag ?? positionals[1],
        options: {
          install: !flags.has("--no-install"),
          direnv: !flags.has("--no-direnv"),
          hooks: !flags.has("--no-hooks"),
          allowDirty: flags.has("--allow-dirty"),
          base: values.get("--base"),
        },
      }
    }
    case "remove":
    case "rm": {
      const name = positionals[0]
      if (!name) return { action: "usage-error", message: "Usage: bun worktree remove <name>" }
      return {
        action: "remove",
        name,
        options: {
          deleteBranch: flags.has("--delete-branch"),
          force: flags.has("--force") || flags.has("-f"),
          // Optional ref-naming label; undefined → the default
          // `wip/<slot>-preserve-<UTCstamp>` name (mirrors reset's --save-ahead-as).
          preserveLabel: values.get("--preserve-label"),
        },
      }
    }
    case "reset": {
      const name = positionals[0]
      if (!name) {
        return { action: "usage-error", message: "Usage: bun worktree reset <name> [--force] [--save-ahead-as <slug>]" }
      }
      return {
        action: "reset",
        name,
        options: {
          force: flags.has("--force") || flags.has("-f"),
          saveAheadAs: values.get("--save-ahead-as"),
          retargetOrigin: flags.has("--retarget-origin"),
          install: !flags.has("--no-install"),
          direnv: !flags.has("--no-direnv"),
          hooks: !flags.has("--no-hooks"),
        },
      }
    }
    case "path": {
      const name = positionals[0]
      if (!name) return { action: "usage-error", message: "Usage: bun worktree path <name>" }
      return { action: "path", name }
    }
    case "list":
    case "ls":
      return { action: "list" }
    case "audit": {
      let behindThreshold: number | undefined
      const behindRaw = values.get("--behind-threshold")
      if (behindRaw !== undefined) {
        behindThreshold = parseInt(behindRaw, 10)
        if (Number.isNaN(behindThreshold)) {
          return { action: "usage-error", message: "--behind-threshold must be a number" }
        }
      }
      let staleAgeDays: number | undefined
      const staleRaw = values.get("--stale-days")
      if (staleRaw !== undefined) {
        staleAgeDays = parseInt(staleRaw, 10)
        if (Number.isNaN(staleAgeDays)) return { action: "usage-error", message: "--stale-days must be a number" }
      }
      return { action: "audit", options: { json: flags.has("--json"), behindThreshold, staleAgeDays } }
    }
    case "gc": {
      let minAgeHours = 0
      const minAgeRaw = values.get("--min-age")
      if (minAgeRaw !== undefined) {
        minAgeHours = parseFloat(minAgeRaw)
        if (Number.isNaN(minAgeHours)) return { action: "usage-error", message: "--min-age must be a number (hours)" }
      }
      return {
        action: "gc",
        options: {
          root: values.get("--root"),
          dryRun: flags.has("--dry-run"),
          minAgeHours,
          includeUniqueWork: flags.has("--include-unique-work"),
        },
      }
    }
    default:
      return { action: "usage-error", message: `Unknown command: ${command}` }
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const plan = planCliInvocation(argv)
  switch (plan.action) {
    case "help":
      printHelp()
      return
    case "default-info":
      await showDefaultInfo()
      return
    case "usage-error":
      error(plan.message)
      console.log(DIM + "Run `bun worktree --help` for usage." + RESET)
      process.exit(1)
      break
    case "path": {
      const gitRoot = findGitRoot(process.cwd())
      if (!gitRoot) {
        error("Not in a git repository")
        process.exit(1)
      }
      console.log(resolveWorktreeTargetPath(gitRoot, plan.name, { poolRoot: resolvePoolRoot(gitRoot) }))
      return
    }
    case "create":
      await createWorktree(plan.name, plan.branch, plan.options)
      return
    case "remove":
      await removeWorktree(plan.name, plan.options)
      return
    case "reset":
      try {
        await resetWorktree(plan.name, plan.options)
      } catch (e) {
        error(e instanceof Error ? e.message : String(e))
        process.exit(1)
      }
      return
    case "list":
      await listWorktrees(true)
      return
    case "audit": {
      const findings = await auditWorktrees(plan.options)
      // Exit 1 if any error-severity findings (CI-friendly).
      if (findings.some((f) => f.severity === "error")) process.exit(1)
      return
    }
    case "gc":
      await gcAgentClones(plan.options)
      return
  }
}

if (import.meta.main) {
  void main()
}
