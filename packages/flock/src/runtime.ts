export interface FlockIo {
  readonly createParent: (path: string, mode: number) => void
  readonly exists: (path: string) => boolean
  readonly open: (path: string, mode: number, noFollow: boolean, create: boolean) => number
  readonly identity: (fd: number) => string
  readonly pathIdentity: (path: string) => string
  readonly flock: (
    fd: number,
    mode: "try" | "block",
  ) => { readonly ok: true } | { readonly ok: false; readonly errno: number }
  /**
   * Mark a descriptor close-on-exec. Called on every ADOPTED descriptor, so a holder's
   * exec'd children inherit no lock: an orphaned grandchild still holding it after its
   * parent dies is a lock nothing can release and nobody can find.
   */
  readonly setCloexec: (fd: number) => { readonly ok: true } | { readonly ok: false; readonly errno: number }
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
  /** False opens an existing file without creating parents or writing a diagnostic body. Defaults to true. */
  readonly create?: boolean
  readonly createParent?: boolean
  readonly parentMode?: number
  /**
   * Refuse to open through a symlink: the path's final component must be a real
   * file, so a symlink there fails the open (ELOOP) instead of locking — and a
   * body write truncating — whatever it points at. Opt in for a lock path an
   * attacker or an unrelated tool could replace with a symlink.
   */
  readonly noFollow?: boolean
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
  readonly acquireWithTimeout: (path: string, timeoutMs: number, options?: FlockOpenOptions) => FlockHandle | null
  readonly adopt: (path: string, fd: number) => FlockHandle | null
  readonly isHeld: (path: string) => boolean
}

// Shared parked wait word: bounded acquisition sleeps instead of spinning or allocating per retry.
const waitWord = new Int32Array(new SharedArrayBuffer(4))

export function createFlockRuntime(io: FlockIo, options: FlockRuntimeOptions): FlockRuntime {
  const heldIdentities = new Set<string>()

  const acquire = (path: string, mode: "try" | "block" | number, openOptions: FlockOpenOptions): FlockHandle | null => {
    if (typeof mode === "number" && (!Number.isFinite(mode) || mode < 0)) {
      throw new TypeError(`flock timeout must be finite and nonnegative: ${path}`)
    }
    const deadline = typeof mode === "number" ? performance.now() + mode : undefined
    const candidate = openCandidate(io, path, openOptions)
    if (heldIdentities.has(candidate.identity)) {
      io.close(candidate.fd)
      if (mode === "block") throw new Error(`flock already held by this process: ${path}`)
      return null
    }
    while (true) {
      const result = flockOrClose(io, candidate.fd, mode === "block" ? "block" : "try")
      if (result.ok) return publishHandle(io, heldIdentities, candidate, openOptions.body)
      if (mode === "block" && result.errno === options.interruptedErrno) continue
      const wouldBlock = options.wouldBlockErrnos.includes(result.errno)
      if (mode === "block" || (!wouldBlock && !(deadline !== undefined && result.errno === options.interruptedErrno))) {
        io.close(candidate.fd)
        throw flockError(path, result.errno)
      }
      const remaining = deadline === undefined ? 0 : deadline - performance.now()
      if (remaining <= 0) {
        io.close(candidate.fd)
        return null
      }
      Atomics.wait(waitWord, 0, 0, Math.min(remaining, 25))
    }
  }

  return {
    tryAcquire(path, openOptions = {}) {
      return acquire(path, "try", openOptions)
    },

    acquireBlocking(path, openOptions = {}) {
      return acquire(path, "block", openOptions) as FlockHandle
    },

    acquireWithTimeout(path, timeoutMs, openOptions = {}) {
      return acquire(path, timeoutMs, openOptions)
    },

    adopt(path, fd) {
      const identity = io.identity(fd)
      const expectedIdentity = io.pathIdentity(path)
      if (identity !== expectedIdentity) {
        throw new Error(
          `cannot adopt flock fd ${fd} for ${path}: descriptor identity ${identity} does not match path identity ${expectedIdentity}`,
        )
      }
      if (heldIdentities.has(identity)) return null

      // The adopter holds this until it dies; its exec'd children must not. Marked
      // BEFORE the lock call, so a failure leaves nothing of ours mutated -- and it is
      // fatal rather than ignorable, because an inherited copy in a grandchild is a lock
      // held by a process nobody can name. Never unlock on this path: the descriptor is
      // the same open file description the parent locked, so releasing it here would
      // release the parent's lock too.
      const cloexec = io.setCloexec(fd)
      if (!cloexec.ok) {
        // errno 0 is the readback disagreeing rather than a failed call: the
        // syscall reported success and the flag is still clear. That is the
        // shape this package was actually bitten by, so it gets its own words.
        const cause =
          cloexec.errno === 0 ? "the call reported success and the flag is still clear" : `errno ${cloexec.errno}`
        throw new Error(
          `cannot adopt flock fd ${fd} for ${path}: the descriptor could not be marked close-on-exec ` +
            `(${cause}); an adopted lock that survives exec would outlive its holder`,
        )
      }
      const result = io.flock(fd, "try")
      if (!result.ok) {
        if (options.wouldBlockErrnos.includes(result.errno)) return null
        throw flockError(path, result.errno)
      }
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
  if (options.create === false && options.body !== undefined) {
    throw new TypeError(`flock create:false cannot write a diagnostic body: ${path}`)
  }
  const create = options.create !== false
  if (create && options.createParent !== false) io.createParent(path, options.parentMode ?? 0o700)
  const fd = io.open(path, options.fileMode ?? 0o600, options.noFollow === true, create)
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
