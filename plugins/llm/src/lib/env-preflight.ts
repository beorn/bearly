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
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
}

/**
 * The `.env` paths a direnv-managed checkout would load, most local first:
 * the cwd, the enclosing working tree, and the main checkout it belongs to.
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
    add(git(["rev-parse", "--show-toplevel"], root))
    add(dirname(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], root)))
  } catch {
    // No git on PATH, or not a repo. cwd is then the only path we can honestly
    // name, and we still name it. Non-fatal by construction: this runs only
    // while building an error that is about to be thrown anyway.
  }
  return candidates
}

/** True when any provider credential at all reached this process. */
function anyProviderKeySet(): boolean {
  return Object.entries(process.env).some(([name, value]) => name.endsWith("_API_KEY") && !!value)
}

/**
 * Build the error thrown when a provider's key is absent.
 *
 * Keeps the `<VAR> not set` prefix every existing caller, log and doc greps
 * for, and appends the cause the reader actually needs. `cwd` is injectable so
 * both branches are testable without `process.chdir`, which throws under
 * Vitest's worker-thread pool.
 */
export function missingApiKeyError(envVar: string, cwd: string = process.cwd()): Error {
  if (anyProviderKeySet()) {
    return new Error(
      `${envVar} not set. Other *_API_KEY variables are set, so an env file did load — ` +
        `this key is missing from it or misspelled.`,
    )
  }

  const candidates = envFileCandidates(cwd)
  const present = candidates.filter((path) => existsSync(path))
  const remedy = present.length
    ? `${present.join(" and ")} exists but did not reach this process — run \`direnv allow\` here ` +
      `(a freshly created git worktree is never allowed yet), then \`direnv reload\`.`
    : `no env file exists at ${candidates.join(" or ")} — create one in the main checkout; ` +
      `worktrees inherit it through .envrc rather than getting their own copy.`

  return new Error(`${envVar} not set — and no *_API_KEY is set at all, so this process loaded no env file. ${remedy}`)
}
