# Changelog

## 0.1.0

- `fullJitter(base, cap, attempt, random?)`, `decorrelatedJitter(base, cap, previous, random?)` and
  `awaitReady(probe, { timeoutMs, retryMs, maxRetryMs?, now, sleep, random? })`: pure pacing policy with no I/O.
- Seeded witnesses for each function, plus the properties that a delay never exceeds its cap and the gate never sleeps
  past its timeout.
- The probe must bound itself: the gate checks its timeout between probes, so a probe that never settles holds it.
- A zero base is a zero delay at every attempt, and a non-finite `retryMs` or `maxRetryMs` is a `RangeError` before the
  first probe.
