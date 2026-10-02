// oxlint-disable-next-line typescript/triple-slash-reference -- source consumers need the ambient Bun FFI declaration
/// <reference path="./bun-ffi.d.ts" />
import { dlopen, read } from "bun:ffi"
import type { BunPointer as Pointer, SliceDlopen, SliceReadI32 } from "./bun-ffi-slice.ts"
import { libcCalls, openFirst, supportedPlatform, type LibcCalls } from "./native-platform.ts"
const openLibrary: SliceDlopen = dlopen
const readI32: SliceReadI32 = (ptr, byteOffset) =>
  byteOffset === undefined ? read.i32(ptr) : read.i32(ptr, byteOffset)
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
  flock: { args: ["i32", "i32"], returns: "i32" },
  fcntl: { args: ["i32", "i32"], returns: "i32" },
  ioctl: { args: ["i32", "u64"], returns: "i32" },
} as const

export function loadLibc(platform: NodeJS.Platform): LibcCalls {
  supportedPlatform(platform)
  if (platform === "linux") {
    const library = openFirst(
      platform,
      (candidate) =>
        openLibrary(candidate, {
          ...LIBC_DEFINITION,
          __errno_location: { args: [], returns: "ptr" },
        }) as unknown as { symbols: LinuxSymbols },
    )
    return libcCalls(library.symbols, () => readI32(library.symbols.__errno_location()))
  }
  if (platform === "darwin") {
    const library = openFirst(
      platform,
      (candidate) =>
        openLibrary(candidate, {
          ...LIBC_DEFINITION,
          __error: { args: [], returns: "ptr" },
        }) as unknown as { symbols: DarwinSymbols },
    )
    return libcCalls(library.symbols, () => readI32(library.symbols.__error()))
  }
  throw new Error(`@bearly/flock supports Bun on local macOS and Linux filesystems; unsupported platform: ${platform}`)
}
