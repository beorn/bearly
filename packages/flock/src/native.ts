import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, writeSync } from "node:fs"
import { dirname } from "node:path"
import { dlopen, FFIType, read, type Pointer } from "bun:ffi"
import type { FlockIo } from "./runtime.ts"

const LOCK_EX = 2
const LOCK_NB = 4

export interface NativeFlockRuntime {
  readonly io: FlockIo
  readonly wouldBlockErrnos: readonly number[]
  readonly interruptedErrno: number
}

export function createNativeFlockRuntime(platform: NodeJS.Platform = process.platform): NativeFlockRuntime {
  const callFlock = loadFlock(platform)
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
      flock(fd, mode) {
        return callFlock(fd, LOCK_EX | (mode === "try" ? LOCK_NB : 0))
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

interface LinuxSymbols {
  flock(fd: number, operation: number): number
  __errno_location(): Pointer
}

interface DarwinSymbols {
  flock(fd: number, operation: number): number
  __error(): Pointer
}

function loadFlock(platform: NodeJS.Platform): FlockCall {
  if (platform === "linux") {
    const library = openFirst<LinuxSymbols>(platform, {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      __errno_location: { args: [], returns: FFIType.ptr },
    })
    return (fd, operation) => {
      const result = library.symbols.flock(fd, operation)
      return result === 0 ? { ok: true } : { ok: false, errno: read.i32(library.symbols.__errno_location()) }
    }
  }
  if (platform === "darwin") {
    const library = openFirst<DarwinSymbols>(platform, {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    })
    return (fd, operation) => {
      const result = library.symbols.flock(fd, operation)
      return result === 0 ? { ok: true } : { ok: false, errno: read.i32(library.symbols.__error()) }
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
