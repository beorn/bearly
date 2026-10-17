// Hold inside the real production write, without exporting a failure/lock seam.
export {}
const fs = process.getBuiltinModule("node:fs")
fs.fsyncSync = () => {
  process.stdout.write("locked\n")
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}
const { writeFileBytesLocked } = await import("../../src/cas.ts")

const target = process.argv[2]
if (target === undefined) throw new Error("target path is required")

const result = writeFileBytesLocked(target, "held\n")

if (!result.ok) throw new Error(`failed to acquire fixture lock: ${result.reason}`)
