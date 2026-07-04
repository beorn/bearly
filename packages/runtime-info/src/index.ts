import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

export interface RuntimeInfo {
  /** Product/tool semver from the owning package or an explicit fallback. */
  version: string
  /** Short git SHA the process is running, or null when git is unavailable. */
  sha: string | null
  /** True when the worktree has uncommitted changes. */
  dirty: boolean
}

export interface RuntimeInfoCommandResult {
  status: number
  stdout: string
}

export interface RuntimeInfoDeps {
  cwd: string
  sh: (cmd: string, args: readonly string[]) => RuntimeInfoCommandResult
}

export function nodeRuntimeInfoDeps(cwd = process.cwd()): RuntimeInfoDeps {
  return {
    cwd,
    sh: (cmd, args) => {
      const r = spawnSync(cmd, [...args], { cwd, encoding: "utf-8", timeout: 5_000 })
      return { status: r.status ?? 1, stdout: r.stdout ?? "" }
    },
  }
}

export function readPackageVersion(packageJsonPath: string, fallback = "0.0.0"): string {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version?: unknown }
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : fallback
  } catch {
    // silent-fallback-allow: version DISPLAY only. A missing package.json must
    // produce an explicit semver fallback, not block --version diagnostics.
    return fallback
  }
}

/** Read the worktree short HEAD SHA + dirty flag for the code this process loaded. */
export function readGitState(deps: RuntimeInfoDeps): Pick<RuntimeInfo, "sha" | "dirty"> {
  const head = deps.sh("git", ["rev-parse", "--short", "HEAD"])
  const sha = head.status === 0 && head.stdout.trim().length > 0 ? head.stdout.trim() : null
  const status = deps.sh("git", ["status", "--porcelain"])
  const dirty = status.status === 0 && status.stdout.trim().length > 0
  return { sha, dirty }
}

export function runtimeInfoFromParts(version: string, sha: string | null, dirty: boolean): RuntimeInfo {
  return { version, sha, dirty }
}

/** Compose the running-code identity from an explicit semver plus an injected git read. */
export function composeRuntimeInfo(version: string, deps: RuntimeInfoDeps = nodeRuntimeInfoDeps()): RuntimeInfo {
  const { sha, dirty } = readGitState(deps)
  return runtimeInfoFromParts(version, sha, dirty)
}

export function formatRuntimeInfo(info: RuntimeInfo): string {
  return `${info.version}+${info.sha ?? "unknown"}${info.dirty ? "-dirty" : ""}`
}

export function formatRuntimeInfoLine(name: string, info: RuntimeInfo): string {
  return `${name} ${formatRuntimeInfo(info)}`
}

// ─── Workspace install-state ────────────────────────────────────────────────
//
// The stale-installed-tree incident class (observed 2026-07-02): a commit
// adding a NEW workspace package lands on main; in every other checkout plain
// `bun install` no-ops (its fast-path compares lockfile↔manifests and skips
// tree reconciliation without verifying member links), so `bun run` crashes
// with `Cannot find module '<new-package>'` until `bun install --force`.
// Lockfile-level checks (`--frozen-lockfile`, `bun pm ls`) are structurally
// blind to this: the lockfile was already correct — the INSTALLED TREE was
// stale. The only truthful oracle is the runtime resolver itself, anchored at
// each dependent (a nested-only member may legitimately lack a root-level
// `node_modules/<name>` link).

export interface WorkspaceDepEdge {
  /** Package that declares the dependency (the repo root uses its own name or "<root>"). */
  readonly dependent: string
  /** Absolute dir of the dependent package — the resolution anchor. */
  readonly dependentDir: string
  /** The `workspace:*` dependency name that must resolve from `dependentDir`. */
  readonly dep: string
}

export interface WorkspaceInstallState {
  /** Total `workspace:*` edges checked. */
  readonly checkedEdges: number
  /** Edges whose dep does NOT resolve from its dependent — the installed tree is stale. */
  readonly unresolved: ReadonlyArray<WorkspaceDepEdge>
}

/** True when a dep is installed for `fromDir` (see linkPresenceResolver). */
export type WorkspaceDepResolver = (dep: string, fromDir: string) => boolean

