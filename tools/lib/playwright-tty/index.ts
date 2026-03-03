/**
 * TTY tools - Terminal testing with termless (PTY + xterm.js backend)
 *
 * @example
 * ```typescript
 * import { createTerminal } from "termless"
 * import { createXtermBackend } from "termless-xtermjs"
 *
 * const term = createTerminal({
 *   backend: createXtermBackend({ cols: 120, rows: 40 }),
 *   cols: 120, rows: 40,
 * })
 * await term.spawn(["bun", "km", "view", "/path"])
 * await term.waitFor("BOARD")
 * term.press("j")
 * console.log(term.getText())
 * await term.close()
 * ```
 */

export * from "./types.js"
