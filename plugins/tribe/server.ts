#!/usr/bin/env bun
/**
 * Tribe plugin server — thin wrapper.
 *
 * The MCP server runtime lives in `@bearly/tribe-client/stdio`. This file
 * is the plugin's invocation point: it imports and executes the stdio
 * adapter, which runs as a module-level bootstrap (no exported entry
 * function — the import has the side-effect).
 *
 * Why this exists: Claude Code's `.mcp.json` `command` runs a single
 * script. Pointing it at `node_modules/@bearly/tribe-client/.../stdio-adapter.mjs`
 * is brittle (resolution depends on dist layout); pointing it at this
 * file gives us a stable entry path that survives package layout changes.
 */

import "@bearly/tribe-client/stdio"
