import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

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
