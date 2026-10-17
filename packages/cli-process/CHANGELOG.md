# Changelog

## 0.2.0

### Breaking

- Require Bun `>=1.4.3`, dropping `>=1.3.13 <1.4.3`; Node `>=20` remains supported. Bun 1.3.14 can omit the
  named EPIPE and return the command's exit code when a reader closes fast, as in
  [CI run 39018308447](https://github.com/beorn/bearly/actions/runs/39018308447). The owning test reproduces it
  with `delaySeconds: 0` and `closeAfterBytes: 100`. Bun 1.4.3 is the first measured-good runtime, not a claim
  about which release first fixed it. Production stream handling is unchanged.

### Changed

- The existing early-close test covers fast and slow readers; the full-output test also covers a write after
  the CLI body returns. The unrouted control still records the historical drop and detects its return.

## 0.1.0

- `runCliProcess(name, main, argv?)`: run a CLI's body, set its exit code and let stdout and stderr drain; a reader
  that closes early fails the command by name (EPIPE, exit 1). Moved from gitomic's entry (gitomic 25382).
- `routeConsoleToStreams()`: send the console's output through `process.stdout` and `process.stderr`, whose writes are
  queued and drained, instead of the console's direct write, which Bun drops on a full non-blocking pipe (hh 27071).
- `@bearly/cli-process/testing`: `slowPipeRoundTrip(command, options?)` proves a command's output reaches a slow
  reader whole, with its real exit code, or that an early-closing reader makes it fail by name.
