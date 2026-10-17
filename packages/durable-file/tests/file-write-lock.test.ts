/**
 * @failure A non-CAS writer can ignore the exact-path lock and overwrite a
 *          compare-and-swap writer inside its compare-to-rename window.
 * @level   l1 — real adjacent lock and atomic file replacement.
 * @consumer @ag/code/shared-status-writer-lock
 * @testonly none
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { tryAcquireFlock } from "@bearly/flock"
import { safeRemoveSync } from "removely"
import { afterEach, describe, expect, test, vi } from "vitest"

const faults = vi.hoisted(() => ({ short: false, directoryFailure: false, syncs: 0, offsets: [] as number[] }))
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>()
  return {
    ...real,
    writeSync: (fd: number, bytes: Uint8Array, offset: number, length: number) => {
      if (faults.short) faults.offsets.push(offset)
      return real.writeSync(fd, bytes, offset, faults.short ? Math.min(3, length) : length)
    },
    fsyncSync: (fd: number) => {
      if (faults.directoryFailure && ++faults.syncs === 2) throw new Error("directory fsync unavailable")
      return real.fsyncSync(fd)
    },
  }
})
vi.resetModules()
const {
  commitFileBytesIfUnchanged,
  removeFileBytesAndLockIfUnchanged,
  removeFileBytesIfUnchanged,
  writeFileBytesLocked,
} = await import("../src/cas.ts")
afterEach(() => {
  faults.short = false
  faults.directoryFailure = false
  faults.syncs = 0
  faults.offsets = []
})

describe("locked file writes", () => {
  test("CAS opt-in waits for a real holder, times out once, and preserves immediate default and changed bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "durable-cas-wait-"))
    const path = join(dir, "manifest.json")
    const ready = join(dir, "ready")
    writeFileSync(path, "before")
    const holder = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../../flock/tests/fixtures/writer.ts", import.meta.url)),
        "hold",
        `${path}.lock`,
        ready,
        "600",
      ],
      { stdout: "ignore", stderr: "pipe" },
    )
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true))
      const immediate = performance.now()
      expect(commitFileBytesIfUnchanged(path, "before", "after")).toEqual({ ok: false, reason: "locked" })
      expect(performance.now() - immediate).toBeLessThan(200)
      const timed = performance.now()
      expect(commitFileBytesIfUnchanged(path, "before", "after", { lockTimeoutMs: 150 })).toEqual({
        ok: false,
        reason: "locked",
      })
      expect(performance.now() - timed).toBeGreaterThanOrEqual(125)
      expect(readFileSync(path, "utf8")).toBe("before")
      expect(commitFileBytesIfUnchanged(path, "before", "after", { lockTimeoutMs: 1500 })).toEqual({ ok: true })
      expect(readFileSync(path, "utf8")).toBe("after")
      expect(commitFileBytesIfUnchanged(path, "before", "stale", { lockTimeoutMs: 100 })).toEqual({
        ok: false,
        reason: "changed",
        currentRaw: "after",
      })
    } finally {
      holder.kill()
      await holder.exited
      safeRemoveSync(dir, { within: tmpdir(), allowMissing: true })
    }
  })
  test("a writer killed while holding the production lock cannot wedge its successor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inhab-file-write-kill-"))
    const path = join(dir, "status")
    const holder = Bun.spawn(
      [process.execPath, fileURLToPath(new URL("./fixtures/file-lock-holder.ts", import.meta.url)), path],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    )

    try {
      const reader = holder.stdout.getReader()
      const announcement = await reader.read()
      expect(new TextDecoder().decode(announcement.value)).toContain("locked")

      process.kill(holder.pid, "SIGKILL")
      await holder.exited

      expect(writeFileBytesLocked(path, "successor\n")).toEqual({ ok: true })
      expect(readFileSync(path, "utf8")).toBe("successor\n")
    } finally {
      holder.kill()
      await holder.exited
      safeRemoveSync(dir, { within: tmpdir(), allowMissing: true })
    }
  })

  test("shares the exact adjacent lock used by CAS writers", () => {
    const dir = mkdtempSync(join(tmpdir(), "inhab-file-write-lock-"))
    const path = join(dir, "status")
    const lockPath = `${path}.lock`
    try {
      writeFileSync(path, "before\n")
      const lock = tryAcquireFlock(lockPath)
      expect(lock).not.toBeNull()
      try {
        expect(writeFileBytesLocked(path, "during\n")).toEqual({ ok: false, reason: "locked" })
        expect(readFileSync(path, "utf8")).toBe("before\n")
      } finally {
        lock?.release()
      }

      const completeBytes = `${"durable-ø".repeat(32_768)}\n`
      expect(writeFileBytesLocked(path, completeBytes)).toEqual({ ok: true })
      expect(readFileSync(path, "utf8")).toBe(completeBytes)
    } finally {
      safeRemoveSync(dir, { within: tmpdir(), allowMissing: true })
    }
  })

  test("retries short writes until every byte is handed to the filesystem", () => {
    const bytes = Buffer.from("durable-ø-complete")
    const dir = mkdtempSync(join(tmpdir(), "durable-file-short-write-"))
    try {
      faults.short = true
      const path = join(dir, "status")
      expect(writeFileBytesLocked(path, bytes.toString())).toEqual({ ok: true })
      expect(readFileSync(path)).toEqual(bytes)
      expect(faults.offsets).toEqual(Array.from({ length: Math.ceil(bytes.length / 3) }, (_, index) => index * 3))
    } finally {
      safeRemoveSync(dir, { within: tmpdir(), allowMissing: true })
    }
  })

  test("propagates directory durability failures and still releases kernel ownership", () => {
    const dir = mkdtempSync(join(tmpdir(), "inhab-file-write-durability-"))
    const path = join(dir, "status")
    try {
      faults.directoryFailure = true
      expect(() => writeFileBytesLocked(path, "published-but-not-certified\n")).toThrow("directory fsync unavailable")
      expect(readFileSync(path, "utf8")).toBe("published-but-not-certified\n")
      expect(existsSync(`${path}.lock`)).toBe(true)
      faults.directoryFailure = false
      expect(writeFileBytesLocked(path, "recovered\n")).toEqual({ ok: true })
    } finally {
      safeRemoveSync(dir, { within: tmpdir(), allowMissing: true })
    }
  })
})

test("CAS compares the exact observed bytes, including absence, before publishing", () => {
  const dir = mkdtempSync(join(tmpdir(), "durable-file-cas-"))
  const path = join(dir, "state")
  try {
    expect(commitFileBytesIfUnchanged(path, null, "first\n")).toEqual({ ok: true })
    expect(commitFileBytesIfUnchanged(path, null, "stale\n")).toEqual({
      ok: false,
      reason: "changed",
      currentRaw: "first\n",
    })
    expect(commitFileBytesIfUnchanged(path, "first\n", "next\n")).toEqual({ ok: true })
    expect(readFileSync(path, "utf8")).toBe("next\n")
  } finally {
    safeRemoveSync(dir, { within: tmpdir(), allowMissing: true })
  }
})

/**
 * The WITHDRAWAL pair (@cto 2026-10-14, 29292): a record and its adjacent lock file go together, or
 * neither does. These rows are where the INTERLEAVINGS live -- the bytes moving under the caller, and
 * another holder owning the lock -- because the record store that withdraws rows keeps only policy.
 */
