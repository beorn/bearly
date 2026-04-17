# Changelog

## 0.2.0 (2026-04-17)

Phase 2 of the bear workspace-daemon plan (bead `km-bear.daemon`). The MCP
server now bridges Claude Code to a persistent `bear-daemon` via a Unix
socket, keeping the recall library warm across calls.

### Added

- **bear-daemon** — long-lived process at `$XDG_RUNTIME_DIR/bear.sock` with
  SQLite WAL at `~/.local/share/bear/bear.db`. 30 min idle timeout. Fresh
  spawn on first connection via `connectOrStart` (modeled on
  `@bearly/tribe` daemon lifecycle). Handles `bear.ask`, `bear.current_brief`,
  `bear.plan_only`, plus session registry (`bear.session_register`,
  `bear.session_heartbeat`, `bear.sessions_list`), `bear.hello`, `bear.status`.
- **`bear` CLI** — `bun bear.ts status|sessions|ask|ping|stop`. Auto-starts
  the daemon when needed.
- **SessionStart hook integration** — `bun recall session-start` now
  registers the session with the daemon (best-effort) in addition to
  writing the sentinel file. Sentinel stays as fallback.
- **Reconnecting client** — MCP proxy uses `createReconnectingClient` with
  exponential-backoff reconnect. If the daemon dies mid-call, subsequent
  calls reconnect transparently.

### Behaviour

- **Library fallback** — if the daemon is unreachable, MCP handlers fall
  through to in-process recall library calls (preserves Phase 1 behaviour).
  Emit `"mode": "daemon"` or `"mode": "library"` in responses so callers
  can see which path served them.
- **`BEAR_NO_DAEMON=1`** — opt-out for debugging / deterministic tests.
- **`BEAR_LOG=1`** — enable recall library + connect-failure stderr output.

### Architecture

- Wire protocol: JSON-RPC 2.0 newline-delimited (matches `@bearly/tribe`).
  Phase 7 may unify both daemons onto one socket without client changes.
- Bear database (`~/.local/share/bear/bear.db`) is separate from tribe's
  database — merged only once both are stable (Phase 7).
- No pub/sub yet — Phases 3–5 add focus detection, background summarizer,
  and dedup-inject.

### Notes

- Still `private: true` at this version — published after the full bear plan
  (Phases 1–6) has been stable for ≥2 weeks.

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
