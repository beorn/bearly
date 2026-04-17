# @bearly/bear

MCP server for Claude Code that exposes the bearly recall library as structured tools:
`bear.ask`, `bear.current_brief`, `bear.plan_only`. Eliminates the subprocess-spawn
cost (~400ms) of shelling out to `bun recall` from inside a Claude Code turn.

## Tools

### `bear.ask`

LLM-driven recall over session history. Wraps `recallAgent()` from the bearly recall
library.

Input:

- `query` (string, required) — the natural-language query
- `limit` (number, default 5) — max results
- `since` (string, optional) — time filter (e.g., "1d", "1w", "30d")
- `projectFilter` (string, optional) — project-path glob
- `round2` ("auto" | "wider" | "deeper" | "off", default "auto") — round-2 mode
- `maxRounds` (1 | 2, default 2)
- `speculativeSynth` (boolean, default true) — parallel synthesis during round 2
- `rawTrace` (boolean, default false) — include full agent trace in the response

Output: JSON with `answer` (synthesized), `results` (top matches), `trace` (optional).

### `bear.current_brief`

Compact summary of the current Claude Code session: detected session id, paths
and bead IDs mentioned in the tail, distinctive technical tokens, and the recent
conversation tail. Wraps `getCurrentSessionContext()`.

Input:

- `sessionId` (string, optional) — override session detection; omit to use the
  caller's inferred session.

Output: JSON with `sessionId`, `ageMs`, `exchangeCount`, `mentionedPaths`,
`mentionedBeads`, `mentionedTokens`, `recentMessages` (truncated tail), or `null`
if no active session is detectable.

### `bear.plan_only`

Runs only the round-1 planner and returns the variant plan without executing the
fanout or synthesis. Useful for fast speculative context before deciding whether
to escalate to a full `bear.ask` call. Wraps `planQuery({ round: 1 })`.

Input:

- `query` (string, required)
- `limit` (number, default 10) — max results to consider for context (not fanout)

Output: JSON with the `QueryPlan` (keywords, phrases, concepts, paths, errors,
bead_ids, time_hint, notes), the flattened variants array, the planner model id,
and elapsed time.

## Install

Registered in `.mcp.json` as:

```json
{
  "mcpServers": {
    "bear": {
      "command": "bun",
      "args": ["vendor/bearly/plugins/bear/server.ts"]
    }
  }
}
```

## Status

Phases 1–2 of the bear workspace-daemon plan (bead `km-bear`). The MCP server
is now a thin reconnecting client to a persistent `bear-daemon` process
(`bun vendor/bearly/tools/bear-daemon.ts`) at `$XDG_RUNTIME_DIR/bear.sock`.
The daemon keeps the recall library warm across calls, eliminating both the
subprocess-spawn cost and the per-call context-rebuild cost.

The daemon auto-starts on first MCP call, writes its PID to `bear.pid`, and
idle-quits after 30 minutes of no clients.

## Env vars

- `BEAR_NO_DAEMON=1` — opt-out; use library directly (Phase 1 behaviour).
- `BEAR_LOG=1` — enable stderr tracing for connect failures and recall library
  logs.
- `BEAR_SOCKET` — override socket path (default `$XDG_RUNTIME_DIR/bear.sock`).
- `BEAR_DB` — override DB path (default `~/.local/share/bear/bear.db`).

## CLI

`bun vendor/bearly/tools/bear.ts`:

- `status` — show daemon status (auto-starts if needed)
- `sessions` — list registered Claude Code sessions
- `ask "query"` — run `bear.ask` via the daemon
- `ping` — cheap liveness check, exits 1 if offline
- `stop` — SIGTERM the running daemon

## Fallthrough

Every tool falls through to an in-process library call if the daemon is
unreachable. Responses include `"mode": "daemon" | "library"` so callers can
observe which path served them. If the underlying recall library can't reach
an LLM provider (no API keys), tools return the same graceful-fallback
response the CLI produces. Never throws.
