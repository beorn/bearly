# @bearly/flock

Crash-safe, fd-held advisory file locks for Bun and Node 24 on local macOS and Linux
filesystems.

`@bearly/flock` is a small `flock(2)` binding with three guarantees:

- the kernel releases ownership after the final descriptor closes, including
  when its process receives `SIGKILL`;
- only `EAGAIN` / `EWOULDBLOCK` is reported as contention; other syscall
  failures throw with the path and errno;
- optional diagnostic bytes are completely written and fsynced before an
  acquired handle is returned.

The durable pathname and its bytes are diagnostics, not ownership. The file is
intentionally retained after release and may describe the previous owner. Use
`isFlockHeld()` to observe current ownership.

## Install

> Install from npm. Source installs require Bun or Node 24 with TypeScript stripping.

```bash
bun add @bearly/flock
```

Bun uses its own `bun:ffi` adapter; Node uses the prebuilt Koffi 3.3.2 adapter.
Neither runtime loads the other binding. Koffi install scripts are not trusted;
no compiler is required on the supported prebuilt platforms.

| Runtime and platform                     | Evidence                                               |
| ---------------------------------------- | ------------------------------------------------------ |
| Bun, Linux and macOS                     | Existing native contract suite                         |
| Node 24, Linux x64                       | Measured inherited-FD and crash-release contract suite |
| Node 24, Linux arm64 and macOS x64/arm64 | Upstream prebuilds; unmeasured by us                   |
| Windows                                  | Unsupported                                            |

Node on macOS requires the same contract suite to pass before a consumer is
declared supported. The
contract is limited to local filesystems. Network filesystems can implement
`flock` with different semantics and are outside this package's guarantees.

## Usage

```ts
import { tryAcquireFlock } from "@bearly/flock"

using lock = tryAcquireFlock("/tmp/my-app/writer.lock", {
  body: `${JSON.stringify({ pid: process.pid })}\n`,
})

if (lock === null) throw new Error("another writer owns the resource")
// The lock remains held until this scope closes its fd.
```

For a synchronous critical section that must wait indefinitely:

```ts
import { acquireFlockBlocking } from "@bearly/flock"

using lock = acquireFlockBlocking("/tmp/my-app/migration.lock")
runMigration()
```

Timed waits, retry cadence, cancellation, path policy, and error wording belong
to the caller. Build those policies by looping over `tryAcquireFlock()`.

## Descriptor inheritance

`lock.fd` is public so a supervisor can pass the acquired descriptor to a
child. `release()` closes only this handle's descriptor; it never calls
`LOCK_UN`, because explicit unlock would also release a lock still owned
through an inherited duplicate. The kernel drops ownership after the last
descriptor for that open-file description closes.

`lock.held` reports only this local handle. It becomes false after
`lock.release()` even when an inherited child still owns a duplicate.

## Diagnostic bytes

`lock.replaceBody(body)` truncates, writes every byte, and fsyncs before
returning. If truncate, write, or fsync fails, the local claim is closed and the
error is thrown. Readers that ignore the flock can still observe an in-progress
truncate/write sequence; the guarantee is completion-or-error for the writer,
not atomic old-or-new visibility for unlocked readers.

## Development

```bash
bun run test
# With Node 24 available:
bun run test:node
bun run typecheck
bun run build
```
