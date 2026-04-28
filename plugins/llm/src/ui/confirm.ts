/**
 * Sole owner of `process.stdin.setRawMode` — TTY raw-mode prompts.
 *
 * Two prompts live here:
 *   - confirmOrExit: Y/n with hardened control-byte handling
 *   - promptChoice: single-keystroke from an allowed letter set
 *
 * Concentrating raw-mode usage in one module makes the audit trivial
 * (`grep -rln 'setRawMode' src/` should return only this file).
 */

/** Prompt user for Y/n confirmation; exit if declined.
 *
 * Non-TTY safety: if stdin isn't a TTY (CI, Docker, Claude Code background
 * tasks), stdin.once('data') never resolves because the pipe is closed at
 * EOF — the process would hang forever waiting for input that can't arrive.
 * We detect that up front and refuse to proceed unless the caller passed -y.
 * A 5-minute timeout guards the interactive path too, in case raw mode gets
 * wedged for any other reason.
 *
 * **Raw-mode Ctrl-C handling**: setRawMode(true) suppresses SIGINT, so
 * Ctrl-C arrives as the data byte `` (and Ctrl-D as ``, ESC
 * as ``). Previous implementations only tested for "n"/"no" and fell
 * through to "proceed" on these — a catastrophic footgun on $5-15
 * commands. We now explicitly treat those control bytes as cancel and
 * exit 130 (standard SIGINT exit code). Flagged as blocker in the Pro
 * round-2 review, 2026-04-21.
 */
export async function confirmOrExit(message: string, skipConfirm: boolean): Promise<void> {
  if (skipConfirm) return
  if (!process.stdin.isTTY) {
    console.error("Non-interactive environment — pass -y / --yes to skip confirmation.")
    process.exit(1)
  }
  console.error(message)
  const raw = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        process.stdin.setRawMode?.(false)
        reject(new Error("confirmation timed out after 5 minutes"))
      },
      5 * 60 * 1000,
    )
    process.stdin.setRawMode?.(true)
    process.stdin.resume()
    process.stdin.once("data", (data) => {
      clearTimeout(timer)
      process.stdin.setRawMode?.(false)
      resolve(data.toString())
    })
  }).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
  // Ctrl-C / Ctrl-D / ESC in raw mode → cancel, exit 130 (SIGINT convention).
  // Raw-mode `data` events can batch multiple bytes into one Buffer (event-loop
  // coalescing or fast typing), so "y" would miss exact-string equality
  // and fall through to the proceed path. Inspect the FIRST codepoint instead
  // — any leading control byte means "cancel". Flagged by K2.6 round-3 review.
  const firstCode = raw.charCodeAt(0)
  if (firstCode === 3 || firstCode === 4 || firstCode === 27) {
    console.error("\nCancelled.")
    process.exit(130)
  }
  const answer = raw.trim().toLowerCase()
  if (answer === "n" || answer === "no") {
    console.error("Cancelled.")
    process.exit(0)
  }
  console.error()
}

/** Read a single keystroke or 'P/W/D/C\n' line from stdin in raw mode. */
export async function promptChoice(prompt: string, allowed: readonly string[]): Promise<string> {
  process.stderr.write(prompt)
  // Falls back to readline if stdin isn't TTY (e.g. piped tests).
  if (!process.stdin.isTTY) {
    const readline = await import("readline")
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: false })
    const answer: string = await new Promise((resolve) =>
      rl.question("", (a) => {
        rl.close()
        resolve(a.trim().toLowerCase())
      }),
    )
    return allowed.includes(answer[0] ?? "") ? (answer[0] as string) : "c"
  }
  // TTY raw mode — single keystroke. Mirrors confirmOrExit.
  return new Promise<string>((resolve) => {
    const stdin = process.stdin
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.setEncoding("utf8")
    const onData = (chunk: string) => {
      const ch = chunk.toLowerCase()[0] ?? ""
      stdin.setRawMode?.(false)
      stdin.pause()
      stdin.off("data", onData)
      process.stderr.write("\n")
      resolve(allowed.includes(ch) ? ch : "c")
    }
    stdin.on("data", onData)
  })
}
