export const LOCK_EX = 2
export const LOCK_NB = 4
export const FD_CLOEXEC = 1
export const F_GETFD = 1
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
export const FIOCLEX = { linux: 0x5451, darwin: 0x2000_6601 } as const
export const FIONCLEX = { linux: 0x5450, darwin: 0x2000_6602 } as const
export const WOULD_BLOCK_ERRNOS = { linux: [11], darwin: [35] } as const
export const INTERRUPTED_ERRNO = 4

export function supportedPlatform(platform: NodeJS.Platform): "linux" | "darwin" {
  if (platform === "linux" || platform === "darwin") return platform
  throw new Error(
    `@bearly/flock supports Bun and Node 24 on local macOS and Linux filesystems; unsupported platform: ${platform}`,
  )
}

type FlockResult = { readonly ok: true } | { readonly ok: false; readonly errno: number }
type FlockCall = (fd: number, operation: number) => FlockResult
type IoctlCall = (fd: number, request: number) => FlockResult

export interface LibcCalls {
  readonly callFlock: FlockCall
  readonly callIoctl: IoctlCall
  /** Raw return value; commands issued through this take no argument. */
  readonly callFcntl: (fd: number, command: number) => number
  readonly readErrno: () => number
}

export function libcCalls(
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

export function openFirst<Library>(platform: NodeJS.Platform, open: (candidate: string) => Library): Library {
  const failures: string[] = []
  for (const candidate of libcCandidates(platform)) {
    try {
      return open(candidate)
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
