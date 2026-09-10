import { writeFileSync } from "node:fs"
import { dlopen, FFIType } from "bun:ffi"
import { adoptInheritedFlock, tryAcquireFlock } from "../../src/index.ts"

const [mode, lockPath, readyPath] = process.argv.slice(2)
if (mode === undefined || lockPath === undefined) {
  throw new Error("usage: writer.ts <hold|once|adopt|adopt-cloexec> <lock-path> [ready-path]")
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
  const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
    fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  })
  const F_GETFD = 1
  const before = libc.symbols.fcntl(3, F_GETFD, 0)
  using lock = adoptInheritedFlock(lockPath, 3)
  if (lock === null) process.exit(2)
  writeFileSync(readyPath, JSON.stringify({ before, after: libc.symbols.fcntl(3, F_GETFD, 0) }))
  process.exit(0)
}

using lock = tryAcquireFlock(lockPath, { body: `${mode}:${process.pid}\n` })
if (lock === null) process.exit(2)

if (mode === "once") process.exit(0)
if (mode !== "hold" || readyPath === undefined) throw new Error(`unknown writer mode: ${mode}`)

writeFileSync(readyPath, "ready")
await new Promise(() => {})
