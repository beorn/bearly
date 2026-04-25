#!/usr/bin/env bun
/**
 * worktree.ts - Git worktree management with submodule support
 *
 * Creates, removes, and lists git worktrees with proper setup for projects that use:
 * - Git submodules (independent clones per worktree)
 * - bun/npm dependencies
 * - direnv
 * - Git hooks
 *
 * Commands:
 *   (default)              - Show worktrees and help
 *   create <name> [branch] - Create worktree at ../<repo>-<name>
 *   merge <name>           - Merge worktree branch into main and clean up
 *   remove <name>          - Remove worktree
 *   list                   - Detailed worktree status (with per-submodule HEAD SHAs)
 *
 * Submodule isolation
 * -------------------
 * Each worktree gets an independent submodule clone stored at
 * `.git/worktrees/<name>/modules/<path>/`. After `git worktree add`,
 * running `git submodule update --init --recursive` inside the worktree
 * populates the working tree AND creates the per-worktree module dir
 * automatically (modern git behavior). This means changes in worktree A's
 * `vendor/silvery` never affect worktree B's `vendor/silvery`.
 *
 * Note on --recurse-submodules: `git worktree add` does NOT support a
 * `--recurse-submodules` flag (the documentation sometimes suggests
 * otherwise; as of git 2.53 the flag is rejected). The `submodule.recurse`
 * config is respected elsewhere but not for `worktree add`, so we always
 * run an explicit `git submodule update --init --recursive` post-add.
 *
 * On removal, we explicitly clean up `.git/worktrees/<name>/modules/`
 * before calling `git worktree remove` so git's own cleanup never leaves
 * orphans (which can happen on interrupted removes or older git versions).
 */

import { existsSync, readFileSync, rmSync } from "fs"
import { join, dirname, basename } from "path"
import { $ } from "bun"

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

  const result = await safeExec($`cd ${worktreePath} && git status --porcelain 2>/dev/null`)

  const changes = result.stdout.trim().split("\n").filter(Boolean)
  return { dirty: changes.length > 0, changes }
}

// ============================================
// Agent-clone GC (cp-c-R isolation worktrees)
// ============================================

/**
 * Agent-isolation clones are independent full repos under
 * `<gitRoot>/.claude/worktrees/agent-*` made via APFS `cp -c -R` (not git
 * worktrees). Hosts that run Claude Code with worktree-isolation hooks
 * accumulate these clones over time; the gc command classifies and prunes.
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

  const status = await getWorktreeStatus(clonePath)
  if (status.dirty) return "dirty"

  const headResult = await safeExec($`cd ${clonePath} && git rev-parse HEAD 2>/dev/null`)
  const head = headResult.stdout.trim()
  if (!head) return "broken"

  const inMain = await safeExec($`cd ${clonePath} && git merge-base --is-ancestor ${head} main 2>/dev/null`)
  if (inMain.exitCode !== 0) return "unique-work"

  // Any local-only branch with commits not in main and not on any remote?
  const branches = await safeExec(
    $`cd ${clonePath} && git for-each-ref --format='%(objectname) %(refname:short)' refs/heads 2>/dev/null`,
  )
  for (const line of branches.stdout.split("\n")) {
    if (!line.trim()) continue
    const sha = line.split(" ")[0]
    if (!sha) continue
    const reachable = await safeExec($`cd ${clonePath} && git merge-base --is-ancestor ${sha} main 2>/dev/null`)
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
  /** When true, also delete unique-work clones. Default false (preserved). */
  includeUniqueWork?: boolean
}