describe("withdrawing a record and its adjacent lock together", () => {
  test("removes the record AND its lock file in one call, leaving no lock behind to wedge the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "inhab-withdraw-both-"))
    const path = join(dir, "session.json")
    try {
      writeFileSync(path, "committed\n")
      expect(removeFileBytesAndLockIfUnchanged(path, "committed\n")).toEqual({ ok: true })

      expect(existsSync(path), "the record is gone").toBe(false)
      expect(existsSync(`${path}.lock`), "the lock file went with it, unlinked while still held").toBe(false)
      // A later writer takes a FRESH lock at the same path rather than inheriting an orphaned one.
      expect(writeFileBytesLocked(path, "next generation\n")).toEqual({ ok: true })
      expect(readFileSync(path, "utf8")).toBe("next generation\n")
    } finally {
      safeRemoveSync(dir, { within: tmpdir(), allowMissing: true })
    }
  })

  test("refuses when the bytes moved, deleting neither the record nor its lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "inhab-withdraw-changed-"))
    const path = join(dir, "session.json")
    try {
      writeFileSync(path, "someone else's row\n")
      expect(removeFileBytesAndLockIfUnchanged(path, "the bytes we committed\n")).toEqual({
        ok: false,
        reason: "changed",
        currentRaw: "someone else's row\n",
      })
      expect(readFileSync(path, "utf8")).toBe("someone else's row\n")
      expect(existsSync(`${path}.lock`)).toBe(true)
    } finally {
      safeRemoveSync(dir, { within: tmpdir(), allowMissing: true })
    }
  })

  test("refuses while another holder owns the lock, and leaves that holder's file alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "inhab-withdraw-locked-"))
    const path = join(dir, "session.json")
    try {
      writeFileSync(path, "committed\n")
      const holder = tryAcquireFlock(`${path}.lock`)
      expect(holder).not.toBeNull()
      try {
        expect(removeFileBytesAndLockIfUnchanged(path, "committed\n")).toEqual({ ok: false, reason: "locked" })
        expect(readFileSync(path, "utf8"), "nothing was withdrawn").toBe("committed\n")
      } finally {
        holder?.release()
      }
      // The neighbour, which takes the lock itself, behaves the same way about the same path.
      const reholder = tryAcquireFlock(`${path}.lock`)
      try {
        expect(removeFileBytesIfUnchanged(path, "committed\n")).toEqual({ ok: false, reason: "locked" })
      } finally {
        reholder?.release()
      }
      expect(removeFileBytesAndLockIfUnchanged(path, "committed\n")).toEqual({ ok: true })
      expect(existsSync(path)).toBe(false)
      expect(existsSync(`${path}.lock`)).toBe(false)
    } finally {
      safeRemoveSync(dir, { within: tmpdir(), allowMissing: true })
    }
  })
})
