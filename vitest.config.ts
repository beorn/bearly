/**
 * Vitest config for the bearly monorepo.
 *
 * Local to vendor/bearly so the package is self-contained when cloned standalone.
 * Picks up tests from `tests/` (tribe, accountly, etc.) and `plugins/<pkg>/tests/`
 * (e.g. `plugins/llm/tests/` — regression suite for the K2.6 + GPT-5.4 Pro fixes).
 *
 * Run: `bunx vitest run plugins/llm/tests/`
 */

import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    include: [
      "tests/**/*.test.ts",
      "plugins/**/tests/**/*.test.ts",
      "plugins/**/src/**/*.test.ts",
      "tools/**/*.test.ts",
    ],
    // .slow. tests hit real services (tribe sockets, accountly credentials) — opt-in only.
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.slow.*"],
    // Per-package setup files are loaded by file-pattern: plugins/llm/tests/setup.ts
    // polyfills Bun APIs for the @bearly/llm regression suite. Other subtrees
    // don't currently need one; add as each package needs it.
    setupFiles: ["plugins/llm/tests/setup.ts"],
    // vitest runs on node; @bearly/llm transitively imports `bun:sqlite` via
    // @bearly/recall. Alias it to a no-op shim so unit tests that never touch
    // history search still import cleanly. Tests that need real recall behavior
    // would have to run under bun (currently none do).
    alias: {
      "bun:sqlite": resolve(here, "plugins/llm/tests/stubs/bun-sqlite.ts"),
    },
  },
})
