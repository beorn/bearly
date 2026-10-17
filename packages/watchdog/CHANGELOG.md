# Changelog

## 0.2.0

- The worker's lines reach stderr through loggily's line sink (`loggily/sink`, new dependency) instead of a blocking
  `writeSync`: a stderr whose reader has stalled parks the sink's writer thread, never the watchdog, so warnings keep
  coming and a kill still kills. A kill now waits at most 1 s for its line to reach the kernel before the SIGKILL goes
  ahead regardless; a line past the sink's byte bound (64 KiB in flight) is dropped and counted, and the next line
  written says how many were dropped and for how long. Measured 2026-10-16 under Bun 1.4.3: the km daemon's watchdog
  warned once and then went quiet with the daemon, its worker parked in `writeSync(2)` (km 25947). The notices that the
  watch itself died stay direct writes.

## 0.1.0

- First release: `armWatchdog`, a worker-thread watchdog over a SharedArrayBuffer stamp, with log (repeat, count, recovery) and kill actions; its lines are built only from shared memory. The entry exports `armWatchdog` and its types.