export async function gcAgentClones(opts: GcOptions = {}): Promise<{
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

  for (const c of clones) {
    const eligible = c.class === "clean" || c.class === "broken" || (includeUnique && c.class === "unique-work")
    const oldEnough = c.ageHours >= minAgeHours
    if (eligible && oldEnough) {
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
    const why = c.class === "dirty" ? `${c.class} (${c.uncommitted} uncommitted)` : c.class
    const cascade = c.cascadeCount > 0 ? YELLOW + ` +${c.cascadeCount} nested cascade` + RESET : ""
    console.log(`  ${tag}  ${c.name.padEnd(40)} ${DIM}${ageStr.padStart(7)}${RESET}  ${why}${cascade}`)
  }
  // Surface cascades inside PRESERVED clones — those won't be cleaned by
  // outer deletion. User can investigate or pass --include-unique-work to
  // force-delete the parent.
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

  // Use /usr/bin/trash if available (recoverable on macOS), else rm -rf.
  const hasTrash = existsSync("/usr/bin/trash")
  console.log("")
  info(`Deleting ${deleted.length} clone(s) via ${hasTrash ? "trash (recoverable)" : "rm -rf"}...`)
  for (const c of deleted) {
    if (hasTrash) {
      await safeExec($`/usr/bin/trash ${c.path}`)
    } else {
      try {
        rmSync(c.path, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    }
  }
  success(`Deleted ${deleted.length} clone(s)`)

  return { deleted, preserved }
}

// ============================================
// Commands
// ============================================

export interface CreateOptions {
  install?: boolean
  direnv?: boolean
  hooks?: boolean
  allowDirty?: boolean // Skip uncommitted changes check
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
    console.log(CYAN + "  2. Stash your changes: git stash" + RESET)
    console.log(CYAN + "  3. Use --allow-dirty to create anyway (not recommended)" + RESET)
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

async function installDependencies(worktreePath: string): Promise<void> {
  const hasBunLock = existsSync(join(worktreePath, "bun.lockb")) || existsSync(join(worktreePath, "bun.lock"))
  const hasPackageJson = existsSync(join(worktreePath, "package.json"))
  if (!hasPackageJson) return

  if (hasBunLock) {
    info("Running bun install...")
    const result = await safeExec($`cd ${worktreePath} && bun install`)
    if (result.exitCode !== 0) warn("bun install failed (continuing)")
    else success("Dependencies installed")
  } else if (existsSync(join(worktreePath, "package-lock.json"))) {
    info("Running npm install...")
    const result = await safeExec($`cd ${worktreePath} && npm install`)
    if (result.exitCode !== 0) warn("npm install failed (continuing)")
    else success("Dependencies installed")
  }
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

export async function createWorktree(name: string, branch?: string, options: CreateOptions = {}): Promise<void> {
  const { install = true, direnv = true, hooks = true, allowDirty = false } = options

  const gitRoot = findGitRoot(process.cwd())
  if (!gitRoot) {
    error("Not in a git repository")
    process.exit(1)
  }

  const repoName = basename(gitRoot)
  const worktreePath = join(dirname(gitRoot), `${repoName}-${name}`)
  const branchName = branch ?? `feat/${name}`

  // Check if directory exists
  if (existsSync(worktreePath)) {
    error(`Directory already exists: ${worktreePath}`)
    process.exit(1)
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

  let branchArg: string[]
  if (branchExists.exitCode === 0) {
    info(`Using existing branch: ${branchName}`)
    branchArg = [branchName]
  } else if (remoteBranchExists.exitCode === 0) {
    info(`Tracking remote branch: origin/${branchName}`)
    branchArg = [branchName]
  } else {
    info(`Creating new branch: ${branchName}`)
    branchArg = ["-b", branchName]
  }

  // Create worktree
  // Note: git worktree add has no --recurse-submodules flag (as of git 2.53);
  // we init submodules explicitly below. Each init creates an isolated clone
  // under .git/worktrees/<name>/modules/<submodule>/ so worktrees can't
  // collide in each other's vendor/ trees.
  info(`Creating worktree at ${worktreePath}...`)
  const wtResult = await safeExec($`cd ${gitRoot} && git worktree add ${worktreePath} ${branchArg}`)
  if (wtResult.exitCode !== 0) {
    error("Failed to create worktree")
    console.log(wtResult.stdout)
    process.exit(1)
  }
  success("Worktree created")

  // Initialize submodules (per-worktree isolated clones)
  if (submodules.length > 0) {
    info(`Initializing ${submodules.length} submodule(s) (isolated per-worktree clones)...`)
    const subResult = await safeExec($`cd ${worktreePath} && git submodule update --init --recursive 2>&1`)
    if (subResult.exitCode !== 0) {
      error("Failed to initialize submodules:")
      console.log(subResult.stdout)
      // Clean up
      await $`git worktree remove ${worktreePath} --force`.quiet()
      process.exit(1)
    }
    // Verify isolation — each submodule's .git should point at per-worktree modules dir
    const modulesDir = await getWorktreeModulesDir(gitRoot, basename(worktreePath))
    if (modulesDir && existsSync(modulesDir)) {
      success("Submodules initialized (isolated)")
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

export interface RemoveOptions {
  deleteBranch?: boolean
  force?: boolean
}

export async function removeWorktree(name: string, options: RemoveOptions = {}): Promise<void> {
  const { deleteBranch = false, force = false } = options

  const gitRoot = findGitRoot(process.cwd())
  if (!gitRoot) {
    error("Not in a git repository")
    process.exit(1)
  }

  const repoName = basename(gitRoot)
  const worktreePath = join(dirname(gitRoot), `${repoName}-${name}`)

  if (!existsSync(worktreePath)) {
    error(`Worktree not found: ${worktreePath}`)
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

export interface MergeOptions {
  deleteBranch?: boolean
  fullTests?: boolean
}

export async function mergeWorktree(name: string, options: MergeOptions = {}): Promise<void> {
  const { deleteBranch = true, fullTests = false } = options

  const gitRoot = findGitRoot(process.cwd())
  if (!gitRoot) {
    error("Not in a git repository")
    process.exit(1)
  }

  const repoName = basename(gitRoot)
  const worktreePath = join(dirname(gitRoot), `${repoName}-${name}`)

  // Validate we're on the main worktree
  const currentBranchResult = await $`cd ${gitRoot} && git branch --show-current`.quiet()
  const currentBranch = currentBranchResult.stdout.toString().trim()
  if (currentBranch !== "main" && currentBranch !== "master") {
    error(`Must be on main branch to merge (currently on ${currentBranch})`)
    process.exit(1)
  }

  // Validate we're not inside the worktree being merged
  if (process.cwd().startsWith(worktreePath)) {
    error("Cannot merge from inside the worktree being merged")
    console.log(CYAN + `  cd ${gitRoot}` + RESET)
    process.exit(1)
  }

  // Check worktree exists
  if (!existsSync(worktreePath)) {
    error(`Worktree not found: ${worktreePath}`)
    process.exit(1)
  }

  // Get the worktree's branch
  const branchResult = await $`cd ${worktreePath} && git branch --show-current`.quiet()
  const branchName = branchResult.stdout.toString().trim()
  if (!branchName) {
    error("Worktree has no branch (detached HEAD)")
    process.exit(1)
  }

  info(`Merging ${BOLD}${branchName}${RESET} into ${BOLD}${currentBranch}${RESET}`)

  // Check worktree has no uncommitted changes
  const status = await getWorktreeStatus(worktreePath)
  if (status.dirty) {
    error("Worktree has uncommitted changes:")
    for (const change of status.changes.slice(0, 5)) {
      console.log(DIM + `  ${change}` + RESET)
    }
    if (status.changes.length > 5) {
      console.log(DIM + `  ... and ${status.changes.length - 5} more` + RESET)
    }
    console.log("")
    console.log("Commit or stash changes in the worktree first:")
    console.log(CYAN + `  cd ${worktreePath} && git add . && git commit -m "WIP"` + RESET)
    process.exit(1)
  }
  success("Worktree is clean")

  // Check submodules are clean
  const submodules = getSubmodulePaths(worktreePath)
  for (const submodule of submodules) {
    const subPath = join(worktreePath, submodule)
    if (!existsSync(join(subPath, ".git"))) continue

    const subStatus = await getWorktreeStatus(subPath)
    if (subStatus.dirty) {
      error(`Submodule ${submodule} has uncommitted changes`)
      process.exit(1)
    }
  }

  // Merge
  info(`Running: git merge ${branchName} --no-ff`)
  const mergeResult = await safeExec($`cd ${gitRoot} && git merge ${branchName} --no-ff`)
  if (mergeResult.exitCode !== 0) {
    error("Merge conflict! Resolve manually:")
    console.log(mergeResult.stdout)
    console.log("")
    console.log("After resolving:")
    console.log(CYAN + "  git merge --continue" + RESET)
    console.log("")
    console.log("Or abort:")
    console.log(CYAN + "  git merge --abort" + RESET)
    process.exit(1)
  }
  success("Merged successfully")

  // Validate submodule commits are pushed (prevents losing work on detached HEAD submodules)
  const mainSubmodules = getSubmodulePaths(gitRoot)
  if (mainSubmodules.length > 0) {
    await checkUnpushedSubmodules(gitRoot, mainSubmodules)
  }

  // Show merge summary
  const logResult = await safeExec($`cd ${gitRoot} && git log --oneline -5`)
  console.log("")
  console.log(DIM + logResult.stdout.trim() + RESET)
  console.log("")

  // Run tests
  const testCmd = fullTests ? "test:all" : "test:fast"
  info(`Running: bun run ${testCmd}`)
  const testResult = await safeExec($`cd ${gitRoot} && bun run ${testCmd}`)
  if (testResult.exitCode !== 0) {
    warn("Tests failed! Review the merge before pushing.")
    console.log(DIM + "You may want to revert:" + RESET)
    console.log(CYAN + "  git reset --hard HEAD~1" + RESET)
    process.exit(1)
  }
  success("Tests passed")

  // Remove worktree (pre-clean per-worktree submodule modules first)
  info("Removing worktree...")
  const mergedModulesDir = await getWorktreeModulesDir(gitRoot, basename(worktreePath))
  if (mergedModulesDir && existsSync(mergedModulesDir)) {
    try {
      rmSync(mergedModulesDir, { recursive: true, force: true })
    } catch {
      // fall through — git worktree remove will handle most cases
    }
  }
  await safeExec($`cd ${gitRoot} && git worktree remove ${worktreePath} --force`)
  await $`cd ${gitRoot} && git worktree prune`.quiet()
  if (mergedModulesDir && existsSync(mergedModulesDir)) {
    try {
      rmSync(mergedModulesDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
  success("Worktree removed")

  // Delete branch
  if (deleteBranch) {
    if (branchName === "main" || branchName === "master") {
      warn(`Not deleting protected branch: ${branchName}`)
    } else {
      info(`Deleting branch: ${branchName}`)
      await safeExec($`cd ${gitRoot} && git branch -d ${branchName} 2>/dev/null`)
      success("Branch deleted")
    }
  }

  console.log("")
  success(`Merge complete: ${branchName} → ${currentBranch}`)
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
    const name = basename(wt.path)
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
  console.log(CYAN + "  bun worktree create <name>" + RESET)
  console.log(DIM + `     Create worktree at ../${repoName}-<name> on branch feat/<name>` + RESET)
  console.log(DIM + `     Example: bun worktree create bugfix  →  ../${repoName}-bugfix` + RESET)
  console.log("")
  console.log(CYAN + "  bun worktree create <name> <branch>" + RESET)
  console.log(DIM + "     Create worktree on specific branch" + RESET)
  console.log(DIM + "     Example: bun worktree create test main  →  track main branch" + RESET)
  console.log("")
  console.log(CYAN + "  bun worktree merge <name>" + RESET)
  console.log(DIM + "     Merge worktree branch into main, run tests, remove worktree" + RESET)
  console.log(DIM + "     Use --keep-branch to keep branch, --full-tests for test:all" + RESET)
  console.log("")
  console.log(CYAN + "  bun worktree remove <name>" + RESET)
  console.log(DIM + "     Remove worktree (checks for uncommitted changes)" + RESET)
  console.log(DIM + "     Use --force to skip checks, --delete-branch to also delete branch" + RESET)
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
    console.log(DIM + "  Each worktree gets independent submodule clones (not symlinks)," + RESET)
    console.log(DIM + "  so changes in one worktree don't affect others." + RESET)
  }
}

function printHelp(): void {
  console.log(`
${BOLD}worktree${RESET} - Git worktree management with submodule support

${BOLD}USAGE${RESET}
  bun worktree                          Show worktrees and help
  bun worktree create <name> [branch]   Create worktree at ../<repo>-<name>
  bun worktree create --branch <branch> Create worktree using branch as name
  bun worktree merge <name>             Merge worktree branch into main and clean up
  bun worktree remove <name>            Remove worktree
  bun worktree list                     Detailed worktree status
  bun worktree gc                       Prune stale agent-isolation clones (.claude/worktrees/agent-*)

${BOLD}CREATE OPTIONS${RESET}
  --branch <name>   Use specific branch (also used as worktree name if no <name>)
  --no-install      Skip dependency installation
  --no-direnv       Skip direnv allow
  --no-hooks        Skip hook installation
  --allow-dirty     Create even with uncommitted changes (not recommended)

${BOLD}MERGE OPTIONS${RESET}
  --keep-branch     Don't delete the branch after merging
  --full-tests      Run test:all instead of test:fast

${BOLD}REMOVE OPTIONS${RESET}
  --delete-branch   Also delete the branch
  -f, --force       Force removal even with uncommitted changes

${BOLD}GC OPTIONS${RESET}
  --root <dir>             Directory to scan (default: <gitRoot>/.claude/worktrees)
  --dry-run                Show what would be deleted, don't delete
  --min-age <hours>        Only delete clones older than this many hours (default 0)
  --include-unique-work    Also delete clones with local-only commits (default preserved)

${BOLD}EXAMPLES${RESET}
  bun worktree create my-feature                           # New branch feat/my-feature
  bun worktree create bugfix fix/cursor-pos                # Specific branch
  bun worktree create --branch km-ila18-theme-inherit      # Branch as name
  bun worktree create test main                            # Track main branch
  bun worktree merge my-feature                    # Merge, test, remove, delete branch
  bun worktree merge my-feature --keep-branch      # Merge but keep branch
  bun worktree remove my-feature --delete-branch   # Remove and delete branch

${BOLD}HOW IT WORKS${RESET}
  Worktrees are created from your COMMITTED state, not your working tree.
  This ensures each worktree is an exact, reproducible copy.

  ${BOLD}Before creating, the tool validates:${RESET}
  1. No uncommitted changes in main repo
  2. No uncommitted changes in any submodule
  3. All submodule commits are pushed to remote

  If any check fails, you'll be prompted to commit/stash first.
  Use --allow-dirty to bypass (creates worktree without your local changes).

  ${BOLD}Submodule handling:${RESET}
  Each worktree gets independent submodule clones (not symlinks).
  Changes in one worktree's submodules don't affect others.
  This means you can have different submodule states per worktree.

${BOLD}POST-CREATE SETUP${RESET}
  - Runs 'git submodule update --init --recursive'
  - Runs 'bun install' (or npm if no bun.lock)
  - Runs 'direnv allow' if .envrc present
  - Runs 'bun run prepare' for git hooks
`)
}

// ============================================
// Main CLI
// ============================================

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = argv
  const command = args[0]

  function hasFlag(name: string): boolean {
    return args.includes(name)
  }

  switch (command) {
    case "create": {
      // Parse --branch <value> flag if present
      const branchFlagIndex = args.indexOf("--branch")
      let branchFromFlag: string | undefined
      if (branchFlagIndex !== -1) {
        branchFromFlag = args[branchFlagIndex + 1]
        if (!branchFromFlag || branchFromFlag.startsWith("--")) {
          error("--branch requires a value")
          process.exit(1)
        }
      }
      // Positional args: first non-flag after "create"
      const positional = args.slice(1).filter((a, i, arr) => {
        if (a.startsWith("--")) return false
        // Skip value following --branch
        const prev = arr[i - 1]
        if (prev === "--branch") return false
        return true
      })
      const name = positional[0] ?? branchFromFlag
      if (!name) {
        error("Usage: bun worktree create <name> [--branch <branch>]")
        process.exit(1)
      }
      // Branch priority: --branch flag > positional > default (feat/<name>)
      const branch = branchFromFlag ?? positional[1]
      await createWorktree(name, branch, {
        install: !hasFlag("--no-install"),
        direnv: !hasFlag("--no-direnv"),
        hooks: !hasFlag("--no-hooks"),
        allowDirty: hasFlag("--allow-dirty"),
      })
      break
    }

    case "remove":
    case "rm": {
      const name = args[1]
      if (!name) {
        error("Usage: bun worktree remove <name>")
        process.exit(1)
      }
      await removeWorktree(name, {
        deleteBranch: hasFlag("--delete-branch"),
        force: hasFlag("-f") || hasFlag("--force"),
      })
      break
    }

    case "merge": {
      const name = args[1]
      if (!name) {
        error("Usage: bun worktree merge <name>")
        process.exit(1)
      }
      await mergeWorktree(name, {
        deleteBranch: !hasFlag("--keep-branch"),
        fullTests: hasFlag("--full-tests"),
      })
      break
    }

    case "list":
    case "ls":
      await listWorktrees(true)
      break

    case "gc": {
      // Parse --root <dir>
      const rootIdx = args.indexOf("--root")
      let root: string | undefined
      if (rootIdx !== -1) {
        root = args[rootIdx + 1]
        if (!root || root.startsWith("--")) {
          error("--root requires a value")
          process.exit(1)
        }
      }
      // Parse --min-age <hours>
      const ageIdx = args.indexOf("--min-age")
      let minAgeHours = 0
      if (ageIdx !== -1) {
        const v = args[ageIdx + 1]
        if (!v || v.startsWith("--")) {
          error("--min-age requires a value (hours)")
          process.exit(1)
        }
        minAgeHours = parseFloat(v)
        if (isNaN(minAgeHours)) {
          error("--min-age must be a number")
          process.exit(1)
        }
      }
      await gcAgentClones({
        root,
        dryRun: hasFlag("--dry-run"),
        minAgeHours,
        includeUniqueWork: hasFlag("--include-unique-work"),
      })
      break
    }

    case "help":
    case "--help":
    case "-h":
      printHelp()
      break

    default:
      if (command && !command.startsWith("-")) {
        error(`Unknown command: ${command}`)
        printHelp()
        process.exit(1)
      }
      await showDefaultInfo()
  }
}

if (import.meta.main) {
  void main()
}
