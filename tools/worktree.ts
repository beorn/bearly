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

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "fs"
import { join, dirname, basename, relative } from "path"
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
  const r = await safeExec($`cd ${wtPath} && git status --porcelain 2>/dev/null`)
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
 * Canonical pool-slot path: sibling of the repo, named `<repoBasename>-wtN`.
 * Example: repo at /Users/beorn/Code/pim/km → slots at /Users/beorn/Code/pim/km-wt0..wt9.
 *
 * Legacy slots live under `<gitRoot>/.claude/worktrees/wtN`. The audit flags
 * those as `slot-location-drift (legacy)` so they migrate as agents recycle.
 */
function isCanonicalSlotPath(wtPath: string, gitRoot: string): boolean {
  const expectedPrefix = `${gitRoot}-wt`
  if (!wtPath.startsWith(expectedPrefix)) return false
  return /^\d+$/.test(wtPath.slice(expectedPrefix.length))
}

function isLegacySlotPath(wtPath: string, gitRoot: string): boolean {
  const legacyRoot = join(gitRoot, ".claude", "worktrees")
  if (!wtPath.startsWith(legacyRoot + "/")) return false
  return /^wt\d+$/.test(wtPath.slice(legacyRoot.length + 1))
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
      if (isLegacySlotPath(wt.path, gitRoot)) {
        findings.push({
          worktree: wtName,
          branch: wt.branch,
          severity: "info",
          check: "slot-location-legacy",
          message: `legacy slot at ${wt.path} — recycle to canonical sibling location ${gitRoot}-${wtName}`,
          details: { path: wt.path, canonical: `${gitRoot}-${wtName}` },
        })
      } else if (!isCanonicalSlotPath(wt.path, gitRoot)) {
        findings.push({
          worktree: wtName,
          branch: wt.branch,
          severity: "info",
          check: "slot-location-drift",
          message: `worktree at non-canonical path ${wt.path} (canonical: ${gitRoot}-wtN sibling layout)`,
          details: { path: wt.path },
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
    // are SUPPOSED to run the workspace: main + canonical pool slots
    // (<gitRoot>-wtN, where agents run focused vitest; wt5 was the plateau).
    // Non-canonical worktrees (chief's `--fs-only` integration worktrees,
    // ad-hoc clones) deliberately skip submodule init / install, so their
    // submodule + node_modules state is not a readiness defect — flagging it
    // is noise (they are already surfaced via slot-location-drift).
    if (isMain || isCanonicalSlotPath(wt.path, gitRoot)) {
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
            `and bare imports fail before code runs. Fix: cd ${wt.path} && git submodule update --init --recursive ${sub}`,
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
            `Fix: cd ${wt.path} && git submodule update --init --recursive && bun install`,
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

export async function createWorktree(name: string, branch?: string, options: CreateOptions = {}): Promise<void> {
  const { install = true, direnv = true, hooks = true, allowDirty = false } = options

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
  const worktreePath = join(dirname(gitRoot), `${repoName}-${name}`)
  // Slot-pattern names (wt0, wt1, ..., wt9) get a plain branch matching the
  // slot id — agents lease `@agent/N` and expect branch `wtN`. Other names
  // get the `feat/` prefix as a courtesy.
  const branchName = branch ?? (/^wt\d+$/.test(name) ? name : `feat/${name}`)

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

  // Slot-pattern names (wtN, where the branch is also `wtN`) are anonymous
  // pool resources, not stable shared branches. A `bun worktree reset` cycle
  // removes the local branch + recreates the slot — if origin/wtN happens to
  // carry stale ahead commits from a prior agent's push, the recreate must
  // start fresh at origin/main, not inherit that state. Without this gate the
  // reset silently lands at the pre-reset SHA (`@km/all/bun-worktree-reset-
  // silent-no-op`). Non-slot names keep the original behavior — they ARE
  // tracking a stable upstream.
  const isPoolSlot = /^wt\d+$/.test(name) && branchName === name

  let branchArg: string[]
  if (branchExists.exitCode === 0) {
    info(`Using existing branch: ${branchName}`)
    branchArg = [branchName]
  } else if (remoteBranchExists.exitCode === 0 && !isPoolSlot) {
    info(`Tracking remote branch: origin/${branchName}`)
    branchArg = [branchName]
  } else if (isPoolSlot) {
    info(`Creating slot branch ${branchName} at origin/main`)
    branchArg = ["-b", branchName, "origin/main"]
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

export interface ResetOptions {
  /** Discard uncommitted changes and any commits ahead of origin/main. */
  force?: boolean
  /**
   * Before discarding, save the worktree's ahead-of-origin/main commits as
   * `wip/<slug>` in the main repo. No-op when there are no ahead commits.
   * Always runs before remove + create so the save survives the reset.
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
 * origin/main, so accidental data loss requires explicit opt-in.
 *
 * Refuses if invoked from inside the target worktree (the recreate would
 * leave the caller's shell in a removed directory).
 */
export async function resetWorktree(name: string, options: ResetOptions = {}): Promise<void> {
  const { force = false, saveAheadAs, retargetOrigin = false, install = true, direnv = true, hooks = true } = options

  const gitRoot = findGitRoot(process.cwd())
  if (!gitRoot) {
    throw new Error("Not in a git repository")
  }

  const repoName = basename(gitRoot)
  const worktreePath = join(dirname(gitRoot), `${repoName}-${name}`)

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
          `Use --force to discard, or commit/save first.`,
      )
    }
    const aheadResult = await safeExec($`cd ${worktreePath} && git rev-list --count origin/main..HEAD 2>/dev/null`)
    const ahead = parseInt(aheadResult.stdout.trim(), 10) || 0
    if (ahead > 0) {
      throw new Error(
        `Worktree ${name} is ${ahead} commit(s) ahead of origin/main. ` + `Use --force to discard, or push/save first.`,
      )
    }
  }

  // Preflight save-ahead — if requested, snapshot the worktree's ahead-of-
  // origin/main commits to `wip/<slug>` in the main repo before we discard.
  // No-op when there are no ahead commits, so it's safe to set unconditionally.
  if (saveAheadAs) {
    const aheadResult = await safeExec($`cd ${worktreePath} && git rev-list --count origin/main..HEAD 2>/dev/null`)
    const ahead = parseInt(aheadResult.stdout.trim(), 10) || 0
    if (ahead > 0) {
      const tipResult = await safeExec($`cd ${worktreePath} && git rev-parse HEAD`)
      const tipSha = tipResult.stdout.trim()
      const saveBranch = `wip/${saveAheadAs}`
      info(`Saving ${ahead} ahead commit(s) to ${saveBranch}...`)
      // `git branch <name> <sha> --force` overwrites if it exists. We prefer
      // explicit overwrite over a partial save when the slug collides — the
      // caller asked us to save THIS state, not the previous one.
      const saveResult = await safeExec($`cd ${gitRoot} && git branch -f ${saveBranch} ${tipSha}`)
      if (saveResult.exitCode !== 0) {
        throw new Error(
          `Failed to create save branch ${saveBranch} at ${tipSha}: ${saveResult.stdout || "unknown error"}`,
        )
      }
      success(`Saved to ${saveBranch} (${tipSha.slice(0, 8)})`)
    }
  }

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
  await removeWorktree(name, { force: true, deleteBranch: force })

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

export interface MergeOptions {
  deleteBranch?: boolean
  fullTests?: boolean
  /**
   * Skip the `git fetch origin <integration-target>` preflight that detects
   * concurrent integrations. Default `false` — only set when the user knows
   * origin can't have moved (e.g. offline merge, single-session work).
   * See: km-bearly.worktree-merge-origin-race-preflight.
   */
  noFetch?: boolean
}

/**
 * Merge a worktree branch into main and clean up.
 *
 * Origin race preflight (km-bearly.worktree-merge-origin-race-preflight)
 * ----------------------------------------------------------------------
 * Two sessions running independent integrations of the same source branch
 * concurrently can race. Witnessed 2026-04-29: share-resolveTask did
 * `bun worktree merge X` (--no-ff merge onto local main) while silvercode2
 * cherry-picked the same commits onto main and pushed first. Local main
 * ended up 4 commits ahead of origin with content-equivalent but
 * SHA-different history; recovery only worked because trees were byte-identical.
 *
 * Mitigation: before `git merge` runs we
 *   1. `git fetch origin <integration-target>`,
 *   2. compare local <integration-target> vs origin/<integration-target>,
 *   3. abort with a fix-up command if origin has commits we don't.
 *
 * `--no-fetch` (MergeOptions.noFetch) bypasses the preflight when needed
 * (offline, ad-hoc, single-session work).
 */
export async function mergeWorktree(name: string, options: MergeOptions = {}): Promise<void> {
  const { deleteBranch = true, fullTests = false, noFetch = false } = options

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

  // Origin race preflight — see function-level doc and
  // km-bearly.worktree-merge-origin-race-preflight.
  //
  // Two sessions can independently integrate the same source branch and
  // race; if origin/<currentBranch> has commits we don't, our local merge
  // will produce content-equivalent but SHA-different history that's a pain
  // to reconcile. Abort early with a clear fix-up command. Skipped when
  // (a) --no-fetch was passed, or (b) origin doesn't track currentBranch.
  if (!noFetch) {
    const remoteCheck = await safeExec(
      $`cd ${gitRoot} && git rev-parse --verify --quiet refs/remotes/origin/${currentBranch}`,
    )
    if (remoteCheck.exitCode === 0) {
      info(`Fetching origin/${currentBranch} (preflight — pass --no-fetch to skip)`)
      const fetchResult = await safeExec($`cd ${gitRoot} && git fetch origin ${currentBranch}`)
      if (fetchResult.exitCode !== 0) {
        warn(`git fetch origin ${currentBranch} failed — proceeding without preflight`)
      } else {
        // Commits on origin that we don't have locally → origin moved ahead.
        const aheadResult = await safeExec(
          $`cd ${gitRoot} && git rev-list --count ${currentBranch}..origin/${currentBranch}`,
        )
        const aheadCount = parseInt(aheadResult.stdout.trim(), 10) || 0
        if (aheadCount > 0) {
          const localShaResult = await safeExec($`cd ${gitRoot} && git rev-parse ${currentBranch}`)
          const originShaResult = await safeExec($`cd ${gitRoot} && git rev-parse origin/${currentBranch}`)
          const localSha = localShaResult.stdout.trim().slice(0, 12)
          const originSha = originShaResult.stdout.trim().slice(0, 12)
          error(`origin/${currentBranch} moved since local ${currentBranch} was last updated.`)
          console.log(DIM + `  local:  ${localSha}` + RESET)
          console.log(DIM + `  origin: ${originSha} (${aheadCount} commit${aheadCount === 1 ? "" : "s"} ahead)` + RESET)
          console.log("")
          console.log("Pull first:")
          console.log(CYAN + `  cd ${gitRoot} && git pull --ff-only origin ${currentBranch}` + RESET)
          console.log("")
          console.log("Then retry:")
          console.log(CYAN + `  bun worktree merge ${name}` + RESET)
          console.log("")
          console.log(DIM + "Bypass (offline / single-session): bun worktree merge " + name + " --no-fetch" + RESET)
          process.exit(1)
        }
        success(`origin/${currentBranch} is in sync (no race)`)
      }
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
  bun worktree reset <name> [--force]   Recreate worktree at origin/main (DCG-safe slot recovery)
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
  --no-fetch        Skip the origin race preflight (offline / single-session)

${BOLD}REMOVE OPTIONS${RESET}
  --delete-branch   Also delete the branch
  -f, --force       Force removal even with uncommitted changes

${BOLD}RESET OPTIONS${RESET}
  -f, --force            Discard uncommitted changes and ahead-of-main commits
  --save-ahead-as <slug> Save ahead-of-main commits to wip/<slug> before reset
  --retarget-origin      Force-push origin/<name> back to origin/main before recreate
  --no-install           Skip dependency install on recreate
  --no-direnv            Skip direnv allow on recreate
  --no-hooks             Skip hook install on recreate

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
  bun worktree merge my-feature --no-fetch         # Skip origin race preflight
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

    case "reset": {
      const name = args[1]
      if (!name) {
        error("Usage: bun worktree reset <name> [--force] [--save-ahead-as <slug>]")
        process.exit(1)
      }
      const saveAheadIdx = args.indexOf("--save-ahead-as")
      let saveAheadAs: string | undefined
      if (saveAheadIdx !== -1) {
        saveAheadAs = args[saveAheadIdx + 1]
        if (!saveAheadAs || saveAheadAs.startsWith("--")) {
          error("--save-ahead-as requires a slug value")
          process.exit(1)
        }
      }
      try {
        await resetWorktree(name, {
          force: hasFlag("-f") || hasFlag("--force"),
          saveAheadAs,
          retargetOrigin: hasFlag("--retarget-origin"),
          install: !hasFlag("--no-install"),
          direnv: !hasFlag("--no-direnv"),
          hooks: !hasFlag("--no-hooks"),
        })
      } catch (e) {
        error(e instanceof Error ? e.message : String(e))
        process.exit(1)
      }
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
        noFetch: hasFlag("--no-fetch"),
      })
      break
    }

    case "list":
    case "ls":
      await listWorktrees(true)
      break

    case "audit": {
      const json = hasFlag("--json")
      const behindIdx = args.indexOf("--behind-threshold")
      let behindThreshold: number | undefined
      if (behindIdx !== -1) {
        const v = args[behindIdx + 1]
        if (!v || v.startsWith("--")) {
          error("--behind-threshold requires a number")
          process.exit(1)
        }
        const n = parseInt(v, 10)
        if (isNaN(n)) {
          error("--behind-threshold must be a number")
          process.exit(1)
        }
        behindThreshold = n
      }
      const staleIdx = args.indexOf("--stale-days")
      let staleAgeDays: number | undefined
      if (staleIdx !== -1) {
        const v = args[staleIdx + 1]
        if (!v || v.startsWith("--")) {
          error("--stale-days requires a number")
          process.exit(1)
        }
        const n = parseInt(v, 10)
        if (isNaN(n)) {
          error("--stale-days must be a number")
          process.exit(1)
        }
        staleAgeDays = n
      }
      const findings = await auditWorktrees({ json, behindThreshold, staleAgeDays })
      // Exit 1 if any error-severity findings (CI-friendly).
      if (findings.some((f) => f.severity === "error")) process.exit(1)
      break
    }

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
