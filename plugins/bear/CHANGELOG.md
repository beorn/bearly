# Changelog

## 0.1.0 (2026-04-17)

Initial release — Phase 1 of the bear workspace-daemon plan (bead `km-bear`).

### Added

- `bear.ask` MCP tool — wraps `recallAgent()`, exposes 2-round planner +
  fanout + synthesis as a structured Claude Code tool.
- `bear.current_brief` MCP tool — wraps `getCurrentSessionContext()`.
- `bear.plan_only` MCP tool — round-1 planner only, no fanout/synth.
  Returns plan + variants for fast speculative context (~3s).

### Architecture

- Standalone stdio MCP server with no persistent daemon yet (daemon
  arrives in Phase 2, bead `km-bear.daemon`).
- Each MCP call is a short-lived subprocess like `bun recall`, but
  accessed via MCP protocol instead of shell — eliminates ~400ms
  subprocess-spawn cost when Claude Code calls it from inside a turn.
- Follows `@bearly/tribe`'s `tribe-proxy.ts` house style: `Server` API,
  raw JSON schema, `CallToolRequestSchema` handler, stdio transport,
  error-to-content struct, uncaught-exception guards.

### Notes

- `private: true` at this version — published after the full bear plan
  (Phases 1–6) has been stable for ≥2 weeks.
- Falls through cleanly when no LLM provider is available (same graceful
  fallback as `bun recall --agent`).
