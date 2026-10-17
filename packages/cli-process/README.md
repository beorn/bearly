# @bearly/cli-process

A CLI entry that never loses its own output.

When a CLI writes to a pipe, two things lose output without a word:

- **Exiting by hand.** A pipe write is asynchronous past the kernel's 64 KiB buffer. `process.exit()` while it is
  pending drops the rest and still exits 0.
- **`console.log` on a non-blocking pipe.** Under Bun, once anything uses the `process.stdout` stream, stdout's pipe is
  non-blocking for the whole process. `console.log` writes the descriptor directly and, when the pipe fills, drops the
  rest of its text. A slow reader received 65,536 of 314,509 bytes. Bun 1.4.3 fixed this; `routeConsoleToStreams()`
  remains the single console routing path. The package's control test records the historical drop and fails
  if it comes back on a supported Bun.

## Install

> Install from npm; a git install resolves the TypeScript source and runs only under Bun.

```bash
bun add @bearly/cli-process
```

Version 0.2.0 requires Bun 1.4.3 or later, or Node 20 or later. It drops the previously supported Bun range
`>=1.3.13 <1.4.3`: on Bun 1.3.14, a reader that closes fast can leave the command's exit code unchanged and omit
the named EPIPE diagnostic ([CI run 39018308447](https://github.com/beorn/bearly/actions/runs/39018308447)).
The owning early-close test reproduces this with `delaySeconds: 0` and `closeAfterBytes: 100`.
Bun 1.4.3 is the first measured-good runtime; the first release containing the runtime fix is unknown.

## Use

Call both once, at the CLI's entry, and nowhere else:

```ts
import { routeConsoleToStreams, runCliProcess } from "@bearly/cli-process"

routeConsoleToStreams()
await runCliProcess("mytool", async (argv) => {
  console.log(JSON.stringify(await report(argv), null, 2))
  return 0
})
```

- `runCliProcess(name, main, argv?)` runs `main`, sets `process.exitCode` to its answer and returns, so stdout and
  stderr drain before the process exits. It never calls `process.exit`. A reader that closes early (EPIPE) fails the
  command with exit 1 and one line naming it and its arguments.
- `routeConsoleToStreams()` sends `console.log` and `console.info` through `process.stdout.write`, and `console.error`
  and `console.warn` through `process.stderr.write`, formatted the way the console formats them.

## Test

```ts
import { slowPipeRoundTrip } from "@bearly/cli-process/testing"

const run = await slowPipeRoundTrip(["bun", "bin.ts", "dump", "--json"])
expect(run.bytes).toBe(expectedBytes)
expect(run.exitCode).toBe(0)
```

The command writes into a pipe whose reader waits a second before reading, so every byte past the pipe buffer is still
pending when the command finishes. Pass `closeAfterBytes` to make the reader close early and prove the EPIPE path. The
reader is bash, so this needs bash on PATH.
