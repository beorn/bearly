# Changelog

## 0.2.2

- Runs under Node 24 as well as Bun: the lock core sits behind one platform seam, with a `bun:ffi` binding for Bun and a `koffi` binding for Node (hh 26964). `engines` now declares `node >=24`, and `koffi` is a dependency.

## 0.2.1

- The first published 0.2.x: the flock-v0.2.0 tag never reached npm, because its CI publish failed E404 (26540). It carries 0.2.0 below plus:
- A lent lock descriptor is adopted only when it holds the checkout lock, and two lock names that disagree refuse (26001).
- Declares only the `bun:ffi` slice it calls, with no Bun globals (26287).
- Development dependencies aligned (tsdown 0.22.13, pinned Bun types).

## 0.2.0

- `@bearly/flock/holders`: who holds a lock on a file, read from Linux's `/proc/locks` by
  the file's device and inode. `fileLockHolders(paths, { self })` lists every lock type
  (FLOCK, POSIX, OFDLCK) with its holder's pid, byte range and command line, and a queued
  waiter as a waiter; a table it cannot read answers `unknown` with the reason, never "no
  holder". `procLocksDeviceId`, `readLockHolders` (the pure core over injected IO) and
  `formatLockHolders` are exported; the three reference nothing outside themselves, so a
  worker can embed their source.

## 0.1.1

- An adopted descriptor is marked close-on-exec, set through a non-variadic `fcntl` call and
  read back (published 2026-09-17 from a68b07f8; tagged afterwards).

## 0.1.0

- Initial Bun/macOS/Linux `flock(2)` package.
- Nonblocking and blocking acquisition, fd inheritance, held probing, and
  complete diagnostic publication.
- Real-process SIGKILL, inherited-fd, errno, alias, and short-write coverage.
