# @bearly/pacing

Pure pacing policy for reconnect and restart loops: when to try again, and when a dependency is ready.

Nothing here owns a clock, a timer, a socket or a process. You pass `now`, `sleep`, your probe and, in tests, a seeded
random source. The module holds three well-known patterns in one place, so every loop that paces itself can use the
same code.

## Install

> Install from npm; a git install resolves the TypeScript source and runs only under Bun.

```bash
bun add @bearly/pacing
```

## Use

```ts
import { awaitReady, decorrelatedJitter, fullJitter } from "@bearly/pacing"

// Full jitter: uniform in [0, min(cap, base * 2 ** attempt)]. A plain spread over a window is base = cap = window.
const delay = fullJitter(250, 30_000, attempt)

// Decorrelated jitter: uniform in [base, min(cap, previous * 3)]; feed back the last delay (base on the first call).
let wait = 500
wait = decorrelatedJitter(500, 30_000, wait)

// Readiness gate: probe until it answers true or the timeout (a duration) passes.
const outcome = await awaitReady(() => daemon.ping(), {
  timeoutMs: 30_000,
  retryMs: 250,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
})
if (!outcome.ready) console.warn(`daemon not ready after ${outcome.waitedMs} ms`, outcome.lastError)
```

`awaitReady` probes once at once, with no sleep. It then sleeps by decorrelated jitter between `retryMs` and
`maxRetryMs` (default `retryMs * 8`), clipped so it never sleeps past the timeout. The last probe runs at or before the
timeout, and `ready: false` comes back only after it. A probe that throws counts as not ready, and its last error is
returned.

Every function throws `RangeError` when its bounds name no delay (a negative base, a cap below base, a fractional
attempt).

## Guarantees

- A delay never exceeds its cap, and decorrelated jitter never falls below its base.
- The readiness gate never sleeps past its timeout.
- No I/O, timers or globals. `Math.random` is the default random source, and every function takes a replacement.
