# Changelog

All notable changes to `@bearly/tribe` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this package adheres to [Semantic Versioning](https://semver.org/).

## Unreleased

### Changed — collapse aliases + events tables (Phase 4 of km-tribe.plateau)

Dropped two vestigial SQLite tables from the tribe database, net ~60 LOC
deletion:

- **`aliases`** — removed entirely. Renames via `tribe.rename` /
  `tribe.join(name=...)` and initial-slug naming now update
  `sessions.name` in place; the old name is not preserved and mail to
  the old name is no longer routed to the renamed session. Callers that
  need to reach a renamed session must re-discover the new name via
  `tribe.members` / `tribe.health`.
- **`events`** — collapsed into `messages`. Event rows (`session.joined`,
  `session.renamed`, `session.reload`, `bead.claimed`, etc.) now live
  in `messages` with `type = 'event.<orig-type>'`, `sender` = session
  name, `recipient = 'log'` (a sentinel — never delivered to any
  session), and `content` = JSON-encoded data. Queryable via
  `SELECT * FROM messages WHERE type LIKE 'event.%'`.

Migration is automatic on daemon start: existing `events` rows are
copied into `messages`, both legacy tables are dropped with
`DROP TABLE`, and their prepared statements / indexes are gone. Fresh
installs skip the migration cleanly.

Callers updated:

- `retro` — reads events from `messages WHERE type LIKE 'event.%'` and
  strips the `event.` prefix before dispatching formatters; regular
  message counts and timelines filter out `event.*` rows.
- `messageHistory` prepared statement now excludes `event.*` rows so
  the user-facing history view stays clean.
- `tribe.health` stats block counts event rows via the same
  type-prefix filter.
- `/tribe events` skill command updated to the new query form.

The `event_log` table is untouched — that's the separate
per-session activity log consumed by the health monitor, not the
coordination event stream.

### Changed — chief is now derived from connection order

Replaced the lease-based chief election (timed DB lease, heartbeat renewal,
auto-promotion timer) with a derived model: the longest-connected eligible
client is the chief, ties broken by name alphabetical. When the current
chief disconnects, the next-longest-connected client automatically takes
over — no grace window, no headless state, no "tribe has no chief"
warnings.

Two new MCP tools let a session override the derivation when needed:

- `tribe.claim-chief` — pin the role to this session (idempotent). Useful
  when a human deliberately takes coordination responsibility.
- `tribe.release-chief` — release the claim, falling back to derivation.
  The claim is also cleared automatically when the claimer disconnects.

`tribe.leadership` now returns `{ holder_name, holder_id, claimed, source }`
where `source` is `"explicit-claim"` or `"derived-from-connection-order"`.

Deleted: `tools/lib/tribe/lease.ts`, `tools/lib/tribe/chief-promotion.ts`,
the `leadership` DB table + `epoch` migration, the chief-expired alert
block in the health monitor, `getLeaseInfo` in `PluginContext`, and the
daemon's chief-auto-promotion setInterval + boot setTimeout (~300 LOC net
deletion). Phase 1 of `km-tribe.plateau`.

Note: live deployments will still have a vestigial `leadership` table in
their SQLite — the daemon no longer reads or writes it, and `openDatabase`
no longer tries to create it. The stale table is harmless.

### Added — chief auto-promotion (Layer 2)

Closes the tribe's self-healing gap. When the chief lease has been expired
past the 5 min grace window and an eligible member is alive, the daemon
now promotes the longest-running active member on their behalf — acquires
the lease and broadcasts a `chief:auto-promoted` event to `*`.

Composes with the earlier layers:

- Layer 1 (observability): `health:chief:expired` alert fires once grace
  window closes — before promotion.
- Layer 2 (self-heal, this release): daemon picks the longest-running
  candidate, calls `acquireLease` for them, broadcasts promotion.
- Layer 3 (dead-letter): `tribe.send` to `"chief"` routes to `*` with a
  `[no-chief]` prefix while no live lease holds.

