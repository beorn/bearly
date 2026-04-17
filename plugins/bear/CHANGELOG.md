# Changelog

## 0.5.0 (2026-04-17)

Phase 5 of the bear workspace-daemon plan (bead `km-bear.dedup-inject`).
Hook-side recall injection moves from tmpfile-based dedup to a
daemon-held, per-session, in-memory set — eliminating tmpfile round-trips
and keeping dedup coherent across Claude Code session boundaries for as
long as the daemon is alive.

### Added

- `bear.inject_delta(prompt, sessionId?, limit?, ttlTurns?)` — new MCP
  tool and RPC method. Runs the same FTS5 recall as the pre-existing hook
  but filters results against a per-session seen set (key =
  `${sessionId}:${type}`, TTL = 10 turns by default). Returns
  `additionalContext` ready for Claude Code's
  `hookSpecificOutput.additionalContext` plus observability fields
  (`seenCount`, `turnNumber`, `newKeys`).
- Per-session inject state in daemon memory — `Map<sessionId,
{ turnNumber, seen: Map<key, lastTurn> }>`. Bounded by opportunistic
  GC when a session's seen set exceeds 500 entries.
- `UserPromptSubmit` hook (`bun recall hook`) tries the daemon first
  with a 2.5 s budget; on timeout or daemon error it falls back to the
  existing library `hookRecall` tmpfile path. The fall-back is
  explicitly labelled `mode=library` in the MCP response so callers can
  see which path served them.

### Behaviour

- No behaviour change when daemon is reachable — same dedup semantics
  (short/trivial/slash-command skips, `${sessionId}:${type}` keys,
  10-turn TTL) — just no tmpfile I/O and no 400 ms subprocess spawn per
  prompt.
- `BEAR_NO_DAEMON=1` still forces the library path; integration tests
  exercise both.
- Skipped prompts still log a reason (`empty`, `short`, `trivial`,
  `slash_command`, `no_results`, `all_seen`) and exit 0 without
  injection.

### Tests

2 new integration tests (`tests/bear/daemon.test.ts`): inject_delta
short-circuits + per-session turn counter isolation. 30/30 bear +
plugin tests green.

## 0.4.0 (2026-04-17)

Phase 4 of the bear workspace-daemon plan (bead `km-bear.summarizer`).
Opt-in LLM summarizer converts each active session's tail into a
one-sentence focus + loose-ends list. Exposed via new `bear.session_state`
MCP tool and surfaced in `bear.workspace_state` (new `focusSummary`,
`looseEnds`, `summaryModel`, `summaryUpdatedAt` fields).

### Added

- `tools/lib/bear/summarizer.ts` — pure `summarizeTail(tail, {mode})` using
  existing `getCheapModel`/`queryModel`. Haiku 4.5 by default; Ollama when
  `BEAR_SUMMARIZER_MODEL=local`. Strict-ish JSON parser strips code fences
  and tolerates prose wrapper.
- `session_focus` columns (additive try/catch ALTERs): `focus_summary`,
  `loose_ends`, `summary_updated_at`, `summary_model`, `summary_cost`.
- Daemon summarizer coroutine — runs every `BEAR_SUMMARY_POLL_MS`
  (default 120 s). Only summarizes when the focus tail has actually
  moved since the last summary AND the session is <30 min idle.
  Skipped entirely when `BEAR_SUMMARIZER_MODEL=off` (default).
- `bear.session_state(sessionId)` MCP tool + RPC — returns focus +
  summary + tail for one session. Errors on unknown sessionId.
- `bear.workspace_state` rows now include `focusSummary`, `looseEnds`,
  `summaryModel`, `summaryUpdatedAt`.
- CLI `bear sessions` prefers LLM summary over raw tail hint when
  present, and shows `loose_ends=N` count.

### Behavior

- `BEAR_SUMMARIZER_MODEL=off` (default) — no LLM calls, no cost.
- `BEAR_SUMMARIZER_MODEL=haiku` — Claude Haiku 4.5 (~\$0.00001 / summary).
- `BEAR_SUMMARIZER_MODEL=local` — Ollama when available.

### Tests

7 new summarizer unit tests (`tests/bear/summarizer.test.ts`): JSON
parser (strict, fenced, prose-wrapped, malformed) and mode resolution.

## 0.3.0 (2026-04-17)

Phase 3 of the bear workspace-daemon plan (bead `km-bear.focus`). Daemon now
maintains a per-session focus cache, refreshed every 60 s by a background
poller. `bear.current_brief` reads from the cache when fresh.

### Added

- **Focus poller** — daemon spawns a `setInterval(--focus-poll-ms, default 60 s)`
  loop that parses the JSONL tail of every alive session and upserts
  `session_focus` (last-activity ts, exchange count, mentioned
  paths/beads/tokens, flattened tail).
- **`bear.workspace_state` MCP tool** — cross-session snapshot; each entry
  combines session metadata with cached focus. Used by `bear sessions` /
  `bear workspace` CLI commands.
- **`bear.current_brief` cache fast-path** — when the caller supplies a
  sessionId and the cache entry is <2 min old, served from cache.
  Otherwise falls through to the live `getCurrentSessionContext` parse.
- **`bear sessions` shows focus hints** inline; new `bear workspace`
  dumps the full `WorkspaceStateResult` as JSON.
- **`extractSessionFocus`** — new pure export in
  `tools/recall/session-context.ts`: takes a JSONL path directly (no
  detection, no env lookup), used by the daemon poller and fully
  unit-testable.

### Schema

- New `session_focus` table keyed by `claude_pid` (stores arrays as JSON
  strings). Additive migration (`CREATE TABLE IF NOT EXISTS`).

### CLI

- `bun vendor/bearly/tools/bear.ts sessions` now shows `focus="<hint>"`
  for each alive session.
- New `bun vendor/bearly/tools/bear.ts workspace` dumps raw
  workspace state as JSON.
- `bear-daemon --focus-poll-ms <ms>` and `BEAR_FOCUS_POLL_MS` env var
  expose the poll interval (tests use 200 ms, default 60 s).

### Tests

5 new integration + unit tests (`tests/bear/focus.test.ts`): pure
extraction, cache population via the poller, cache persistence after the
transcript is removed, and the current-brief fast-path.

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
