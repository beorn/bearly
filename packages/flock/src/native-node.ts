import koffi from "koffi"
import type { SliceKoffi } from "./koffi-slice.ts"
import { libcCalls, openFirst, supportedPlatform, type LibcCalls } from "./native-platform.ts"
const binding: SliceKoffi = koffi

export function loadLibc(platform: NodeJS.Platform): LibcCalls {
  supportedPlatform(platform)
  const library = openFirst(platform, (candidate) => binding.load(candidate))
  // Only fixed parameters: neither fcntl(F_GETFD) nor ioctl(FIOCLEX) takes a third argument.
  return libcCalls(
    {
      flock: library.func("int flock(int fd, int operation)"),
      fcntl: library.func("int fcntl(int fd, int command)"),
      ioctl: library.func("int ioctl(int fd, unsigned long request)"),
    },
    () => binding.errno(),
  )
}
