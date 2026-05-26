/**
 * Standalone-codex worktree-isolation guardrail.
 *
 * Tribe SOP §F2a says: "Main repo's working dir stays on `main`. Conflict-prone
 * work goes in a pool slot." Standalone codex (and any MCP client spawned
 * outside the worktree-aware launcher) inherits the user's invocation cwd.
 * The default invocation cwd is the main repo → it leaks edits into main.
 *
 * This module is the cwd check + decision logic, isolated so it's pure and
 * unit-testable. The stdio-adapter calls `evaluateCwdPolicy(...)` once at
 * register-time and dispatches based on the result.
 *
 * Detection (all must hold to consider the session "in the main repo"):
 *   - `cwd` matches `git rev-parse --show-toplevel` exactly.
 *   - HEAD branch is `main` or `master`.
 *   - `cwd` does NOT match the `<basename>-wt<N>` pool-slot naming pattern.
 *   - At least one sibling `<basename>-wt<N>` directory exists (pool is set up).
 *
 * Policy via env `TRIBE_MAIN_REPO_POLICY` (default `warn`):
 *   - `ignore` — skip the check entirely. Use this for chief integration
 *      sessions or exploratory shells where main-repo cwd is legitimate.
 *   - `warn`   — log to debug + send a startup tribe channel notification
 *      pointing the agent at `bun worktree create wtN`.
 *   - `refuse` — same warning, plus a louder marker the agent surfaces.
 *      No process exit — the daemon still registers; the agent decides
 *      whether to proceed.
 *
 * `BEARLY_ALLOW_MAIN_REPO_CWD=1` is a synonym for `ignore` (matches the
 * spawn-wrapper convention used elsewhere in the worktree pool).
 *
 * @agent/N-claimed sessions follow the slot convention by construction (they
 * register from inside `<basename>-wt<N>`) so this check is a no-op for them.
 */

import { existsSync } from "node:fs"
import { basename, dirname } from "node:path"
import { spawnSync } from "node:child_process"

export type CwdPolicy = "warn" | "refuse" | "ignore"

export type CwdProbe = {
  /** `process.cwd()` at startup. */
  cwd: string
  /** `git rev-parse --show-toplevel` from cwd, or null if not a repo. */
  gitRoot: string | null
  /** Current branch (from `git rev-parse --abbrev-ref HEAD`), or null. */
  headBranch: string | null
  /** Names of sibling dirs that match `<basename>-wt<N>` pattern. */
  siblingPoolSlots: string[]
}

export type CwdEvaluation =
  | { kind: "ignored"; reason: string }
  | { kind: "ok"; reason: string }
  | { kind: "warn"; message: string }
  | { kind: "refuse"; message: string }

/** Parse a policy string from env. Unknown values fall back to `warn`. */
export function parseCwdPolicy(raw: string | undefined): CwdPolicy {
  if (raw === "ignore" || raw === "warn" || raw === "refuse") return raw
  return "warn"
}

/** Read policy from process env, honoring the `BEARLY_ALLOW_MAIN_REPO_CWD=1` escape hatch. */
export function readCwdPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): CwdPolicy {
  if (env.BEARLY_ALLOW_MAIN_REPO_CWD === "1" || env.BEARLY_ALLOW_MAIN_REPO_CWD === "true") return "ignore"
  return parseCwdPolicy(env.TRIBE_MAIN_REPO_POLICY)
}

/** True if `name` matches `<basename>-wt<N>` (e.g. `km-wt5`). */
export function isPoolSlotName(name: string): boolean {
  return /-wt\d+$/.test(name)
}

/** Find sibling `<basename>-wt<N>` directories. */
export function findSiblingPoolSlots(repoRoot: string): string[] {
  const parent = dirname(repoRoot)
  const repoBasename = basename(repoRoot)
  const slots: string[] = []
  // No directory scan needed — we just check the canonical pool range. Cheap.
  for (let n = 0; n < 10; n++) {
    const slotName = `${repoBasename}-wt${n}`
    const slotPath = `${parent}/${slotName}`
    if (existsSync(slotPath)) slots.push(slotName)
  }
  return slots
}

