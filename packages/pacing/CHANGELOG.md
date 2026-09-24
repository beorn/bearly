# Changelog

## 0.1.0

- `fullJitter(base, cap, attempt, random?)`, `decorrelatedJitter(base, cap, previous, random?)` and
  `awaitReady(probe, { timeoutMs, retryMs, maxRetryMs?, now, sleep, random? })`: pure pacing policy with no I/O.
- Seeded witnesses for each function, plus the properties that a delay never exceeds its cap and the gate never sleeps
  past its timeout.
