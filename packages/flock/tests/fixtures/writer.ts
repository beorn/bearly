import { writeFileSync } from "node:fs"
import { tryAcquireFlock } from "../../src/index.ts"

const [mode, lockPath, readyPath] = process.argv.slice(2)
if (mode === undefined || lockPath === undefined)
  throw new Error("usage: writer.ts <hold|once> <lock-path> [ready-path]")

using lock = tryAcquireFlock(lockPath, { body: `${mode}:${process.pid}\n` })
if (lock === null) process.exit(2)

if (mode === "once") process.exit(0)
if (mode !== "hold" || readyPath === undefined) throw new Error(`unknown writer mode: ${mode}`)

writeFileSync(readyPath, "ready")
await new Promise(() => {})
