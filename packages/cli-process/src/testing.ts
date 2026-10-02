/**
 * Prove a CLI's output reaches a slow reader whole (hh 27071). The command writes into a pipe whose reader waits
 * before it reads, so anything past the kernel's 64 KiB pipe buffer is still pending when the command finishes, which
 * is exactly where an early exit or a dropped non-blocking write loses bytes. The reader is bash and `cat`, so the
 * result does not depend on the test runner's own stream handling.
 */
import { execFile } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface SlowPipeOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  /** How long the reader waits before it reads. Default 1 second. */
  readonly delaySeconds?: number
  /** Read only this many bytes, then close the pipe: the command meets EPIPE. Default: read everything. */
  readonly closeAfterBytes?: number
}

export interface SlowPipeResult {
  /** Bytes the reader received. */
  readonly bytes: number
  /** What the reader received (empty when the reader closed early). */
  readonly stdout: Buffer
  /** The command's own exit code, from the pipeline's first stage. */
  readonly exitCode: number
  /** The command's stderr. */
  readonly stderr: string
}

/** Run `command` (argv, no shell parsing) into a slow pipe, and answer what the reader received and how it exited. */
export async function slowPipeRoundTrip(
  command: readonly string[],
  options: SlowPipeOptions = {},
): Promise<SlowPipeResult> {
  if (command.length === 0) throw new Error("slowPipeRoundTrip: an empty command")
  const dir = mkdtempSync(join(tmpdir(), "cli-process-pipe-"))
  const out = join(dir, "out")
  const err = join(dir, "err")
  const reader =
    options.closeAfterBytes === undefined ? `cat > "$OUT"` : `head -c ${String(options.closeAfterBytes)} > /dev/null`
  const script = `"$@" 2> "$ERR" | { sleep ${String(options.delaySeconds ?? 1)}; ${reader}; }; echo "\${PIPESTATUS[0]}"`
  try {
    const status = await new Promise<string>((resolve, reject) => {
      execFile(
        "bash",
        ["-c", script, "bash", ...command],
        { cwd: options.cwd, env: { ...(options.env ?? process.env), OUT: out, ERR: err }, encoding: "utf8" },
        (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
      )
    })
    const stdout = options.closeAfterBytes === undefined ? readFileSync(out) : Buffer.alloc(0)
    return {
      bytes: options.closeAfterBytes === undefined ? statSync(out).size : 0,
      stdout,
      exitCode: Number(status.trim()),
      stderr: readFileSync(err, "utf8"),
    }
  } finally {
    // raw-delete-allow: this helper's own mkdtemp directory
    rmSync(dir, { recursive: true, force: true })
  }
}
