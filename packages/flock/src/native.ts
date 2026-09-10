import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  statSync,
  writeSync,
} from "node:fs"
import { dirname } from "node:path"
import { dlopen, FFIType, read, type Pointer } from "bun:ffi"
import type { FlockIo } from "./runtime.ts"

const LOCK_EX = 2
const LOCK_NB = 4
// fcntl(2): identical on Linux and macOS, and part of the ABI rather than a header detail.
const F_SETFD = 2
const FD_CLOEXEC = 1

export interface NativeFlockRuntime {
  readonly io: FlockIo
  readonly wouldBlockErrnos: readonly number[]
  readonly interruptedErrno: number
}

export function createNativeFlockRuntime(platform: NodeJS.Platform = process.platform): NativeFlockRuntime {
  const { callFlock, callFcntl } = loadLibc(platform)
  return {
    wouldBlockErrnos: platform === "darwin" ? [35] : [11],
    interruptedErrno: 4,
    io: {
      createParent(path, mode) {
        mkdirSync(dirname(path), { recursive: true, mode })
      },
      exists: existsSync,
      open: (path, mode) => openSync(path, "a+", mode),
      identity(fd) {
        const stat = fstatSync(fd, { bigint: true })
        return `${String(stat.dev)}:${String(stat.ino)}`
      },
      pathIdentity(path) {
        const stat = statSync(path, { bigint: true })
        return `${String(stat.dev)}:${String(stat.ino)}`
      },
      flock(fd, mode) {
        return callFlock(fd, LOCK_EX | (mode === "try" ? LOCK_NB : 0))
      },
      setCloexec(fd) {
        return callFcntl(fd, F_SETFD, FD_CLOEXEC)
      },
      truncate: (fd) => ftruncateSync(fd, 0),
      write: (fd, bytes, offset, length) => writeSync(fd, bytes, offset, length),
      fsync: fsyncSync,
      close: closeSync,
    },
  }
}

type FlockResult = { readonly ok: true } | { readonly ok: false; readonly errno: number }
type FlockCall = (fd: number, operation: number) => FlockResult
type FcntlCall = (fd: number, command: number, argument: number) => FlockResult

interface LinuxSymbols {
  flock(fd: number, operation: number): number
  fcntl(fd: number, command: number, argument: number): number
  __errno_location(): Pointer
}

interface DarwinSymbols {
  flock(fd: number, operation: number): number
  fcntl(fd: number, command: number, argument: number): number
  __error(): Pointer
}

/**
 * `fcntl` is variadic in C, but every command this package issues takes one int, and the
 * int form is what the ABI passes for `F_SETFD`. Declaring the three-int shape is the
 * standard binding for it and is identical on both supported platforms.
 */
const LIBC_DEFINITION = {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
} as const

function loadLibc(platform: NodeJS.Platform): { readonly callFlock: FlockCall; readonly callFcntl: FcntlCall } {
  if (platform === "linux") {
    const library = openFirst<LinuxSymbols>(platform, {
      ...LIBC_DEFINITION,
      __errno_location: { args: [], returns: FFIType.ptr },
    })
    const errno = (): number => read.i32(library.symbols.__errno_location())
    return {
      callFlock: (fd, operation) =>
        library.symbols.flock(fd, operation) === 0 ? { ok: true } : { ok: false, errno: errno() },
      callFcntl: (fd, command, argument) =>
        library.symbols.fcntl(fd, command, argument) === -1 ? { ok: false, errno: errno() } : { ok: true },
    }
  }
  if (platform === "darwin") {
    const library = openFirst<DarwinSymbols>(platform, {
      ...LIBC_DEFINITION,
      __error: { args: [], returns: FFIType.ptr },
    })
    const errno = (): number => read.i32(library.symbols.__error())
    return {
      callFlock: (fd, operation) =>
        library.symbols.flock(fd, operation) === 0 ? { ok: true } : { ok: false, errno: errno() },
      callFcntl: (fd, command, argument) =>
        library.symbols.fcntl(fd, command, argument) === -1 ? { ok: false, errno: errno() } : { ok: true },
    }
  }
  throw new Error(`@bearly/flock supports Bun on local macOS and Linux filesystems; unsupported platform: ${platform}`)
}

function openFirst<Symbols>(
  platform: NodeJS.Platform,
  definition: Parameters<typeof dlopen>[1],
): { readonly symbols: Symbols } {
  const failures: string[] = []
  for (const candidate of libcCandidates(platform)) {
    try {
      return dlopen(candidate, definition) as unknown as { readonly symbols: Symbols }
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`@bearly/flock could not load libc; tried ${failures.join("; ")}`)
}

export function libcCandidates(platform: NodeJS.Platform): readonly string[] {
  if (platform === "darwin") return ["/usr/lib/libSystem.B.dylib", "libSystem.B.dylib", "libc.dylib"]
  if (platform === "linux") return ["libc.so.6", "libc.so"]
  return []
}