/** Build the canonical "migrate to a worktree" one-liner referenced by the bead. */
export function migrationOneLiner(repoRoot: string): string {
  const repoBasename = basename(repoRoot)
  // Pick the lowest free slot index for the hint (best-effort — agent may
  // pick a different one). We don't read the pool here to keep this string
  // builder side-effect-free.
  return `bun worktree create wtN && cd ../${repoBasename}-wtN`
}

/**
 * Pure decision: given a policy and a probe of the environment, return what
 * the adapter should do. No I/O — caller threads probe in.
 */
export function evaluateCwdPolicy(policy: CwdPolicy, probe: CwdProbe): CwdEvaluation {
  if (policy === "ignore") {
    return { kind: "ignored", reason: "policy=ignore (or BEARLY_ALLOW_MAIN_REPO_CWD=1)" }
  }

  // Not in a git repo → nothing to enforce.
  if (!probe.gitRoot) {
    return { kind: "ok", reason: "cwd is not inside a git repo" }
  }

  // Caller is already inside a `<basename>-wtN` worktree → already correct.
  // Two signals: (a) cwd is exactly the sibling-wtN path, (b) cwd basename matches.
  // We rely on the basename rule because gitRoot of a worktree == the worktree path.
  if (isPoolSlotName(basename(probe.gitRoot))) {
    return { kind: "ok", reason: `cwd is pool slot ${basename(probe.gitRoot)}` }
  }

  // Not on main/master → presumably a feature branch worktree or detached HEAD
  // somewhere intentional. Don't warn.
  const branch = probe.headBranch ?? ""
  if (branch !== "main" && branch !== "master") {
    return { kind: "ok", reason: `HEAD is on ${branch || "(unknown)"}, not main` }
  }

  // No worktree pool set up yet → can't recommend a slot.
  if (probe.siblingPoolSlots.length === 0) {
    return { kind: "ok", reason: "no `<repo>-wt<N>` pool detected — solo repo, no isolation needed" }
  }

  // We're in main, on main, with a pool sitting next door. That's the leak shape.
  const projectBasename = basename(probe.gitRoot)
  const oneLiner = migrationOneLiner(probe.gitRoot)
  const baseMsg =
    `tribe: standalone session running in main repo (${projectBasename}) on branch ${branch}. ` +
    `Tribe SOP §F2a says main stays on main — edits should land in a pool slot. ` +
    `Migrate with: ${oneLiner}. ` +
    `Pool slots present: ${probe.siblingPoolSlots.join(", ")}. ` +
    `Set TRIBE_MAIN_REPO_POLICY=ignore (or BEARLY_ALLOW_MAIN_REPO_CWD=1) to silence this for legitimate chief / exploratory sessions.`

  if (policy === "refuse") {
    return { kind: "refuse", message: `REFUSE: ${baseMsg}` }
  }
  return { kind: "warn", message: baseMsg }
}

/**
 * Probe the live environment. Synchronous so we can call it during adapter
 * bootstrap before the daemon connection is established. Failures degrade
 * gracefully — every field is nullable.
 */
export function probeCwd(cwd: string = process.cwd()): CwdProbe {
  const git = (args: string[]): string | null => {
    try {
      const res = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      if (res.status !== 0) return null
      return res.stdout.trim() || null
    } catch {
      return null
    }
  }
  const gitRoot = git(["rev-parse", "--show-toplevel"])
  const headBranch = gitRoot ? git(["rev-parse", "--abbrev-ref", "HEAD"]) : null
  const siblingPoolSlots = gitRoot ? findSiblingPoolSlots(gitRoot) : []
  return { cwd, gitRoot, headBranch, siblingPoolSlots }
}
