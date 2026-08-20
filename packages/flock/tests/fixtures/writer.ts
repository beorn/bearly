import { writeFileSync } from "node:fs"
import { adoptInheritedFlock, tryAcquireFlock } from "../../src/index.ts"

const [mode, lockPath, readyPath] = process.argv.slice(2)
if (mode === undefined || lockPath === undefined)
  {throw new Error("usage: writer.ts <hold|once|adopt> <lock-path> [ready-path]")}

if (mode === "adopt") {
  using lock = adoptInheritedFlock(lockPath, 3)
  if (lock === null) process.exit(2)
  process.exit(0)
}

using lock = tryAcquireFlock(lockPath, { body: `${mode}:${process.pid}\n` })
if (lock === null) process.exit(2)

if (mode === "once") process.exit(0)
if (mode !== "hold" || readyPath === undefined) throw new Error(`unknown writer mode: ${mode}`)

writeFileSync(readyPath, "ready")
await new Promise(() => {})
