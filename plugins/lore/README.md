# @bearly/lore

MCP server for Claude Code that exposes the bearly recall library as structured tools:
`lore.ask`, `lore.current_brief`, `lore.plan_only`, `lore.session_state`,
`lore.workspace_state`, `lore.inject_delta`. Eliminates the subprocess-spawn
cost (~400ms) of shelling out to `bun recall` from inside a Claude Code turn.

## Tools

### `lore.ask`

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

### `lore.current_brief`

Compact summary of the current Claude Code session: detected session id, paths
and bead IDs mentioned in the tail, distinctive technical tokens, and the recent
conversation tail. Wraps `getCurrentSessionContext()`.

Input:

- `sessionId` (string, optional) — override session detection; omit to use the
  caller's inferred session.

Output: JSON with `sessionId`, `ageMs`, `exchangeCount`, `mentionedPaths`,
`mentionedBeads`, `mentionedTokens`, `recentMessages` (truncated tail), or `null`
if no active session is detectable.

### `lore.plan_only`

Runs only the round-1 planner and returns the variant plan without executing the
fanout or synthesis. Useful for fast speculative context before deciding whether
to escalate to a full `lore.ask` call. Wraps `planQuery({ round: 1 })`.

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
    "lore": {
      "command": "bun",
      "args": ["vendor/bearly/plugins/lore/server.ts"]
    }
  }
}
```

## Status

Phases 1–5 of the lore workspace-daemon plan (bead `km-bear`). The MCP server
is now a thin reconnecting client to a persistent `lore-daemon` process
(`bun vendor/bearly/tools/lore-daemon.ts`) at `$XDG_RUNTIME_DIR/lore.sock`.
The daemon keeps the recall library warm across calls, eliminating both the
subprocess-spawn cost and the per-call context-rebuild cost.

The daemon auto-starts on first MCP call, writes its PID to `lore.pid`, and
idle-quits after 30 minutes of no clients.

## Env vars

- `LORE_NO_DAEMON=1` — opt-out; use library directly (Phase 1 behaviour).
- `LORE_LOG=1` — enable stderr tracing for connect failures and recall library
  logs.
- `LORE_SOCKET` — override socket path (default `$XDG_RUNTIME_DIR/lore.sock`).
- `LORE_DB` — override DB path (default `~/.local/share/lore/lore.db`).

## CLI

`bun vendor/bearly/tools/bear.ts`:

- `status` — show daemon status (auto-starts if needed)
- `sessions` — list registered Claude Code sessions with focus hints
- `workspace` — dump full workspace state (sessions + focus cache) as JSON
- `ask "query"` — run `lore.ask` via the daemon
- `ping` — cheap liveness check, exits 1 if offline
- `stop` — SIGTERM the running daemon

## Focus cache (Phase 3)

The daemon maintains a `session_focus` row per alive Claude Code session,
refreshed every 60 s from the session's JSONL transcript tail. Exposed via
the `lore.workspace_state` MCP tool and the `lore sessions` / `lore workspace`
CLI commands.

`lore.current_brief` serves from the cache when the caller passes a
sessionId and the entry is <2 min old; otherwise it falls through to the
live tail parse (Phase 2 behaviour).

Control the poll interval with `--focus-poll-ms <ms>` or `LORE_FOCUS_POLL_MS`
(default 60 000). Tests use 200 ms.

## Hook dedup (Phase 5)

`lore.inject_delta(prompt, sessionId?, limit?, ttlTurns?)` replaces the
tmpfile-backed dedup that `bun recall hook` used pre-Phase-5. The daemon
holds a per-session `Map<key, lastTurn>` in memory so repeated FTS results
aren't re-injected for `ttlTurns` turns (default 10). The hook falls back to
the library `hookRecall` path (tmpfile dedup) when the daemon is unreachable.

## Fallthrough

Every tool falls through to an in-process library call if the daemon is
unreachable. Responses include `"mode": "daemon" | "library"` so callers can
observe which path served them. If the underlying recall library can't reach
an LLM provider (no API keys), tools return the same graceful-fallback
response the CLI produces. Never throws.
