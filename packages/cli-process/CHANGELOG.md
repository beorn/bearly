# Changelog

## Unreleased

- Bun 1.4.3 no longer drops the tail of an unrouted `console.log` on a slow pipe. The control test is now a canary
  that fails if the drop returns; `routeConsoleToStreams()` stays for consumers on an older Bun (hh 27071).

## 0.1.0

- `runCliProcess(name, main, argv?)`: run a CLI's body, set its exit code and let stdout and stderr drain; a reader
  that closes early fails the command by name (EPIPE, exit 1). Moved from gitomic's entry (gitomic 25382).
- `routeConsoleToStreams()`: send the console's output through `process.stdout` and `process.stderr`, whose writes are
  queued and drained, instead of the console's direct write, which Bun drops on a full non-blocking pipe (hh 27071).
- `@bearly/cli-process/testing`: `slowPipeRoundTrip(command, options?)` proves a command's output reaches a slow
  reader whole, with its real exit code, or that an early-closing reader makes it fail by name.
