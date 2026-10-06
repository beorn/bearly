import { randomUUID } from "node:crypto"
import { closeSync, fsyncSync, mkdirSync, linkSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs"
import { basename, dirname, join } from "node:path"

/** Publish complete bytes through a unique sibling and both durability barriers. */
export function atomicWriteFileSync(path: string, body: string | Uint8Array): void {
  if (path.trim().length === 0) throw new Error("atomicWriteFileSync: path must not be empty")
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = temporaryPath(path)

  try {
    writeTemporaryFileSync(temporary, body, path)
    renameSync(temporary, path)
    syncDirectorySync(directory)
  } catch (error) {
    removeTemporary(temporary, error)
  }
}

/** Exclusively publish complete bytes. The caller owns the existing parent directory. */
export function atomicPublishFileSync(path: string, body: string | Uint8Array): "published" | "exists" {
  if (path.trim().length === 0) throw new Error("atomicPublishFileSync: path must not be empty")
  const directory = dirname(path)
  const temporary = temporaryPath(path)
  let published = false
  try {
    writeTemporaryFileSync(temporary, body, path)
    try {
      linkSync(temporary, path)
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
      unlinkSync(temporary)
      return "exists"
    }
    published = true
    unlinkSync(temporary)
    syncDirectorySync(directory)
    return "published"
  } catch (error) {
    try {
      removeTemporary(temporary, error)
    } catch (failure) {
      if (published) throw new AtomicPublicationError(path, failure)
      throw failure
    }
  }
}

class AtomicPublicationError extends Error {
  readonly published = true
  // An explicit field, not a parameter property: plainbrain runs this source under Node's strip-only loader,
  // which rejects parameter properties (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  readonly path: string
  constructor(path: string, cause: unknown) {
    super(
      `atomicPublishFileSync: ${path}: destination exists complete; post-publication cleanup or durability failed`,
      { cause },
    )
    this.path = path
    this.name = "AtomicPublicationError"
  }
}

function temporaryPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.tmp-${process.pid.toString(36)}-${randomUUID()}`)
}

function writeTemporaryFileSync(temporary: string, body: string | Uint8Array, path: string): void {
  const file = openSync(temporary, "wx", 0o600)
  try {
    writeAllBytesSync(file, typeof body === "string" ? Buffer.from(body) : body, path)
    fsyncSync(file)
  } finally {
    closeSync(file)
  }
}

function writeAllBytesSync(fd: number, bytes: Uint8Array, path: string): void {
  let offset = 0
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset)
    if (written <= 0) throw new Error(`atomic write made no progress for ${path}`)
    offset += written
  }
}

function syncDirectorySync(path: string): void {
  const directory = openSync(path, "r")
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
}

function removeTemporary(path: string, original: unknown): never {
  try {
    unlinkSync(path)
  } catch (cleanup) {
    if (errorCode(cleanup) !== "ENOENT") {
      throw new AggregateError([original, cleanup], `atomic write failed and could not remove ${path}`)
    }
  }
  throw original
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null
  const code = (error as { readonly code?: unknown }).code
  return typeof code === "string" ? code : null
}