Implementation in `tools/lib/tribe/chief-promotion.ts` as a pure decision
function (`pickPromotionCandidate`) + side-effect wrapper (`tryAutoPromote`).
Tie-breaking: longest-running by `started_at`, then alphabetical name for
reproducibility. `watch-*` and `pending-*` sessions are excluded. Race
condition (another caller grabs the lease between pick and commit) is
detected via `acquireLease`'s `granted: false` and returns a no-op
decision.

Daemon runs the check every 60 seconds plus a one-shot boot check at
10 seconds so a freshly-restarted daemon doesn't wait a full minute
before healing.

12 tests (9 pure decision + 3 integration). Closes
`km-tribe.chief-auto-election`.

### Added — chief lease observability (Layer 1)

Health monitor plugin emits a `health:chief:expired` broadcast when the chief
lease is expired by more than the grace window (5 min) and no session has
acquired it. Rate-limited to once per hour per daemon so headless periods
don't flood the channel. Covers the first of three layers in
`km-tribe.chief-auto-election`. Layer 2 (auto-promotion) and the sweep-level
work remain open.

### Added — dead-letter routing for `to: "chief"` (Layer 3)

`tribe.send` with `to: "chief"` now falls back to `to: "*"` with a
`[no-chief]` prefix when no session holds a live chief lease. Previously
these messages accumulated in the `chief` recipient's queue with no reader
and grew unbounded (23 orphans found 2026-04-15). Logged events include
`routedFromChief: true` so retros can distinguish normal broadcasts from
dead-letters.

### Changed — tribe DB default location (km-tribe.decouple-db-location)

`tribe.db` now defaults to `~/.local/share/tribe/tribe.db` — matching the
socket path already at `~/.local/share/tribe/tribe.sock`. The legacy
`.beads/tribe.db` is still honored, but only as a one-time migration source:
on first startup after upgrade, if the XDG DB doesn't yet exist and a
legacy `.beads/tribe.db` does, it's moved forward (including `-wal` /
`-shm` sidecars) and a `.moved` breadcrumb is dropped in the old directory.
This unblocks retiring `.beads/` in repos that no longer use bd for issue
tracking.

Priority order: `--db flag > TRIBE_DB env > XDG path > legacy migration`.

### Changed — git lock messages include session name AND PID

`formatLockMessage` and `formatStaleLockMessage` now emit
`held by <session> (PID <pid>)` when both are known. Session name is what a
human remembers; PID is the handle for `kill`/`ps`. Fallbacks unchanged:
`PID <pid>` when no attribution, `unknown` when no holder info either.
Closes `km-tribe.git-lock-attribution`.

### Fixed — broadcast self-echo regression tests

`km-tribe.broadcast-loopback` was investigated; the daemon's
`pushNewMessages` query has filtered senders (`AND sender != ?`) since the
original daemon landed. Added two verbatim-query regression tests so the
filter can't be removed accidentally.

### Fixed — autostart now covers the tribe coordination daemon

Before this release, the Claude Code `SessionStart` hook autostart path
(`ensureDaemonIfConfigured`) resolved only the lore socket. The tribe
coordination daemon had no autostart wiring — combined with its 30-second
idle auto-quit, any quiet window killed it until a human manually ran
`tribe start`. Sessions lost inter-session messaging silently.

- `ensureTribeDaemonIfConfigured()` — new sibling of
  `ensureDaemonIfConfigured` that targets the tribe socket and spawns
  `tools/tribe-daemon.ts`.
- `ensureAllDaemonsIfConfigured()` — parallel orchestrator that probes
  and spawns both daemons under a single 300 ms budget.
- Hook dispatch (`hook-dispatch.ts`) now calls the all-daemon path so
  every `SessionStart` brings up both lore and tribe without user
  intervention.
- `spawnTribeDaemonDetached()` — symmetric spawner to
  `spawnDaemonDetached`. Accepts the same options; logs `[tribe] spawned
tribe daemon (pid=N)` so the log stream distinguishes the two daemons.

Existing `ensureDaemonIfConfigured()` signature is unchanged —
`lore/server.ts` still uses it lore-only. All existing tests pass
unmodified; five new tests cover the tribe and all-daemon paths.

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
