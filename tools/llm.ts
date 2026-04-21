#!/usr/bin/env bun
/**
 * Thin shim — forwards to the @bearly/llm CLI.
 *
 * Kept at tools/llm.ts so that existing references to `bun vendor/bearly/tools/llm.ts`
 * continue to work after the llm library was extracted into plugins/llm/.
 */

import { main } from "../plugins/llm/src/cli.ts"
import { maybeAutoUpdatePricing } from "../plugins/llm/src/lib/dispatch.ts"

try {
  const resolvedCommand = await main()
  // main() returns the canonical command (e.g. "pro", "--deep", "list-models")
  // so the skip-list check inside maybeAutoUpdatePricing works regardless of
  // argv ordering. Fallback to argv[2] for safety if main didn't produce one.
  await maybeAutoUpdatePricing(resolvedCommand ?? process.argv[2])
} catch (e) {
  console.error(`[llm] FATAL: ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}`)
  process.exit(1)
}
