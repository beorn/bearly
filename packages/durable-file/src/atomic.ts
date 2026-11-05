import { randomUUID } from "node:crypto"
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  linkSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"
import { mkdir, open, rename, unlink } from "node:fs/promises"

/** Async replacement with the same complete-byte and durability contract as the sync writer. */
export async function atomicWriteFile(path: string, body: string | Uint8Array, mode = 0o600): Promise<void> {
  if (path.trim().length === 0) throw new Error("atomicWriteFile: path must not be empty")
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = temporaryPath(path)
  try {
    const file = await open(temporary, "wx", mode)
    try {
      const bytes = typeof body === "string" ? Buffer.from(body) : body
      let offset = 0
      while (offset < bytes.length) {
        const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset)
        if (bytesWritten <= 0) throw new Error(`atomic write made no progress for ${path}`)
        offset += bytesWritten
      }
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
    try {
      const parent = await open(directory, "r")
      try {
        await parent.sync()
      } finally {
        await parent.close()
      }
    } catch (cause) {
      throw new Error(`atomicWriteFile: ${path}: replacement completed but directory durability is unproven`, { cause })
    }
  } catch (error) {
    try {
      await unlink(temporary)
    } catch (cleanup) {
      checkCleanupError(temporary, error, cleanup)
    }
    throw error
  }
}

/** Publish complete bytes with both durability barriers; mode honors umask unless exactMode is requested. */
export function atomicWriteFileSync(
  path: string,
  body: string | Uint8Array,
  mode = 0o600,
  policy?: { exactMode?: boolean },
): void {
  if (path.trim().length === 0) throw new Error("atomicWriteFileSync: path must not be empty")
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = temporaryPath(path)

  try {
    writeTemporaryFileSync(temporary, body, path, mode, policy?.exactMode)
    renameSync(temporary, path)
    syncDirectorySync(directory)
  } catch (error) {
    removeTemporary(temporary, error)
  }
}

/**
 * Exclusively publish complete bytes. Unlike replacement/CAS's rename, the hard link
 * elects one creator without overwriting existing bytes; the caller owns the parent directory.
 */
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

/** Recognize only a basename produced by this owner's atomic writers. */
export function isAtomicTemporaryName(name: string): boolean {
  return name === basename(name) && /^\..+\.tmp-[0-9a-z]+-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(name)
}

function writeTemporaryFileSync(
  temporary: string,
  body: string | Uint8Array,
  path: string,
  mode = 0o600,
  exactMode = false,
): void {
  const file = openSync(temporary, "wx", mode)
  try {
    writeAllBytesSync(file, typeof body === "string" ? Buffer.from(body) : body, path)
    if (exactMode) fchmodSync(file, mode)
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

/** Shared internal durability barrier for replacement, publication and CAS withdrawal. */
export function syncDirectorySync(path: string): void {
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
    checkCleanupError(path, original, cleanup)
  }
  throw original
}

function checkCleanupError(path: string, original: unknown, cleanup: unknown): void {
  if (errorCode(cleanup) !== "ENOENT") {
    throw new AggregateError([original, cleanup], `atomic write failed and could not remove ${path}`)
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null
  const code = (error as { readonly code?: unknown }).code
  return typeof code === "string" ? code : null
}
