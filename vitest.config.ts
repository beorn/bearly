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
export default defineConfig({
  test: {
    include: [
      "tests/**/*.test.ts",
      "plugins/**/tests/**/*.test.ts",
      "plugins/**/src/**/*.test.ts",
      "packages/**/tests/**/*.test.ts",
      "tools/**/*.test.ts",
    ],
    // .slow. tests hit real services (tribe sockets, accountly credentials) — opt-in only.
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.slow.*"],
    // Per-package setup files are loaded by file-pattern: plugins/llm/tests/setup.ts
    // polyfills Bun APIs for the @bearly/llm regression suite. Other subtrees
    // don't currently need one; add as each package needs it.
    // tmpdir-redirect keeps fixtures/sockets out of the shared macOS tmpdir,
    // whose degraded readdir wedges spawned bun subprocesses (see file header).
    setupFiles: ["tests/setup/tmpdir-redirect.ts", "plugins/llm/tests/setup.ts"],
    server: { deps: { inline: ["zod"] } },
  },
})
