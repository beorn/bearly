#!/usr/bin/env bun
/**
 * Thin shim — forwards to the @bearly/llm CLI.
 *
 * Kept at tools/llm.ts so that existing references to `bun vendor/bearly/tools/llm.ts`
 * continue to work after the llm library was extracted into plugins/llm/.
 */

import { main } from "../plugins/llm/src/cli.ts"

try {
  await main()
} catch (e) {
  console.error(`[llm] FATAL: ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}`)
  process.exit(1)
}
