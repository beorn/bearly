/**
 * Neutral exact-bytes file CAS. Every cooperating writer uses the same adjacent lock.
 * Policy (schema, generation, refusal detail) remains with each caller.
 */
import { tryAcquireFlock } from "@bearly/flock"
import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import { atomicWriteFileSync, syncDirectorySync } from "./atomic.ts"

export type ExactFileCommitResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "locked" }
  | { readonly ok: false; readonly reason: "changed"; readonly currentRaw: string | null }

export type LockedFileWriteResult = { readonly ok: true } | { readonly ok: false; readonly reason: "locked" }

/**
 * Publish complete bytes iff `path` still contains the exact bytes the caller
 * observed (`null` means observed absence). The adjacent kernel lock closes the
 * compare→rename window; the raw compare closes the read→lock window.
 */
export function commitFileBytesIfUnchanged(
  path: string,
  expectedRaw: string | null,
  nextRaw: string,
): ExactFileCommitResult {
  return withAdjacentFileLock(path, () => {
    const currentRaw = readRawOrNull(path)
    if (currentRaw !== expectedRaw) return { ok: false, reason: "changed", currentRaw }
    atomicWriteFileSync(path, nextRaw)
    return { ok: true }
  })
}

/**
 * Remove `path` iff it still contains the exact bytes the caller observed. The
 * inverse of `commitFileBytesIfUnchanged`: a caller withdraws a record it
 * published itself, and any other writer's row wins untouched. Deleting is
 * published under the same adjacent kernel lock as a CAS write, so a reader
 * never observes a half-removed record.
 */
export function removeFileBytesIfUnchanged(path: string, expectedRaw: string): ExactFileCommitResult {
  return withAdjacentFileLock(path, () => {
    const currentRaw = readRawOrNull(path)
    if (currentRaw !== expectedRaw) return { ok: false, reason: "changed", currentRaw }
    rmSync(path, { force: true })
    syncDirectorySync(dirname(path))
    return { ok: true }
  })
}

/**
 * Withdraw `path` AND its adjacent lock file iff `path` still holds the exact
 * bytes the caller observed, both inside ONE held lock.
 *
 * A released flock file is not safe to unlink on its own: an opener that had
 * already opened it keeps an orphaned inode while a later opener creates a fresh
 * file at the same path and acquires THAT, so two holders share one path and no
 * error anywhere reports it. Unlinking the lock file therefore belongs inside
 * the same held lock as the record's removal -- which `removeFileBytesIfUnchanged`
 * cannot express, because it takes the lock itself and withdraws the record only.
 *
 * The residual, stated WITH the preconditions it rests on rather than left
 * implicit: an opener that had already opened the old lock file before this
 * unlink, and acquires it after this process releases, reaches a path whose bytes
 * are GONE. For the stale writer this primitive is written against -- a
 * compare-and-swap against the NON-NULL byte string it observed -- that is a
 * refusal: its own CAS sees absent bytes and does not match, so holding the old
 * lock resurrects nothing.
 *
 * That argument is NOT universal, and the shapes it does not cover are named. It
 * assumes a RETIRED path that is not reused and a competing writer that compares
 * and swaps: an UNCONDITIONAL write, or a CAS whose expected value is ABSENT
 * (which can create the now-absent path), can still create the path; and a caller that
 * deliberately creates a record at a retired path afterwards is writing a NEW
 * record, not resurrecting the withdrawn one. What this primitive guarantees is
 * narrow on purpose: it withdraws ONE record holding the exact bytes the caller
 * observed, together with its adjacent lock, under one held lock. It does not make
 * the path unwritable, and it does not forbid a later, intentional create.
 */
export function removeFileBytesAndLockIfUnchanged(path: string, expectedRaw: string): ExactFileCommitResult {
  return withAdjacentFileLock(path, () => {
    const currentRaw = readRawOrNull(path)
    if (currentRaw !== expectedRaw) return { ok: false, reason: "changed", currentRaw }
    rmSync(path, { force: true })
    syncDirectorySync(dirname(path))
    // While the fd is STILL held: the `using` in withAdjacentFileLock releases it
    // only after this body returns.
    rmSync(`${path}.lock`, { force: true })
    syncDirectorySync(dirname(path))
    return { ok: true }
  })
}

/** Publish complete bytes while honoring the same exact-path lock as CAS writers. */
export function writeFileBytesLocked(path: string, nextRaw: string): LockedFileWriteResult {
  return withAdjacentFileLock(path, () => {
    atomicWriteFileSync(path, nextRaw)
    return { ok: true }
  })
}

function withAdjacentFileLock<T>(path: string, write: () => T): T | { readonly ok: false; readonly reason: "locked" } {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const lockPath = `${path}.lock`
  using lock = tryAcquireFlock(lockPath, { fileMode: 0o600 })
  if (lock === null) return { ok: false, reason: "locked" }
  return write()
}

function readRawOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null
    throw error
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : null
}
