import { chmodSync, existsSync, lstatSync, readdirSync, realpathSync, rmSync, unlinkSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { lstat, mkdtemp, readdir, realpath, rm, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"

export {
  censusProcessCwds,
  type ProcessCwdCensus,
  type ProcessCwdCensusCommandResult,
  type ProcessCwdCensusDeps,
  type ProcessCwdRow,
} from "./process-census.ts"

/**
 * Guarded recursive removal + scope-bound temp trees.
 *
 * Written after a 2026-07-31 incident, in which a sequential `readdir` walk of
 * `$HOME` deleted 52 top-level entries in ~2 minutes before self-terminating.
 * The audit that followed found exactly ONE of six production delete sites
 * validating anything; the shared test-teardown helper — used by nine test
 * files — had no guard at all.
 *
 * Scope, stated honestly: this is HYGIENE, not a security boundary. An in-process
 * guard binds cooperative callers only, and a raw shell loop running as the same
 * uid ignores it entirely. The real boundary is a separate uid or a sandbox, and
 * nothing in this package is a substitute for one. There is also a residual
 * TOCTOU between `realpath()` and the unlink — documented rather than papered
 * over. What this package buys is narrower and still worth having: correct
 * cleanup is easy to write, and incorrect cleanup is loud instead of silent.
 *
 * Shell callers get the SAME predicate through the `removely` bin (`cli.ts`)
 * rather than a second hand-rolled containment check.
 *
 * Deliberately ABSENT, per the review that followed the incident:
 * - no depth heuristic — macOS `$TMPDIR` is already `/var/folders/xx/…/T`, so a
 *   "must be N levels deep" test passes everything real and forbids nothing;
 * - no mandatory `reason` string — mandatory strings get filled with "cleanup";
 *   attribution belongs in log LOCATION, not call-site text;
 * - no recursive chmod before delete — that is itself a full-tree walk (it is
 *   what made the incident take two minutes) and it strips exactly the read-only
 *   bits a canary would rely on. Create fixtures deletable instead.
 */

export interface SafeRemoveOptions {
  /**
   * MANDATORY containment root. There is no default and it is not optional: a
   * delete that cannot name what it is allowed to touch does not compile. This
   * is the whole point of the primitive — every call site is forced to answer
   * the question nobody asked at any of the six audited sites.
   */
  readonly within: string
  /** Absent target throws unless this is passed explicitly. No blanket `force`. */
  readonly allowMissing?: boolean
  /**
   * Retries for `ENOTEMPTY`, which is what a live process writing into the tree
   * produces mid-delete. In the incident this is why `~/.config`, `~/Music` and
   * `~/.local` survived as empty shells. Default 3.
   */
  readonly retries?: number
  /** Injectable for tests. Defaults to `[realpath(os.tmpdir())]`. */
  readonly allowedRoots?: readonly string[]
  /** Explicitly unlink a symlink leaf without following its target. Default: refuse. */
  readonly symlinkLeaf?: "unlink"
}

/**
 * Segment-wise strict descendant. `/tmp/foo-evil` is NOT under `/tmp/foo`.
 *
 * Exported because the containment QUESTION outlives the delete. Callers that
 * must merely *ask* it — a prune loop's bound, "is this process cwd mine to
 * kill", "does this config path escape the checkout" — were each hand-rolling
 * an answer, and the copies disagreed on the one thing that matters: whether a
 * path that merely prefixes the root counts as inside it. Three of them said
 * yes. Two of those guarded a delete.
 *
 * Deliberately LEXICAL and deliberately STRICT:
 *   - lexical — it does no `realpath`, so it is safe in hot loops and on paths
 *     that do not exist yet. When the answer must survive a symlink, use
 *     `safeRemove`/`safeRemoveSync`, which resolve both sides first.
 *   - strict — `isStrictlyInside(p, p)` is `false`. Equality is the case the
 *     hand-rolled copies split on, so it is spelled at the call site
 *     (`path === root || isStrictlyInside(path, root)`) rather than hidden
 *     behind an option nobody reads.
 *
 * Both arguments must already be absolute and normalized (`resolve()` them).
 */
export function isStrictlyInside(child: string, parent: string): boolean {
  if (child === parent) return false
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

declare const containedPathBrand: unique symbol

/** Absolute path whose physical destination is proven inside one root. */
export type ContainedPath = string & { readonly [containedPathBrand]: true }

export interface ResolveContainedPathOptions {
  /** Root equality is refused unless the caller states that it is intentional. */
  readonly allowRoot?: boolean
  /** Follow an existing symlink leaf by default; false proves the leaf itself. */
  readonly followLeaf?: boolean
}

/**
 * Resolve an existing or prospective path against its nearest existing
 * ancestor, then prove physical containment with the package's one predicate.
 */
export function resolveContainedPath(
  target: string,
  within: string,
  options: ResolveContainedPathOptions = {},
): ContainedPath {
  return resolveContainedPathForCaller(target, within, options, "resolveContainedPath")
}

/** Find the first matching physical ancestor, inclusive, without leaving `within`. */
export function findAncestorWithin(
  start: string,
  within: string,
  predicate: (directory: ContainedPath) => boolean,
): ContainedPath | null {
  const boundary = resolveContainedPath(within, within, { allowRoot: true })
  let current = resolveContainedPath(start, boundary, { allowRoot: true })

  for (;;) {
    if (predicate(current)) return current
    if (current === boundary) return null
    current = resolveContainedPath(dirname(current), boundary, { allowRoot: true })
  }
}

/**
 * Resolve the enclosing Git/superproject island. Returns null only when the
 * directory is valid but outside Git; execution and repository errors throw.
 */
export function findGitProjectRoot(cwd: string): string | null {
  const args = ["-C", cwd, "rev-parse", "--show-superproject-working-tree", "--show-toplevel"]
  const result = spawnSync("git", args, {
    encoding: "utf8",
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (result.error) {
    throw new Error(`git project boundary probe failed for ${cwd}: ${result.error.message}`, { cause: result.error })
  }

  const stdout = (result.stdout ?? "").trim()
  if (result.status === 0) {
    const root = stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean)
    if (root) return root
    throw new Error(`git project boundary probe failed for ${cwd}: git returned no project root`)
  }

  const stderr = (result.stderr ?? "").trim()
  if (result.status === 128 && /not a git repository/u.test(stderr)) return null
  const detail = stderr || stdout || `git exited ${String(result.status)}`
  throw new Error(`git project boundary probe failed for ${cwd}: ${detail}`)
}

function resolveContainedPathForCaller(
  target: string,
  within: string,
  options: ResolveContainedPathOptions,
  caller: string,
): ContainedPath {
  const raw = typeof target === "string" ? target.trim() : ""
  if (raw.length === 0) throw new Error(`${caller}: empty target`)
  const withinRaw = typeof within === "string" ? within.trim() : ""
  if (withinRaw.length === 0) throw new Error(`${caller}: empty containment root for target ${raw}`)

  let withinReal: string
  try {
    withinReal = realpathSync(withinRaw)
  } catch {
    throw new Error(`${caller}: containment root does not resolve: ${withinRaw}`)
  }

  const absoluteTarget = resolve(raw)
  const followLeaf = options.followLeaf !== false
  const segments: string[] = followLeaf ? [] : [basename(absoluteTarget)]
  let existingAncestor = followLeaf ? absoluteTarget : dirname(absoluteTarget)
  while (!pathEntryExists(existingAncestor)) {
    const parent = dirname(existingAncestor)
    if (parent === existingAncestor) break
    segments.unshift(basename(existingAncestor))
    existingAncestor = parent
  }

  const resolvedTarget = resolve(realpathExistingEntry(existingAncestor, raw, caller), ...segments)
  const rootAllowed = options.allowRoot === true && resolvedTarget === withinReal
  if (!rootAllowed && !isStrictlyInside(resolvedTarget, withinReal)) {
    throw new Error(
      `${caller}: REFUSED. Resolved target ${resolvedTarget} is not strictly inside resolved root ${withinReal}. (Requested target: ${raw}.)`,
    )
  }
  return resolvedTarget as ContainedPath
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

function realpathExistingEntry(path: string, requested: string, caller: string): string {
  try {
    return realpathSync(path)
  } catch (cause) {
    throw new Error(
      `${caller}: cannot prove physical containment for ${requested}; resolve or remove the dangling symlink before retrying`,
      { cause },
    )
  }
}

/**
 * Normalize an allowed root for comparison against a resolved `within`.
 *
 * A root that does not exist is NOT an error here — `allowedRoots` is a policy
 * list, and "this root is not on disk" is a legitimate way for a candidate to
 * fail the containment test. It is normalized with `resolve()` so it still
 * compares as a path rather than being dropped, which would silently widen the
 * policy instead of narrowing it.
 */
function resolveForComparison(root: string): string {
  try {
    return realpathSync(root)
  } catch {
    return resolve(root)
  }
}

/**
 * Remove `target` recursively, or throw explaining exactly why it refused.
 * Never returns a boolean, never silently no-ops: a guard that can be ignored
 * by a caller who forgot to check is not a guard.
 */
/**
 * The whole refusal predicate, in ONE place. Both `safeRemove` and
 * `safeRemoveSync` call it, so there is exactly one definition of "may I delete
 * this" — the consolidate-first rule applied to the surface that most needs it.
 * Returns the resolved target, or `null` when an absent target was explicitly
 * declared expected.
 */
interface RemovalTarget {
  readonly path: string
  readonly kind: "recursive" | "symlink-leaf"
}

function resolveRemovalTarget(target: string, options: SafeRemoveOptions, caller: string): RemovalTarget | null {
  const raw = typeof target === "string" ? target.trim() : ""
  if (raw.length === 0) {
    throw new Error(
      `${caller}: empty target. An unset or mis-expanded path is the single most dangerous input this function can receive, so it is an error rather than a silent no-op.`,
    )
  }
  const withinRaw = options.within?.trim() ?? ""
  if (withinRaw.length === 0) {
    throw new Error(`${caller}: empty containment root for target ${raw}. \`within\` is mandatory.`)
  }

  // Resolve the root first. A root that does not exist is a programming error,
  // not a reason to skip the check.
  let withinReal: string
  try {
    withinReal = realpathSync(withinRaw)
  } catch {
    throw new Error(`${caller}: containment root does not resolve: ${withinRaw}`)
  }

  // `within` is compared in RESOLVED form, so the allowed roots must be too, or
  // the comparison is between two different naming systems. `/tmp` is a symlink
  // to `/private/tmp` on macOS: an unresolved allowed root of `/tmp` rejects a
  // `within` of `/tmp` — a refusal with a correct-sounding message and no bug in
  // the caller. The default was already resolved; caller-supplied ones were not.
  const allowed = (options.allowedRoots ?? [tmpdir()]).map(resolveForComparison)
  const rootOk = allowed.some((root) => withinReal === root || isStrictlyInside(withinReal, root))
  if (!rootOk) {
    throw new Error(
      `${caller}: containment root ${withinReal} is not under an allowed root (${allowed.join(", ")}). Deleting outside these requires an explicit \`allowedRoots\`.`,
    )
  }

  const absoluteRaw = resolve(raw)
  let isSymlinkLeaf = false
  try {
    isSymlinkLeaf = lstatSync(absoluteRaw).isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    if (options.allowMissing === true) return null
    throw new Error(
      `${caller}: target does not exist: ${raw}. Pass \`allowMissing: true\` if that is expected — a blanket force is how a wrong path becomes invisible.`,
    )
  }

  if (isSymlinkLeaf && options.symlinkLeaf !== "unlink") {
    throw new Error(
      `${caller}: REFUSED symlink leaf ${raw}. Pass \`symlinkLeaf: "unlink"\` to unlink the leaf without following its target.`,
    )
  }

  const unlinkLeaf = isSymlinkLeaf
  const targetReal = resolveContainedPathForCaller(raw, withinRaw, { followLeaf: !unlinkLeaf }, caller)
  return { path: targetReal, kind: unlinkLeaf ? "symlink-leaf" : "recursive" }
}

/**
 * Synchronous sibling, for callers that cannot await — notably vitest teardown
 * helpers already written as sync loops. Identical refusal predicate; the only
 * difference is the removal call.
 */
export function safeRemoveSync(target: string, options: SafeRemoveOptions): void {
  const resolved = resolveRemovalTarget(target, options, "safeRemoveSync")
  if (resolved === null) return
  const targetReal = resolved.path

  const retries = options.retries ?? 3
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (resolved.kind === "symlink-leaf") unlinkSync(targetReal)
      else rmSync(targetReal, { recursive: true })
      break
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException).code
      // EACCES/EPERM: a fixture wrote something read-only. Widen ONLY then, and
      // only under the already-verified containment root — never as a routine
      // pre-pass, which on a large tree is itself a multi-minute walk and
      // strips exactly the read-only bits a canary would rely on.
      if (code === "EACCES" || code === "EPERM") {
        widenWritable(targetReal)
        continue
      }
      if (code !== "ENOTEMPTY" && code !== "EBUSY") throw error
    }
  }

  const survivor = lstatOrNull(targetReal)
  if (survivor) {
    const survivors = survivor.isDirectory() && !survivor.isSymbolicLink() ? readdirSync(targetReal) : []
    throw new Error(
      `safeRemoveSync: ${targetReal} still exists after removal (${survivors.length} entries).${
        survivors.length > 0 ? ` Survivors: ${survivors.slice(0, 10).join(", ")}` : ""
      } Last error: ${String(lastError)}`,
    )
  }
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

/** Recursive chmod, used ONLY as an EACCES/EPERM fallback inside a verified root. */
function widenWritable(path: string): void {
  if (!existsSync(path)) return
  const info = lstatSync(path)
  if (info.isSymbolicLink()) return
  chmodSync(path, info.mode | 0o700)
  if (info.isDirectory()) {
    for (const entry of readdirSync(path)) widenWritable(join(path, entry))
  }
}

export async function safeRemove(target: string, options: SafeRemoveOptions): Promise<void> {
  const resolved = resolveRemovalTarget(target, options, "safeRemove")
  if (resolved === null) return
  const targetReal = resolved.path

  const retries = options.retries ?? 3
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (resolved.kind === "symlink-leaf") await unlink(targetReal)
      else await rm(targetReal, { recursive: true })
      break
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOTEMPTY" && code !== "EBUSY") throw error
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20 * (attempt + 1))
      })
    }
  }

  // Verify. A cleanup that silently no-ops leaving the caller green is the
  // dominant defect class this whole bead exists to kill.
  const survivor = await lstat(targetReal).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null
    throw error
  })
  if (survivor?.isDirectory() && !survivor.isSymbolicLink()) {
    const survivors = await readdir(targetReal)
    const detail = survivors.length > 0 ? ` Survivors: ${survivors.slice(0, 10).join(", ")}` : ""
    throw new Error(
      `safeRemove: ${targetReal} still exists after removal (${survivors.length} entries).${detail} Last error: ${String(lastError)}`,
    )
  }
  if (survivor !== null) {
    throw new Error(`safeRemove: ${targetReal} still exists after removal (non-directory).`)
  }
}

