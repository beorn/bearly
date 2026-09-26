# Changelog

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