/**
 * Default predicate: walk `fromDir` upward and require a RESOLVING
 * `node_modules/<dep>/package.json` on the search path (existsSync follows
 * symlinks, so a dangling link counts as absent).
 *
 * Deliberately LINK PRESENCE, not bare-name resolvability: the stale artifact
 * in the incident was a missing workspace link, while a present-and-healthy
 * package may legitimately fail bare resolution because its exports map has no
 * "." entry (a subpath-only package, e.g. one exporting only "./paths") — full
 * entry resolution would false-positive on every subpath-only package.
 */
export function linkPresenceResolver(): WorkspaceDepResolver {
  return (dep, fromDir) => {
    let dir = fromDir
    for (;;) {
      if (existsSync(join(dir, "node_modules", dep, "package.json"))) return true
      const parent = dirname(dir)
      if (parent === dir) return false
      dir = parent
    }
  }
}

interface ManifestDeps {
  readonly name: string | null
  readonly workspaceDeps: string[]
}

/** Read a package.json's name + its `workspace:*` dep names (dependencies + devDependencies). */
function readManifestWorkspaceDeps(pkgJsonPath: string): ManifestDeps | null {
  if (!existsSync(pkgJsonPath)) return null
  let pkg: {
    name?: unknown
    dependencies?: Record<string, unknown>
    devDependencies?: Record<string, unknown>
  }
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as typeof pkg
  } catch {
    // silent-fallback-allow: a malformed member package.json skips that member's
    // edges only; the member itself is surfaced by whoever fails to import it.
    return null
  }
  const workspaceDeps: string[] = []
  for (const record of [pkg.dependencies, pkg.devDependencies]) {
    if (typeof record !== "object" || record === null) continue
    for (const [dep, spec] of Object.entries(record)) {
      if (typeof spec === "string" && spec.startsWith("workspace:")) workspaceDeps.push(dep)
    }
  }
  return { name: typeof pkg.name === "string" ? pkg.name : null, workspaceDeps }
}

/** Expand a root `workspaces` glob (`dir/*` or a literal dir) to member dirs containing a package.json. */
function expandWorkspaceMemberGlob(root: string, glob: string): string[] {
  const star = glob.match(/^(.*)\/\*$/)
  if (!star) {
    const lit = join(root, glob)
    return existsSync(join(lit, "package.json")) ? [lit] : []
  }
  const prefix = join(root, star[1] ?? "")
  if (!existsSync(prefix)) return []
  const out: string[] = []
  for (const entry of readdirSync(prefix, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const dir = join(prefix, entry.name)
    if (existsSync(join(dir, "package.json"))) out.push(dir)
  }
  return out
}

/** All `workspace:*` dep edges declared by the root package + every workspace member. */
export function workspaceDepEdges(root: string): WorkspaceDepEdge[] {
  const rootPkgPath = join(root, "package.json")
  const edges: WorkspaceDepEdge[] = []
  const rootManifest = readManifestWorkspaceDeps(rootPkgPath)
  if (rootManifest !== null) {
    for (const dep of rootManifest.workspaceDeps) {
      edges.push({ dependent: rootManifest.name ?? "<root>", dependentDir: root, dep })
    }
  }
  let globs: string[] = []
  if (existsSync(rootPkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(rootPkgPath, "utf-8")) as { workspaces?: unknown }
      globs = Array.isArray(pkg.workspaces) ? pkg.workspaces.filter((g): g is string => typeof g === "string") : []
    } catch {
      // silent-fallback-allow: unreadable root manifest yields zero member edges;
      // the root-edge pass above already failed the same parse and reported null.
      globs = []
    }
  }
  for (const glob of globs) {
    for (const dir of expandWorkspaceMemberGlob(root, glob)) {
      const manifest = readManifestWorkspaceDeps(join(dir, "package.json"))
      if (manifest === null) continue
      for (const dep of manifest.workspaceDeps) {
        edges.push({ dependent: manifest.name ?? dir, dependentDir: dir, dep })
      }
    }
  }
  return edges
}

/**
 * Verify every `workspace:*` edge resolves with the runtime resolver. O(edges),
 * no install, no lockfile trust — this catches exactly the stale-installed-tree
 * class that `bun install`'s satisfied fast-path misses.
 */
export function readWorkspaceInstallState(
  root: string,
  resolve: WorkspaceDepResolver = linkPresenceResolver(),
): WorkspaceInstallState {
  const edges = workspaceDepEdges(root)
  const unresolved = edges.filter((edge) => !resolve(edge.dep, edge.dependentDir))
  return { checkedEdges: edges.length, unresolved }
}
