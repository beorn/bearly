#!/usr/bin/env bun
/**
 * Thin shim — forwards all args to the @bearly/recall CLI.
 *
 * Kept at tools/recall.ts so that existing hooks (e.g.,
 * .claude/settings.json's `bun vendor/bearly/tools/recall.ts session-start`)
 * continue to work after the recall library was extracted into
 * plugins/recall/ as its own package.
 */

import { main } from "../plugins/recall/src/cli.ts"

try {
  await main()
} catch (e) {
  console.error(`[recall] FATAL: ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}`)
  process.exit(1)
}
