/**
 * Test-suite setup: polyfill Bun APIs that the @bearly/llm source depends on.
 *
 * vitest 4 runs on node, not bun, so `Bun.write` / `Bun.file` aren't defined.
 * The CLI doesn't care which runtime backs them — it just writes text to a path
 * and reads a file — so we substitute node's fs with a matching surface. Only
 * what the code under test actually calls is polyfilled; if a future caller
 * reaches for `Bun.spawn` (say) the missing-method TypeError will fire loudly.
 *
 * This is a testing shim, not a replacement — @bearly/llm still runs on bun in
 * production. The shim exists so unit tests don't need the bun runtime.
 */

import { promises as fsPromises, readFileSync } from "node:fs"

const globalAny = globalThis as unknown as { Bun?: Record<string, unknown> }

if (typeof globalAny.Bun === "undefined") {
  globalAny.Bun = {
    write: async (path: string, content: string | Uint8Array) => {
      await fsPromises.writeFile(path, content)
    },
    file: (path: string) => ({
      text: async () => readFileSync(path, "utf-8"),
      exists: async () => {
        try {
          await fsPromises.access(path)
          return true
        } catch {
          return false
        }
      },
    }),
  }
}
