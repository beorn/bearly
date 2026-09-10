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
const FD_CLOEXEC = 1
const F_GETFD = 1
/**
 * `ioctl(fd, FIOCLEX)` rather than `fcntl(fd, F_SETFD, FD_CLOEXEC)`.
 *
 * Both libc entry points are VARIADIC, and on Apple silicon a variadic argument
 * is passed on the stack while a fixed one is passed in a register — so a
 * fixed-arity binding of `fcntl` puts the flag where the callee never looks, and
 * the callee reads whatever is on the stack instead. Measured on macos-latest
 * 2026-09-10: it returned success and left the descriptor inheritable, which is
 * the silent half of the failure. Linux passes variadic arguments in registers,
 * so the same binding worked there and the bug was invisible.
 *
 * `FIOCLEX` takes NO variadic argument. The two arguments it does take are
 * `ioctl`'s own fixed parameters, so a two-argument binding is correct on every
 * ABI rather than correct by luck on one.
 */
const FIOCLEX = process.platform === "darwin" ? 0x2000_6601 : 0x5451

export interface NativeFlockRuntime {
  readonly io: FlockIo
  readonly wouldBlockErrnos: readonly number[]
  readonly interruptedErrno: number
}

export function createNativeFlockRuntime(platform: NodeJS.Platform = process.platform): NativeFlockRuntime {
  const { callFlock, callFcntl, callIoctl, readErrno } = loadLibc(platform)
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
        const set = callIoctl(fd, FIOCLEX)
        if (!set.ok) return set
        // Read the flag back. The failure this package just paid for returned
        // success and changed nothing, so the syscall's own answer is not
        // evidence that the descriptor is now close-on-exec.
        const flags = callFcntl(fd, F_GETFD)
        if (flags < 0) return { ok: false, errno: readErrno() }
        return (flags & FD_CLOEXEC) === FD_CLOEXEC ? { ok: true } : { ok: false, errno: 0 }
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
type IoctlCall = (fd: number, request: number) => FlockResult

interface LinuxSymbols {
  flock(fd: number, operation: number): number
  fcntl(fd: number, command: number): number
  ioctl(fd: number, request: number): number
  __errno_location(): Pointer
}

interface DarwinSymbols {
  flock(fd: number, operation: number): number
  fcntl(fd: number, command: number): number
  ioctl(fd: number, request: number): number
  __error(): Pointer
}

/**
 * Every binding here is TWO arguments, and that is a constraint rather than a
 * coincidence: `fcntl` and `ioctl` are variadic in C, and only their fixed
 * parameters can be bound portably. See `FIOCLEX` above for what a third one
 * costs on Apple silicon. Adding a command that needs an argument means finding
 * another way to issue it, not widening these.
 */
const LIBC_DEFINITION = {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  ioctl: { args: [FFIType.i32, FFIType.u64], returns: FFIType.i32 },
} as const

interface LibcCalls {
  readonly callFlock: FlockCall
  readonly callIoctl: IoctlCall
  /** Raw return value; commands issued through this take no argument. */
  readonly callFcntl: (fd: number, command: number) => number
  readonly readErrno: () => number
}

function loadLibc(platform: NodeJS.Platform): LibcCalls {
  if (platform === "linux") {
    const library = openFirst<LinuxSymbols>(platform, {
      ...LIBC_DEFINITION,
      __errno_location: { args: [], returns: FFIType.ptr },
    })
    return libcCalls(library.symbols, () => read.i32(library.symbols.__errno_location()))
  }
  if (platform === "darwin") {
    const library = openFirst<DarwinSymbols>(platform, {
      ...LIBC_DEFINITION,
      __error: { args: [], returns: FFIType.ptr },
    })
    return libcCalls(library.symbols, () => read.i32(library.symbols.__error()))
  }
  throw new Error(`@bearly/flock supports Bun on local macOS and Linux filesystems; unsupported platform: ${platform}`)
}

function libcCalls(
  symbols: {
    flock(fd: number, operation: number): number
    fcntl(fd: number, command: number): number
    ioctl(fd: number, request: number): number
  },
  readErrno: () => number,
): LibcCalls {
  return {
    readErrno,
    callFlock: (fd, operation) =>
      symbols.flock(fd, operation) === 0 ? { ok: true } : { ok: false, errno: readErrno() },
    callIoctl: (fd, request) => (symbols.ioctl(fd, request) === -1 ? { ok: false, errno: readErrno() } : { ok: true }),
    callFcntl: (fd, command) => symbols.fcntl(fd, command),
  }
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
