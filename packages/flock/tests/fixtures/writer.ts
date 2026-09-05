import { fstatSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { adoptInheritedFlock, tryAcquireFlock } from "../../src/index.ts"

const [mode, lockPath, readyPath] = process.argv.slice(2)
if (mode === undefined || lockPath === undefined) {
  throw new Error("usage: writer.ts <hold|once|adopt> <lock-path> [ready-path]")
}

if (mode === "adopt") {
  const before = closeOnExec(3)
  using lock = adoptInheritedFlock(lockPath, 3)
  if (lock === null) process.exit(2)
  const after = closeOnExec(lock.fd)
  const descendant = Bun.spawn([process.execPath, import.meta.path, "inspect", lockPath], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  const output = await new Response(descendant.stdout).text()
  if ((await descendant.exited) !== 0) throw new Error(await new Response(descendant.stderr).text())
  process.stdout.write(JSON.stringify({ before, after, inherited: JSON.parse(output) }))
  process.exit(0)
}

if (mode === "inspect") {
  const expected = statSync(lockPath, { bigint: true })
  const inherited: number[] = []
  for (const entry of readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd")) {
    const fd = Number(entry)
    try {
      const actual = fstatSync(fd, { bigint: true })
      if (actual.dev === expected.dev && actual.ino === expected.ino) inherited.push(fd)
    } catch (error) {
      // The directory enumeration's own descriptor may already be closed.
      if (!(error instanceof Error && "code" in error && error.code === "EBADF")) throw error
    }
  }
  process.stdout.write(JSON.stringify(inherited))
  process.exit(0)
}

using lock = tryAcquireFlock(lockPath, { body: `${mode}:${process.pid}\n` })
if (lock === null) process.exit(2)

if (mode === "once") process.exit(0)
if (mode !== "hold" || readyPath === undefined) throw new Error(`unknown writer mode: ${mode}`)

writeFileSync(readyPath, "ready")
await new Promise(() => {})

function closeOnExec(fd: number): boolean | null {
  if (process.platform !== "linux") return null
  const info = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8")
  const flags = /^flags:\s+([0-7]+)$/m.exec(info)?.[1]
  if (flags === undefined) throw new Error(`fdinfo omitted flags for descriptor ${fd}`)
  return (Number.parseInt(flags, 8) & 0o2000000) !== 0
}
