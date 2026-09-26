/**
 * Who holds a lock on a file, read from Linux's /proc/locks by the file's device and inode.
 *
 * The one reader of /proc/locks: a process asleep on a file lock (SQLite's busy handler sleeps in nanosleep, a flock
 * waiter sleeps in the kernel) cannot say who holds it any other way. It matches the device as well as the inode, so a
 * same-inode file on another filesystem is never named, and it lists every lock type (SQLite's are POSIX, a session
 * lock is FLOCK). A table it cannot read is `unknown` with the error, never an answer of "nobody".
 *
 * `readLockHolders`, `procLocksDeviceId` and `formatLockHolders` reference nothing outside themselves (node:fs is
 * `fileLockHolders`' alone), so a worker that cannot import, a watchdog's procfs sampler, can embed their source.
 */
import { readFileSync, statSync } from "node:fs"

/** One lock /proc/locks lists on a file. */
export interface LockRow {
  /** FLOCK, POSIX or OFDLCK, as the kernel prints it. */
  readonly type: string
  /** READ or WRITE. */
  readonly mode: string
  /** The holder's pid; -1 for an open-file-description lock, which no one process owns. */
  readonly pid: number
  /** The holder is the process that asked. */
  readonly self: boolean
  /** Byte range, "start-end" ("0-EOF" for a whole-file lock). */
  readonly range: string
  /** The kernel has queued this request behind a conflicting lock (a "->" row): the pid waits, it does not hold. */
  readonly waiter: boolean
  /** The pid's command line, or why it could not be read. */
  readonly command: string
}

/** One file's answer: absent, unreadable with the reason, or its device:inode and every lock on it. */
export type FileLocks =
  | { readonly path: string; readonly absent: true }
  | { readonly path: string; readonly unreadable: string }
  | { readonly path: string; readonly id: string; readonly locks: readonly LockRow[] }

/** Every watched file's locks, or why this host cannot say. */
export type LockHolders =
  | { readonly kind: "read"; readonly files: readonly FileLocks[] }
  | { readonly kind: "unknown"; readonly reason: string }

/** How the reader reaches the kernel; `fileLockHolders` passes node:fs, a test passes fixture text. */
export interface LockHoldersIo {
  /** A file's text; throws with the reason when it cannot be read. */
  readonly read: (path: string) => string
  /** A file's device and inode; null when it does not exist, throws with the reason for anything else. */
  readonly stat: (path: string) => { readonly dev: number; readonly ino: number } | null
}

/**
 * The `major:minor` a `/proc/locks` line prints for a file on the device `st_dev` (fs/locks.c: `%02x:%02x`,
 * lowercase hex). Linux encodes a 12-bit major and a 20-bit minor into 32 bits: minor bits 0-7, major bits 8-19,
 * minor bits 20-31. This is the low half of the layout glibc's `gnu_dev_major`/`gnu_dev_minor` decode; the upper 32
 * bits are always zero on Linux, so no high term is read. It references nothing outside itself.
 */
export function procLocksDeviceId(dev: number): string {
  const major = (dev >> 8) & 0xfff
  const minor = (dev & 0xff) | ((dev >> 12) & 0xfff00)
  return `${major.toString(16).padStart(2, "0")}:${minor.toString(16).padStart(2, "0")}`
}

/**
 * Every lock on each of `paths`, from `<root>/locks` read through `io`. It references nothing outside itself except
 * `procLocksDeviceId`, so an embedding worker includes both.
 */
export function readLockHolders(
  paths: readonly string[],
  options: { readonly self: number; readonly io: LockHoldersIo; readonly root?: string },
): LockHolders {
  const { self, io } = options
  const root = options.root ?? "/proc"
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))
  let table: string
  try {
    table = io.read(`${root}/locks`)
  } catch (error) {
    return { kind: "unknown", reason: `cannot read ${root}/locks: ${reason(error)}` }
  }
  // "N: [->] TYPE ADVISORY|MANDATORY READ|WRITE pid MAJ:MIN:INODE start end"; a queued waiter's row carries "->".
  const rows = table
    .split("\n")
    .map((line) => line.trim().split(/\s+/u).slice(1))
    .filter((fields) => fields.length >= 7)
  const commands = new Map<number, string>()
  const commandOf = (pid: number) => {
    let command = commands.get(pid)
    if (command === undefined) {
      try {
        const argv = io.read(`${root}/${pid}/cmdline`).split("\0").filter(Boolean).join(" ")
        command = argv === "" ? "(no command line)" : argv
      } catch (error) {
        command = `(command unreadable: ${reason(error)})`
      }
      commands.set(pid, command)
    }
    return command
  }
  const files = paths.map((path): FileLocks => {
    let stat: { dev: number; ino: number } | null
    try {
      stat = io.stat(path)
    } catch (error) {
      return { path, unreadable: `cannot stat: ${reason(error)}` }
    }
    if (stat === null) return { path, absent: true }
    const id = `${procLocksDeviceId(stat.dev)}:${stat.ino}`
    const locks: LockRow[] = []
    for (const fields of rows) {
      const waiter = fields[0] === "->"
      const [type = "?", , mode = "?", holder = "?", lockId, start = "?", end = "?"] = waiter ? fields.slice(1) : fields
      if (lockId !== id) continue
      const pid = Number(holder)
      locks.push({ type, mode, pid, self: pid === self, range: `${start}-${end}`, waiter, command: commandOf(pid) })
    }
    return { path, id, locks }
  })
  return { kind: "read", files }
}

/**
 * One line of text for a report, as a stall line prints it: each file by its base name, its locks (the asker as
 * "(self)", a waiter as "waits", another holder with its command line), "+N more" past `cap`, "none (<device:inode>)"
 * so a device or inode that matched nothing is visible, "absent", or why it could not be read. It references nothing
 * outside itself.
 */
export function formatLockHolders(report: LockHolders, cap = 6): string {
  if (report.kind === "unknown") return `locks unknown (${report.reason})`
  const described = report.files.map((file) => {
    const name = file.path.slice(file.path.lastIndexOf("/") + 1)
    if ("absent" in file) return `${name} absent`
    if ("unreadable" in file) return `${name} unreadable (${file.unreadable})`
    if (file.locks.length === 0) return `${name} none (${file.id})`
    const shown = file.locks.slice(0, cap).map((lock) => {
      const who = lock.self ? `${lock.pid}(self)` : String(lock.pid)
      const command = lock.self ? "" : ` "${lock.command.length > 80 ? `${lock.command.slice(0, 79)}…` : lock.command}"`
      return `${who}${lock.waiter ? " waits" : ""} ${lock.type} ${lock.mode} ${lock.range}${command}`
    })
    const more = file.locks.length > cap ? ` +${file.locks.length - cap} more` : ""
    return `${name} ${shown.join(", ")}${more}`
  })
  return `locks: ${described.join("; ")}`
}

/** Every lock on each of `paths`, read from this host's /proc/locks. */
export function fileLockHolders(paths: readonly string[], options: { readonly self: number }): LockHolders {
  return readLockHolders(paths, {
    self: options.self,
    io: {
      read: (path) => readFileSync(path, "utf8"),
      stat: (path) => {
        try {
          const { dev, ino } = statSync(path)
          return { dev, ino }
        } catch (error) {
          if ((error as { code?: unknown }).code === "ENOENT") return null
          throw error
        }
      },
    },
  })
}
