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
// Linux asm-generic/ioctls.h and Darwin sys/filio.h (_IO('f', 1)).
const LINUX_FIOCLEX = 0x5451
const DARWIN_FIOCLEX = 0x20006601

export interface NativeFlockRuntime {
  readonly io: FlockIo
  readonly wouldBlockErrnos: readonly number[]
  readonly interruptedErrno: number
}

export function createNativeFlockRuntime(platform: NodeJS.Platform = process.platform): NativeFlockRuntime {
  const calls = loadFlock(platform)
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
        return calls.flock(fd, LOCK_EX | (mode === "try" ? LOCK_NB : 0))
      },
      closeOnExec: calls.closeOnExec,
      truncate: (fd) => ftruncateSync(fd, 0),
      write: (fd, bytes, offset, length) => writeSync(fd, bytes, offset, length),
      fsync: fsyncSync,
      close: closeSync,
    },
  }
}

type FlockResult = { readonly ok: true } | { readonly ok: false; readonly errno: number }
type FlockCall = (fd: number, operation: number) => FlockResult

interface LockSymbols {
  flock(fd: number, operation: number): number
  ioctl(fd: number, request: number): number
}

interface LinuxSymbols extends LockSymbols {
  __errno_location(): Pointer
}

interface DarwinSymbols extends LockSymbols {
  __error(): Pointer
}

function loadFlock(platform: NodeJS.Platform): { flock: FlockCall; closeOnExec: (fd: number) => FlockResult } {
  if (platform === "linux") {
    const library = openFirst<LinuxSymbols>(platform, {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      ioctl: { args: [FFIType.i32, FFIType.u64], returns: FFIType.i32 },
      __errno_location: { args: [], returns: FFIType.ptr },
    })
    return bindCalls(library.symbols, () => read.i32(library.symbols.__errno_location()), LINUX_FIOCLEX)
  }
  if (platform === "darwin") {
    const library = openFirst<DarwinSymbols>(platform, {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      ioctl: { args: [FFIType.i32, FFIType.u64], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    })
    return bindCalls(library.symbols, () => read.i32(library.symbols.__error()), DARWIN_FIOCLEX)
  }
  throw new Error(`@bearly/flock supports Bun on local macOS and Linux filesystems; unsupported platform: ${platform}`)
}

function bindCalls(
  symbols: LockSymbols,
  errno: () => number,
  fioclex: number,
): {
  flock: FlockCall
  closeOnExec: (fd: number) => FlockResult
} {
  return {
    flock(fd, operation) {
      return symbols.flock(fd, operation) === 0 ? { ok: true } : { ok: false, errno: errno() }
    },
    closeOnExec(fd) {
      // FIOCLEX needs only ioctl's two fixed arguments (int, unsigned long).
      // No variadic payload: Darwin arm64 passes variadic arguments differently.
      return symbols.ioctl(fd, fioclex) === 0 ? { ok: true } : { ok: false, errno: errno() }
    },
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
