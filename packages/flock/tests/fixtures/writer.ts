import { writeFileSync } from "node:fs"
import { F_GETFD, supportedPlatform } from "../../src/native-platform.ts"

// Clearing CLOEXEC is fixture setup only; production only ever sets the flag.
const FIONCLEX = { linux: 0x5450, darwin: 0x2000_6602 } as const
import { adoptInheritedFlock, tryAcquireFlock } from "../../src/index.ts"

const [mode, lockPath, readyPath] = process.argv.slice(2)
if (mode === undefined || lockPath === undefined) {
  throw new Error("usage: writer.ts <hold|once|adopt|adopt-cloexec> <lock-path> [ready-path]")
}

if (mode === "adopt-hold") {
  using lock = adoptInheritedFlock(lockPath, 3)
  if (lock === null) process.exit(2)
  if (readyPath === undefined) throw new Error("adopt-hold needs a ready path")
  writeFileSync(readyPath, "ready")
  setInterval(() => {}, 60_000)
  await new Promise(() => {})
}

if (mode === "adopt") {
  using lock = adoptInheritedFlock(lockPath, 3)
  if (lock === null) process.exit(2)
  process.exit(0)
}

if (mode === "adopt-cloexec") {
  // Reports the descriptor's FD_CLOEXEC bit BEFORE and AFTER adoption, from a real
  // inherited fd in a real child. `adopt` is the only thing that runs in between.
  if (readyPath === undefined) throw new Error("adopt-cloexec needs a report path")
  const platform = supportedPlatform(process.platform)
  let flags: () => number
  if (process.versions.bun !== undefined) {
    const { dlopen } = await import("bun:ffi")
    const libc = dlopen(platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
      fcntl: { args: ["i32", "i32"], returns: "i32" },
    })
    flags = () => libc.symbols.fcntl(3, F_GETFD)
  } else {
    const { default: koffi } = await import("koffi")
    const libc = koffi.load(platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6")
    const fcntl = libc.func("int fcntl(int fd, int command)")
    const ioctl = libc.func("int ioctl(int fd, unsigned long request)")
    // Node startup sets CLOEXEC. Explicitly clear it to prove adoption changes the flag.
    if (ioctl(3, FIONCLEX[platform]) !== 0) throw new Error("fixture could not clear CLOEXEC")
    flags = () => fcntl(3, F_GETFD) as number
  }
  const before = flags()
  using lock = adoptInheritedFlock(lockPath, 3)
  if (lock === null) process.exit(2)
  writeFileSync(readyPath, JSON.stringify({ before, after: flags() }))
  process.exit(0)
}

using lock = tryAcquireFlock(lockPath, { body: `${mode}:${process.pid}\n` })
if (lock === null) process.exit(2)

if (mode === "once") process.exit(0)
if (mode !== "hold" || readyPath === undefined) throw new Error(`unknown writer mode: ${mode}`)

writeFileSync(readyPath, "ready")
setInterval(() => {}, 60_000)
await new Promise(() => {})
