# @bearly/cli-process

A CLI entry that never loses its own output.

When a CLI writes to a pipe, two things lose output without a word:

- **Exiting by hand.** A pipe write is asynchronous past the kernel's 64 KiB buffer. `process.exit()` while it is
  pending drops the rest and still exits 0.
- **`console.log` on a non-blocking pipe.** Under Bun, once anything uses the `process.stdout` stream, stdout's pipe is
  non-blocking for the whole process. `console.log` writes the descriptor directly and, when the pipe fills, drops the
  rest of its text. A slow reader received 65,536 of 314,509 bytes.

## Install

> Install from npm; a git install resolves the TypeScript source and runs only under Bun.

```bash
bun add @bearly/cli-process
```

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
