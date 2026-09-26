/**
 * @failure  A process asleep on a file lock cannot say who holds it unless /proc/locks is read by the file's device and
 *           inode. Readers that matched by inode alone named a same-inode file on another filesystem, readers that took
 *           FLOCK rows alone missed SQLite's POSIX locks, and a table that could not be read came back as "no holder".
 * @level    l1 - readLockHolders over fixture /proc text; l3 - fileLockHolders over a real flock.
 * @consumer the watchdog sampler's lockFiles; km-cli findSqliteLockHolder; hab-core sessionLockHolder
 * @testonly none
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { tryAcquireFlock } from "../src/index.ts"
import { fileLockHolders, formatLockHolders, procLocksDeviceId, readLockHolders } from "../src/holders.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// The device is the kernel's encoding of st_dev, printed %02x:%02x; one wrong mask and every holder reads as nobody.
describe("procLocksDeviceId prints st_dev the way /proc/locks does", () => {
  test.each([
    ["device-mapper fc:00 (decimal 252:0)", 0xfc00, "fc:00"],
    ["NVMe major 259, minor 1", 0x10301, "103:01"],
    ["tmpfs 00:2f", 0x2f, "00:2f"],
    ["a minor above 0xff (00:12345)", 0x12300045, "00:12345"],
  ])("%s", (_name, dev, printed) => {
    expect(procLocksDeviceId(dev)).toBe(printed)
  })
})

describe("readLockHolders reads every lock on each file, by device and inode", () => {
  const table =
    "1: FLOCK  ADVISORY  WRITE 15921 fc:00:104399277 0 EOF\n" +
    "2: POSIX  ADVISORY  READ 7 fc:00:500 128 128\n" +
    "3: POSIX  ADVISORY  WRITE 99 fc:00:500 120 120\n" +
    "3: -> POSIX  ADVISORY  WRITE 7 fc:00:500 120 120\n" +
    "4: FLOCK  ADVISORY  WRITE 99 fc:00:500 0 EOF\n" +
    "5: POSIX  ADVISORY  WRITE 42 08:03:500 0 EOF\n" +
    "6: POSIX  ADVISORY  READ 99 103:02:400 1073741826 1073741826\n"
  const files: Record<string, string> = {
    "/proc/locks": table,
    "/proc/7/cmdline": "bun\0daemon\0",
    "/proc/99/cmdline": "bun\0km\0sync\0",
  }
  const stats: Record<string, { dev: number; ino: number }> = {
    "/v/state.db": { dev: 0x10302, ino: 400 },
    "/v/state.db-shm": { dev: 0xfc00, ino: 500 },
    "/v/quiet.db": { dev: 0xfc00, ino: 777 },
  }
  const io = {
    read: (path: string) => {
      const text = files[path]
      if (text === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
      return text
    },
    stat: (path: string) => stats[path] ?? null,
  }

  test("a holder, self, a waiter, a POSIX and a FLOCK row on one inode, an absent file and a quiet one", () => {
    const report = readLockHolders(["/v/state.db", "/v/state.db-wal", "/v/state.db-shm", "/v/quiet.db"], {
      self: 7,
      io,
    })
    expect(report).toEqual({
      kind: "read",
      files: [
        {
          path: "/v/state.db",
          id: "103:02:400",
          locks: [
            {
              type: "POSIX",
              mode: "READ",
              pid: 99,
              self: false,
              range: "1073741826-1073741826",
              waiter: false,
              command: "bun km sync",
            },
          ],
        },
        { path: "/v/state.db-wal", absent: true },
        {
          path: "/v/state.db-shm",
          id: "fc:00:500",
          // 08:03:500 is the same inode on another device, and is not listed.
          locks: [
            { type: "POSIX", mode: "READ", pid: 7, self: true, range: "128-128", waiter: false, command: "bun daemon" },
            {
              type: "POSIX",
              mode: "WRITE",
              pid: 99,
              self: false,
              range: "120-120",
              waiter: false,
              command: "bun km sync",
            },
            { type: "POSIX", mode: "WRITE", pid: 7, self: true, range: "120-120", waiter: true, command: "bun daemon" },
            {
              type: "FLOCK",
              mode: "WRITE",
              pid: 99,
              self: false,
              range: "0-EOF",
              waiter: false,
              command: "bun km sync",
            },
          ],
        },
        { path: "/v/quiet.db", id: "fc:00:777", locks: [] },
      ],
    })
    expect(formatLockHolders(report, 3)).toBe(
      'locks: state.db 99 POSIX READ 1073741826-1073741826 "bun km sync"; state.db-wal absent; ' +
        'state.db-shm 7(self) POSIX READ 128-128, 99 POSIX WRITE 120-120 "bun km sync", 7(self) waits POSIX WRITE 120-120 ' +
        "+1 more; quiet.db none (fc:00:777)",
    )
  })

  test("a table that cannot be read is unknown with its error, never an answer of no holder", () => {
    const hidden = { ...io, read: (path: string) => (path === "/proc/locks" ? io.read("/proc/nope") : io.read(path)) }
    const report = readLockHolders(["/v/state.db"], { self: 7, io: hidden })
    expect(report).toEqual({
      kind: "unknown",
      reason: "cannot read /proc/locks: ENOENT: no such file or directory, open '/proc/nope'",
    })
    expect(formatLockHolders(report)).toBe(
      "locks unknown (cannot read /proc/locks: ENOENT: no such file or directory, open '/proc/nope')",
    )
  })

  test("a file that cannot be stat'ed for a reason other than absence says why; a holder's unreadable command says why", () => {
    const report = readLockHolders(["/v/denied", "/v/state.db"], {
      self: 7,
      io: {
        read: (path: string) => (path === "/proc/99/cmdline" ? io.read("/proc/gone") : io.read(path)),
        stat: (path: string) => {
          if (path === "/v/denied") throw new Error("EACCES: permission denied")
          return io.stat(path)
        },
      },
    })
    expect(formatLockHolders(report)).toBe(
      "locks: denied unreadable (cannot stat: EACCES: permission denied); state.db 99 POSIX READ 1073741826-1073741826 " +
        "\"(command unreadable: ENOENT: no such file or directory, open '/proc/gone')\"",
    )
  })
})

describe("fileLockHolders reads the running kernel", () => {
  test("names this process as the holder of a flock it took", () => {
    const root = mkdtempSync(join(tmpdir(), "bearly-holders-"))
    roots.push(root)
    const path = join(root, "session.lock")
    writeFileSync(path, "")
    const handle = tryAcquireFlock(path)
    expect(handle).not.toBeNull()
    try {
      const report = fileLockHolders([path], { self: process.pid })
      if (report.kind === "unknown") throw new Error(`this test needs Linux /proc/locks: ${report.reason}`)
      const file = report.files[0]
      expect(file && "locks" in file ? file.id : null).toBe(
        `${procLocksDeviceId(statSync(path).dev)}:${statSync(path).ino}`,
      )
      expect(file && "locks" in file ? file.locks.map(({ type, pid, self }) => ({ type, pid, self })) : []).toEqual([
        { type: "FLOCK", pid: process.pid, self: true },
      ])
    } finally {
      handle?.release()
    }
  })
})
