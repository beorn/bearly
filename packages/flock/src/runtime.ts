export interface FlockIo {
  readonly createParent: (path: string, mode: number) => void
  readonly exists: (path: string) => boolean
  readonly open: (path: string, mode: number) => number
  readonly identity: (fd: number) => string
  readonly pathIdentity: (path: string) => string
  readonly flock: (
    fd: number,
    mode: "try" | "block",
  ) => { readonly ok: true } | { readonly ok: false; readonly errno: number }
  readonly closeOnExec: (fd: number) => { readonly ok: true } | { readonly ok: false; readonly errno: number }
  readonly truncate: (fd: number) => void
  readonly write: (fd: number, bytes: Uint8Array, offset: number, length: number) => number
  readonly fsync: (fd: number) => void
  readonly close: (fd: number) => void
}

export interface FlockRuntimeOptions {
  readonly wouldBlockErrnos: readonly number[]
  readonly interruptedErrno: number
}

export interface FlockOpenOptions {
  readonly body?: string | Uint8Array
  readonly fileMode?: number
  readonly createParent?: boolean
  readonly parentMode?: number
}

export interface FlockHandle {
  readonly path: string
  readonly fd: number
  /** Local handle state only; an inherited duplicate may still own the lock. */
  readonly held: boolean
  /**
   * Refuse a released handle or a path that no longer names the acquired inode.
   * Read-only: never reacquires or closes an fd. The caller exclusively owns
   * this descriptor; external close/unlock and concurrent path replacement
   * after the assertion are outside the advisory-lock contract.
   */
  assertHeld(): void
  /** Complete and fsynced on success; failure closes this handle. */
  replaceBody(body: string | Uint8Array): void
  /** Close only. Never issues LOCK_UN because another process may own a duplicate fd. */
  release(): void
  [Symbol.dispose](): void
}

export interface FlockRuntime {
  readonly tryAcquire: (path: string, options?: FlockOpenOptions) => FlockHandle | null
  readonly acquireBlocking: (path: string, options?: FlockOpenOptions) => FlockHandle
  readonly adopt: (path: string, fd: number) => FlockHandle | null
  readonly isHeld: (path: string) => boolean
}

export function createFlockRuntime(io: FlockIo, options: FlockRuntimeOptions): FlockRuntime {
  const heldIdentities = new Set<string>()

  return {
    tryAcquire(path, openOptions = {}) {
      const candidate = openCandidate(io, path, openOptions)
      if (heldIdentities.has(candidate.identity)) {
        io.close(candidate.fd)
        return null
      }
      const result = flockOrClose(io, candidate.fd, "try")
      if (!result.ok) {
        io.close(candidate.fd)
        if (options.wouldBlockErrnos.includes(result.errno)) return null
        throw syscallError(path, result.errno, "flock")
      }
      return publishHandle(io, heldIdentities, candidate, openOptions.body)
    },

    acquireBlocking(path, openOptions = {}) {
      const candidate = openCandidate(io, path, openOptions)
      if (heldIdentities.has(candidate.identity)) {
        io.close(candidate.fd)
        throw new Error(`flock already held by this process: ${path}`)
      }
      while (true) {
        const result = flockOrClose(io, candidate.fd, "block")
        if (result.ok) break
        if (result.errno === options.interruptedErrno) continue
        io.close(candidate.fd)
        throw syscallError(path, result.errno, "flock")
      }
      return publishHandle(io, heldIdentities, candidate, openOptions.body)
    },

    adopt(path, fd) {
      const identity = io.identity(fd)
      assertPathIdentity(io, path, identity)
      if (heldIdentities.has(identity)) return null

      const result = io.flock(fd, "try")
      if (!result.ok) {
        if (options.wouldBlockErrnos.includes(result.errno)) return null
        throw syscallError(path, result.errno, "flock")
      }
      // Explicit stdio handoff clears CLOEXEC. The receiving owner must
      // restore it before publishing the handle or starting descendants.
      // Until publication this remains a borrowed fd, including on failure.
      const sealed = io.closeOnExec(fd)
      if (!sealed.ok) throw syscallError(path, sealed.errno, "ioctl")
      return publishHandle(io, heldIdentities, { fd, identity, path }, undefined)
    },

    isHeld(path) {
      if (!io.exists(path)) return false
      const candidate = openCandidate(io, path, { createParent: false })
      if (heldIdentities.has(candidate.identity)) {
        io.close(candidate.fd)
        return true
      }
      const result = flockOrClose(io, candidate.fd, "try")
      io.close(candidate.fd)
      if (result.ok) return false
      if (options.wouldBlockErrnos.includes(result.errno)) return true
      throw syscallError(path, result.errno, "flock")
    },
  }
}