export interface TempTree extends AsyncDisposable {
  /** Absolute, realpath-resolved fixture root. */
  readonly path: string
  /** Join under the fixture root. Never escapes it. */
  resolve(...segments: readonly string[]): string
}

export interface TempTreeOptions {
  /** Parent for the fixture. Defaults to `os.tmpdir()`. Must be under an allowed root. */
  readonly parent?: string
  readonly allowedRoots?: readonly string[]
}

/**
 * Scope-bound temp tree.
 *
 *     await using fixture = await tempTree("hab-config-")
 *     const cfg = fixture.resolve("hab.yml")
 *
 * The create/destroy pairing is established AT CREATION and enforced by the
 * language, so it cannot be lost the way a `dirs[]` array plus a trailing
 * teardown step can. Modelled on Go's `t.TempDir()` (cleanup registered at
 * creation, runs on panic, removal failure fails the test) and JUnit 5's
 * `@TempDir`. Explicitly NOT modelled on Rust's `tempfile::TempDir`, whose
 * `Drop`-based cleanup cannot report errors — silent-by-construction cleanup is
 * the wart we are trying to remove, and `Symbol.asyncDispose` lets us throw.
 */
export async function tempTree(prefix: string, options: TempTreeOptions = {}): Promise<TempTree> {
  const parent = await realpath(options.parent ?? tmpdir())
  const created = await mkdtemp(join(parent, prefix))
  const path = await realpath(created)
  return {
    path,
    resolve(...segments: readonly string[]): string {
      return join(path, ...segments)
    },
    async [Symbol.asyncDispose](): Promise<void> {
      await safeRemove(path, { within: parent, allowedRoots: options.allowedRoots })
    },
  }
}
