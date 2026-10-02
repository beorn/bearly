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
import type { FlockIo } from "./runtime.ts"
import {
  LOCK_EX,
  LOCK_NB,
  F_GETFD,
  FD_CLOEXEC,
  FIOCLEX,
  WOULD_BLOCK_ERRNOS,
  INTERRUPTED_ERRNO,
  supportedPlatform,
} from "./native-platform.ts"
export { libcCandidates } from "./native-platform.ts"
// Module initialization chooses the binding; the public lock functions remain synchronous.
const { loadLibc } = await (process.versions.bun === undefined ? import("./native-node.ts") : import("./native-bun.ts"))

export interface NativeFlockRuntime {
  readonly io: FlockIo
  readonly wouldBlockErrnos: readonly number[]
  readonly interruptedErrno: number
}

export function createNativeFlockRuntime(platform: NodeJS.Platform = process.platform): NativeFlockRuntime {
  const target = supportedPlatform(platform)
  const { callFlock, callFcntl, callIoctl, readErrno } = loadLibc(platform)
  return {
    wouldBlockErrnos: WOULD_BLOCK_ERRNOS[target],
    interruptedErrno: INTERRUPTED_ERRNO,
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
        const set = callIoctl(fd, FIOCLEX[target])
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