interface Candidate {
  readonly fd: number
  readonly identity: string
  readonly path: string
}

/** The acquired inode is authority; pathname presence alone never is. */
function assertPathIdentity(io: FlockIo, path: string, acquiredIdentity: string): void {
  let currentIdentity: string
  try {
    currentIdentity = io.pathIdentity(path)
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new Error(
        `lock file at ${path}: removed since acquisition (identity ${acquiredIdentity}); this holder must stop`,
        { cause: error },
      )
    }
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `lock file at ${path}: cannot inspect current identity for acquired ${acquiredIdentity}: ${detail}; this holder must stop`,
      { cause: error },
    )
  }
  if (currentIdentity !== acquiredIdentity) {
    throw new Error(
      `lock file at ${path}: acquired identity ${acquiredIdentity} was replaced by ${currentIdentity}; this holder must stop`,
    )
  }
}

function openCandidate(io: FlockIo, path: string, options: FlockOpenOptions): Candidate {
  if (options.createParent !== false) io.createParent(path, options.parentMode ?? 0o700)
  const fd = io.open(path, options.fileMode ?? 0o600)
  try {
    return { fd, identity: io.identity(fd), path }
  } catch (error) {
    closeAfterFailure(io, fd, error)
  }
}

function publishHandle(
  io: FlockIo,
  heldIdentities: Set<string>,
  candidate: Candidate,
  initialBody: string | Uint8Array | undefined,
): FlockHandle {
  heldIdentities.add(candidate.identity)
  let released = false

  const release = (): void => {
    if (released) return
    io.close(candidate.fd)
    released = true
    heldIdentities.delete(candidate.identity)
  }

  const replaceBody = (body: string | Uint8Array): void => {
    if (released) throw new Error(`cannot replace diagnostics on a released flock: ${candidate.path}`)
    try {
      writeCompleteBody(io, candidate.fd, body, candidate.path)
    } catch (error) {
      try {
        release()
      } catch (closeError) {
        throw new AggregateError([error, closeError], `flock diagnostics and close both failed: ${candidate.path}`)
      }
      throw error
    }
  }

  const handle: FlockHandle = {
    path: candidate.path,
    fd: candidate.fd,
    get held() {
      return !released
    },
    assertHeld() {
      if (released) {
        throw new Error(
          `lock file at ${candidate.path}: cannot assert ownership of a released flock; this holder must stop`,
        )
      }
      assertPathIdentity(io, candidate.path, candidate.identity)
    },
    replaceBody,
    release,
    [Symbol.dispose]() {
      release()
    },
  }

  if (initialBody !== undefined) replaceBody(initialBody)
  return handle
}

export function writeCompleteBody(io: FlockIo, fd: number, body: string | Uint8Array, path: string): void {
  const bytes = typeof body === "string" ? Buffer.from(body) : body
  io.truncate(fd)
  let offset = 0
  while (offset < bytes.length) {
    const written = io.write(fd, bytes, offset, bytes.length - offset)
    if (written <= 0) throw new Error(`flock diagnostics write made no progress: ${path}`)
    if (written > bytes.length - offset) {
      throw new Error(`flock diagnostics write exceeded the requested byte count: ${path}`)
    }
    offset += written
  }
  io.fsync(fd)
}

function closeAfterFailure(io: FlockIo, fd: number, error: unknown): never {
  try {
    io.close(fd)
  } catch (closeError) {
    throw new AggregateError([error, closeError], "flock setup and close both failed")
  }
  throw error
}

function flockOrClose(io: FlockIo, fd: number, mode: "try" | "block"): ReturnType<FlockIo["flock"]> {
  try {
    return io.flock(fd, mode)
  } catch (error) {
    closeAfterFailure(io, fd, error)
  }
}

function syscallError(path: string, errno: number, syscall: "flock" | "ioctl"): NodeJS.ErrnoException {
  const operation = syscall === "ioctl" ? "ioctl(FIOCLEX)" : syscall
  const remedy =
    syscall === "ioctl"
      ? "; inherited flock adoption refused because descendant isolation is unproven; " +
        "abort startup and close the borrowed descriptor, then verify the inherited fd and native FIOCLEX support before retrying"
      : ""
  return Object.assign(new Error(`${operation} syscall failed: errno=${errno} path=${path}${remedy}`), {
    code: `ERRNO_${errno}`,
    errno,
    syscall,
    path,
  })
}
