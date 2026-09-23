# @bearly/watchdog

A watchdog that a spinning main thread cannot starve.

The main thread stamps a `SharedArrayBuffer` to say it is alive. A worker
thread checks the stamp's age with `Atomics.wait` and, when it goes stale,
logs (repeating with a count, then noting recovery), kills with `SIGKILL`, or
logs and then escalates to a kill. A one-shot deadline is the same watchdog
with a stamp that is never refreshed and a kill action.

A timer on the main thread cannot do this: a synchronous spin stops every
timer, socket callback and signal handler on that thread.

```ts
import { armWatchdog } from "@bearly/watchdog"

const dog = armWatchdog({
  label: "my-server",
  checkEveryMs: 1_000,
  fields: ["inFlight"],
  log: {
    afterMs: 10_000,
    repeatEveryMs: 10_000,
    message: "main thread silent {elapsedS}s, {inFlight} in flight (warning {count})\n",
    recovered: "main thread back after {elapsedS}s\n",
  },
  kill: { afterMs: 60_000, message: "main thread silent {elapsedS}s; killing\n" },
})
setInterval(() => dog.stamp(), 1_000).unref()
dog.set("inFlight", 0)
```

If the worker dies, the main thread writes `watchdog <label>: its worker failed, so this
process is no longer watched: <reason>` to stderr; only `disarm()` ends the watch quietly.

Lines are written with `writeSync` to stderr and are built only from shared
memory: `{elapsed}`, `{elapsedS}`, `{count}`, `{time}`, integer fields as
`{name}`, table names as `{name:name}` (publish a negative code for "none"),
and an epoch-ms time as its age, `{name:ageS}` (`4.2s`, or `none` for 0).
