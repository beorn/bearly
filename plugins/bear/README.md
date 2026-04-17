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

Phase 1 of the bear workspace-daemon plan (bead `km-bear`). Standalone stdio MCP
server with no persistent daemon yet. Each invocation is a short-lived subprocess
like `bun recall`, but accessed as MCP tools instead of shell commands. Daemon
support arrives in Phase 2 (`km-bear.daemon`).

## Fallthrough

If the underlying recall library can't reach an LLM provider (no API keys), tools
return the same graceful-fallback response the CLI produces. Never throws.
