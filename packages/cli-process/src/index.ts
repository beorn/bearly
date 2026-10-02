/**
 * A CLI entry that never loses its own output.
 *
 * Two things lose a CLI's output when it writes to a pipe:
 *
 * - **Exiting by hand.** A write to a pipe is asynchronous past the kernel's buffer. `process.exit()` while that write
 *   is pending discards the rest and still reports success (gitomic 25382). {@link runCliProcess} sets
 *   `process.exitCode` and returns, so the event loop drains stdout and stderr first.
 * - **`console.log` on a non-blocking pipe.** Under Bun, once anything uses the `process.stdout` stream, stdout's pipe
 *   is non-blocking for the whole process. `console.log` writes the file descriptor directly, and when the pipe fills
 *   it drops the rest of its text (hh 27071: `tent fleet-sweep --json` delivered 65,536 of 314,509 bytes). The stream
 *   queues instead. {@link routeConsoleToStreams} sends the console's output through the streams.
 *
 * Call both once, at the CLI's entry, and nowhere else.
 */
import { format } from "node:util"

/** A CLI's body: takes its arguments, answers its exit code. */
export type CliMain = (argv: string[]) => number | Promise<number>

/**
 * Run `main` as the process's CLI. A stdout that refuses the output (the reader closed early: EPIPE) fails the command
 * by name, with its arguments, and exit 1, never a truncated success. The exit code is `main`'s, unless a stream
 * already failed. It never calls `process.exit`.
 */
export async function runCliProcess(
  name: string,
  main: CliMain,
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    process.stderr.write(
      `${name}: stdout refused the output of \`${[name, ...argv].join(" ")}\`: ${error.code ?? error.message}\n`,
    )
    process.exitCode = 1
  })
  const code = await main(argv)
  if (!process.exitCode) process.exitCode = code
}

/**
 * Send `console.log` and `console.info` through `process.stdout.write`, and `console.error` and `console.warn` through
 * `process.stderr.write`, formatted as the console formats them. A stream write is queued and drained before a natural
 * exit; the console's own write to a non-blocking pipe is not.
 */
export function routeConsoleToStreams(): void {
  const out = (...args: unknown[]): void => {
    process.stdout.write(`${format(...args)}\n`)
  }
  const err = (...args: unknown[]): void => {
    process.stderr.write(`${format(...args)}\n`)
  }
  console.log = out
  console.info = out
  console.error = err
  console.warn = err
}
