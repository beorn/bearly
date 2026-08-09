export interface FlockIo {
  readonly createParent: (path: string, mode: number) => void
  readonly exists: (path: string) => boolean
  readonly open: (path: string, mode: number) => number
  readonly identity: (fd: number) => string
  readonly flock: (
    fd: number,
    mode: "try" | "block",
  ) => { readonly ok: true } | { readonly ok: false; readonly errno: number }
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
  /** Complete and fsynced on success; failure closes this handle. */
  replaceBody(body: string | Uint8Array): void
  /** Close only. Never issues LOCK_UN because another process may own a duplicate fd. */
  release(): void
  [Symbol.dispose](): void
}

export interface FlockRuntime {
  readonly tryAcquire: (path: string, options?: FlockOpenOptions) => FlockHandle | null
  readonly acquireBlocking: (path: string, options?: FlockOpenOptions) => FlockHandle
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
        throw flockError(path, result.errno)
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
        throw flockError(path, result.errno)
      }
      return publishHandle(io, heldIdentities, candidate, openOptions.body)
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
      throw flockError(path, result.errno)
    },
  }
}

interface Candidate {
  readonly fd: number
  readonly identity: string
  readonly path: string
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
    released = true
    heldIdentities.delete(candidate.identity)
    io.close(candidate.fd)
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

function flockError(path: string, errno: number): NodeJS.ErrnoException {
  return Object.assign(new Error(`flock syscall failed: errno=${errno} path=${path}`), {
    code: `ERRNO_${errno}`,
    errno,
    syscall: "flock",
    path,
  })
}
