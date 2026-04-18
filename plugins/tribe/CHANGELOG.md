# Changelog

All notable changes to `@bearly/tribe` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this package adheres to [Semantic Versioning](https://semver.org/).

## 0.11.1 — 2026-04-17

### Fixed

- `tribe install` now emits a **project-relative** MCP server path when the
  server script lives under cwd (typical when bearly is a git submodule).
  Previously wrote an absolute path, making `.mcp.json` non-portable across
  machines. Absolute path is still used when the server is outside cwd
  (e.g. bearly installed via npm into `node_modules`).

## 0.11.0 — 2026-04-17

### Added — autostart config

`~/.claude/tribe/config.json` controls daemon lifecycle:
- `"autostart": "daemon"` (default) — first hook after daemon dies
  spawns a detached replacement. Daemon already auto-exits when idle
  (default 30 min via --quit-timeout). Zero ceremony.
- `"autostart": "library"` — never auto-spawn; hooks use the in-process
  library path. Same as TRIBE_NO_DAEMON=1 but persistent.
- `"autostart": "never"` — hooks always go through library, even if a
  daemon is already running.

`tribe install --autostart <mode>` writes the config.
`tribe doctor` reports current mode + daemon liveness.
Env `TRIBE_NO_DAEMON=1` still overrides to library.

## 0.10.0 — 2026-04-17

### Removed — all 0.9.0 compat aliases purged (BREAKING)

The one-release deprecation window announced in 0.9.0 closes here. Every
legacy name that mapped to a `tribe.*` canonical now returns an error.

**MCP tools** (removed from both `tools/list` emission and dispatch):

- `lore.ask`, `lore.current_brief`, `lore.plan_only`, `lore.session_state`,
  `lore.workspace_state`, `lore.inject_delta`
- `tribe_send`, `tribe_broadcast`, `tribe_sessions`, `tribe_history`,
  `tribe_rename`, `tribe_health`, `tribe_join`, `tribe_reload`,
  `tribe_retro`, `tribe_leadership`

**Env vars** (direct `process.env.TRIBE_*` lookup only — no fallback):

- `LORE_NO_DAEMON`, `LORE_LOG`, `LORE_SOCKET`, `LORE_DB`,
  `LORE_SUMMARIZER_MODEL`, `LORE_FOCUS_POLL_MS`, `LORE_SUMMARY_POLL_MS`

**Daemon wire protocol** (legacy method aliases removed, daemons reject them):

- Lore daemon: `lore.hello`, `lore.ask`, `lore.current_brief`,
  `lore.plan_only`, `lore.session_register`, `lore.session_heartbeat`,
  `lore.sessions_list`, `lore.workspace_state`, `lore.session_state`,
  `lore.inject_delta`, `lore.status`
- Tribe coord daemon: `tribe_send`, `tribe_broadcast`, `tribe_sessions`,
  `tribe_history`, `tribe_rename`, `tribe_health`, `tribe_join`,
  `tribe_reload`, `tribe_retro`, `tribe_leadership`

**Recall CLI subcommands** (use `tribe hook <event>` instead):

- `recall hook`, `recall session-start`, `recall session-end`

**Modules** (deleted):

- `plugins/tribe/lib/deprecation.ts` (MCP tool rename shim)
- `plugins/tribe/lore/lib/env.ts` (LORE*\* → TRIBE*\* resolver)
- Exports `LORE_METHODS`, `LEGACY_METHOD_ALIASES`, `TRIBE_LEGACY_METHOD_ALIASES`
- Tests `deprecation.test.ts`, `env.test.ts`, `protocol-aliases.test.ts`

### Protocol

- Lore daemon protocol version bumped **3 → 4**. Daemons shipped in 0.10+
  will reject handshakes from pre-0.10 clients that claim `protocolVersion: 3`.
  Restart all in-flight sessions after upgrading.

### Migration

If you see a "method not found" or "unknown tool" error after upgrading,
you (or a script/skill) are still using the pre-0.9 name. Consult the 0.9.0
rename table below and update to the canonical `tribe.*` form.

Per [docs/lessons/refactoring.md](../../docs/lessons/refactoring.md):
deprecated is not done. The aliases existed exactly long enough to let users
migrate; they're gone now.

## 0.9.0 — 2026-04-17

### Changed — MCP namespace unification under `tribe.*`

Every MCP tool now lives under the single `tribe.*` namespace. The previous
`lore.*` and `tribe_*` names are retained as deprecated aliases for one
release cycle and **will be removed in 0.10**.

| Old name               | New name             |
| ---------------------- | -------------------- |
| `lore.ask`             | `tribe.ask`          |
| `lore.current_brief`   | `tribe.brief`        |
| `lore.plan_only`       | `tribe.plan`         |
| `lore.session_state`   | `tribe.session`      |
| `lore.workspace_state` | `tribe.workspace`    |
| `lore.inject_delta`    | `tribe.inject_delta` |
| `tribe_send`           | `tribe.send`         |
| `tribe_broadcast`      | `tribe.broadcast`    |
| `tribe_sessions`       | `tribe.members`      |
| `tribe_history`        | `tribe.history`      |
| `tribe_rename`         | `tribe.rename`       |
| `tribe_health`         | `tribe.health`       |
| `tribe_join`           | `tribe.join`         |
| `tribe_reload`         | `tribe.reload`       |
| `tribe_retro`          | `tribe.retro`        |
| `tribe_leadership`     | `tribe.leadership`   |

### Deprecation policy

- Both the new and old name appear in the MCP `tools/list` response.
  Old-name entries are prefixed `[deprecated alias of <new-name>]` in
  their description.
- Calling a tool by its old name dispatches to the new handler and emits
  exactly one `[deprecated]` line to stderr per process per tool.
- **Old names will be removed in `@bearly/tribe` 0.10.** Migrate now.

### Migration

1. Update any scripts / skills / `.mcp.json` references that mention the
   old tool names.
2. If you registered this MCP server under the key `lore` in
   `.mcp.json`, consider renaming it to `tribe` — functionality is
   identical but the unified namespace is clearer. (This is the only
   config-file change; the old key continues to work.)
3. Agents calling tools like `tribe_send` receive a stderr warning on
   first call — no behavior change, but visible in `.claude/logs/` when
   MCP stderr is captured.

### Internal

- Bumped lore daemon protocol version from `1` to `2` to signal the new
  MCP surface. Daemon-internal RPC method strings are unchanged in this
  release (`tribe_send`, `lore.ask`, etc.) and will be renamed in a
  future phase alongside the `LORE_*` env-var cleanup.
- Added `plugins/tribe/lib/deprecation.ts` with the canonical rename
  table, `normalizeToolName()`, and `buildDeprecatedAliasTools()` helper
  — shared by the tribe-proxy and the lore MCP server.

### Changed — env var prefix `TRIBE_*`

`LORE_*` environment variables are renamed to `TRIBE_*`. Old names still
resolve but emit a single aggregated stderr deprecation line on the next
microtask after the first read. Removal target: **0.10**.

| Old                     | New                      |
| ----------------------- | ------------------------ |
| `LORE_NO_DAEMON`        | `TRIBE_NO_DAEMON`        |
| `LORE_LOG`              | `TRIBE_LOG`              |
| `LORE_SOCKET`           | `TRIBE_LORE_SOCKET`      |
| `LORE_DB`               | `TRIBE_LORE_DB`          |
| `LORE_SUMMARIZER_MODEL` | `TRIBE_SUMMARIZER_MODEL` |
| `LORE_FOCUS_POLL_MS`    | `TRIBE_FOCUS_POLL_MS`    |
| `LORE_SUMMARY_POLL_MS`  | `TRIBE_SUMMARY_POLL_MS`  |

`TRIBE_LORE_SOCKET` / `TRIBE_LORE_DB` (not `TRIBE_SOCKET` / `TRIBE_DB`)
because the plain forms are already used by the tribe **coordination**
daemon (different socket and DB from the lore workspace daemon).

`RECALL_*` env vars (in `@bearly/recall`) are unchanged.

Resolution is centralised in `plugins/tribe/lore/lib/env.ts`: callers
invoke `getEnv("TRIBE_*")`, which tries the new name first, falls back
to the legacy `LORE_*`, and schedules the one-time deprecation warning.

### Changed — daemon-internal protocol under tribe.\* (Phase 4)

Unix-socket RPC method names between tribe-cli / recall-hooks / MCP proxy
and the daemons are renamed to the unified tribe.\* namespace. Daemons
still accept the old names (silent alias, no stderr warning — wire
protocol, not user surface). Old names slated for removal in 0.10.

- Lore daemon methods:
  lore.hello → tribe.hello
  lore.ask → tribe.ask
  lore.current_brief → tribe.brief
  lore.plan_only → tribe.plan
  lore.session_register → tribe.session_register
  lore.session_heartbeat → tribe.session_heartbeat
  lore.sessions_list → tribe.sessions_list
  lore.workspace_state → tribe.workspace
  lore.session_state → tribe.session
  lore.inject_delta → tribe.inject_delta
  lore.status → tribe.status
  LORE_PROTOCOL_VERSION bumped 2 → 3.

- Tribe coordination daemon methods:
  tribe_send → tribe.send
  tribe_broadcast → tribe.broadcast
  tribe_sessions → tribe.members
  tribe_history → tribe.history
  tribe_rename → tribe.rename
  tribe_health → tribe.health
  tribe_join → tribe.join
  tribe_reload → tribe.reload
  tribe_retro → tribe.retro
  tribe_leadership → tribe.leadership

LORE_METHODS re-exports to the new values with a @deprecated tag.

## 0.8.1

Previous release baseline (no changelog recorded).
