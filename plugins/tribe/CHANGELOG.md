# Changelog

All notable changes to `@bearly/tribe` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this package adheres to [Semantic Versioning](https://semver.org/).

## Unreleased

### Changed — typed `kind` column replaces `recipient='log'` sentinel (km-tribe.polish-sweep item 3)

`messages` now carries a typed `kind` column — one of `direct`, `broadcast`,
or `event` — in addition to the existing `recipient` column. The former
string sentinel `recipient = 'log'` (which meant "never deliver, but keep
in the journal for retro/debug") has been removed entirely. Recipients are
now always real names: a session id for direct messages or `'*'` for
broadcasts and event rows; the delivery filter consults `kind` to decide
whether a row is journal-only.

Why: a stringly-typed sentinel overloaded the recipient field with two
orthogonal meanings ("who is this for" vs "is this deliverable") and
forced delivery code to special-case a magic string. The typed column
separates the concerns cleanly.

Schema changes (`tools/lib/tribe/database.ts`):

- CREATE TABLE `messages` gains `kind TEXT NOT NULL DEFAULT 'direct'` for
  fresh installs.
- Migration v7 adds the column to existing databases (guarded with
  sqlite_master lookup so fresh installs reach the CREATE TABLE path
  unimpeded), then backfills: every `recipient='log'` row becomes
  `kind='event'` with `recipient='*'`; every remaining `recipient='*'`
  broadcast row is tagged `kind='broadcast'`.
- `insertMessage` prepared statement writes `$kind`.
- `messageHistory` filters `kind != 'event'` (replaces the legacy
  `type NOT LIKE 'event.%'` hack).

Messaging changes (`tools/lib/tribe/messaging.ts`):

- New exported type `MessageKind = "direct" | "broadcast" | "event"`.
- `sendMessage` gains an optional `kind` parameter (default `"direct"`,
  auto-upgraded to `"broadcast"` when recipient is `'*'`).
- `logEvent` sets `recipient='*'` + `kind='event'` (was `recipient='log'`).
  Journal-only semantics are preserved — the delivery filter skips
  `kind='event'` before fanning out.

Daemon changes (`tools/tribe-daemon.ts`):

- `broadcastToConnected` drops the `recipient === 'log'` special case
  and instead returns early when `info.kind === 'event'`.
- `logActivity`, `tribeClientApi.send/broadcast`, and `broadcastLog`
  forward the appropriate `kind` to `sendMessage`.

Retro (`tools/lib/tribe/retro.ts`):

- Query split switched from `type NOT LIKE 'event.%'` /
  `type LIKE 'event.%'` to `kind != 'event'` / `kind = 'event'`. Timeline
  event extraction is unchanged because `type` still carries the
  `event.<name>` prefix for formatting.

### Changed — typed `role` enum replaces name-prefix eligibility (km-tribe.polish-sweep item 2)

`TribeRole` is now the closed union `"daemon" | "chief" | "member" | "watch" | "pending"`
(previously `"chief" | "member"`). Every eligibility/attribution check that
used to inspect `name.startsWith("watch-")`, `name.startsWith("pending-")`, or
`name === "daemon"` now consults `session.role` instead.

Why: the old heuristic coupled liveness/eligibility to a stringly-typed name
convention. A typo (`"watch_"` vs `"watch-"`) silently misrouted messages,
and renaming a watch session broke its own exclusion. The `sessions.role`
column already existed on disk — we just widened it into a proper enum.

Daemon changes (`tools/tribe-daemon.ts`):

- `daemonCtx.sessionRole` is now `"daemon"` (was `"member"` with a comment).
- Placeholder sessions use `role: "pending"` (unregistered half-client).
- `broadcastToConnected`, `discover`, `checkLiveness` (pending expiry),
  and the disconnect branch all switched from `name.startsWith(...)` to
  `client.role === ...`.
- Register path rejects client-supplied `role` values of `"daemon"` or
  `"pending"` (downgraded to `"member"`) — both are daemon-internal.
- `tribeClientApi.getActiveSessions` / `getSessionNames` filter by role.
- Name recovery via `claude_session_id` ignores rows with
  `role=pending`/`role=watch`.

`chief.ts`: `isChiefEligible(c)` now reads `c.role` only. `ChiefCandidate`
gained a `role: string` field.

`tools-list.ts`: `tribe.join` tool schema exposes `role` enum
`["chief", "member", "watch"]` (`daemon` and `pending` are daemon-internal
and rejected server-side).

`tribe-watch.tsx`: registers with `role: "watch"` and filters the session
table by `role !== "watch"` instead of the name prefix.

Exports: `TribeRole`, `TribeParticipantRole`, `TRIBE_ROLES`, `isValidRole`.

Tests: new `tests/tribe-role-typing.test.ts` locks in eligibility behaviour
for every role. `tests/derive-chief.test.ts` updated to pass `role:` on
fixture sessions instead of relying on name prefixes.

### Changed — plugin boundary extracted from daemon core (km-tribe.plugin-extraction)

The five observer plugins (git, beads, github, health-monitor, accountly) now
sit behind a narrow `TribePluginApi` / `TribeClientApi` contract instead of
the wide `PluginContext` they previously received. The daemon core no longer
knows any plugin's internals — `TRIBE_NO_PLUGINS=1` boots a fully-functional
coordination server with zero plugin-aware code paths.

New surface (`tools/lib/tribe/plugin-api.ts`):

- `TribePluginApi` — `{ name, available(), start(api), instructions?() }`.
- `TribeClientApi` — `send`, `broadcast`, `claimDedup`, `hasRecentMessage`,
  plus optional roster snapshots (`getActiveSessions`, `getSessionNames`,
  `hasChief`) for alert targeting. No database, no clients map, no session
  UUID, no hot-reload trigger — only what a future out-of-process plugin
  would have access to over the socket.

Daemon changes (`tools/tribe-daemon.ts`):

- Constructs a single `tribeClientApi: TribeClientApi` and passes it to every
  plugin. The former `pluginCtx: PluginContext` object + its 10-method
  surface are gone.
- `loadPlugins` now returns `{ active, stop }` with per-plugin handles.
  `cli_status.resources` continues to surface the active plugin list.

Plugin changes:

- `gitPlugin`, `beadsPlugin`, `githubPlugin`, `healthMonitorPlugin`,
  `accountlyPlugin` are now plain `const` exports implementing
  `TribePluginApi`. Factories are gone; per-instance state lives inside
  `start()` closures (unchanged).
- `git-plugin.ts` and `beads-plugin.ts` moved out of the former
  `plugins.ts` into dedicated files.
- `plugins.ts` is deleted. `plugin-loader.ts` (new) holds `loadPlugins`.
- `beadsPlugin` no longer tries to classify existing beads as
  "claimed by me" — observer plugins don't own sessions, so the check was
  always wrong.
- `gitPlugin` no longer calls `triggerReload` — the daemon's source
  watcher (`onSourceChange`) already reloads on code changes.

Migration for callers: none — the wire protocol, tool names, and message
shapes are byte-identical. Only the internal plugin contract changed.

Tests: `tests/tribe-plugin-boundary.test.ts` covers the new contract at two
layers — `loadPlugins` unit tests + a fake-plugin → real-daemon integration
test that asserts a startup `api.broadcast` lands in `tribe.history` under
the plugin's name.

### Changed — event-driven fanout replaces 1s polling push (km-tribe.event-bus)

Message delivery is now synchronous — the daemon fans out to connected sockets
the instant `sendMessage` commits the row, via a new `ctx.onMessageInserted`
hook. The former 1-second `pushInterval` / `pushNewMessages()` / per-connection
`lastDelivered` Map are deleted; the only durable delivery cursor is now
`sessions.last_delivered_seq`, which every successful socket write updates.

Consequences:

- Delivery latency drops from ~1000ms (worst-case polling tick) to <10ms
  (one prepared-statement write + one `socket.write`). Covered by
  `tests/tribe-durability.slow.test.ts` Test G (asserts <100ms).
- Reconnect replay reads from the persisted cursor, not an in-memory Map.
  A daemon crash with a connected session no longer risks re-pushing.
  Covered by Test H (5 messages delivered live, daemon SIGKILL, reconnect
  with same identity token delivers zero duplicates).
- The 1s tick in the daemon still fires, but only to run `checkLiveness()`
  (stale `pending-*` expiry + idle auto-quit countdown). Renamed from
  `pushInterval` to `livenessInterval` to reflect its single remaining job.

### Changed — `tribe.leadership` renamed to `tribe.chief` (km-tribe.polish-sweep)

The MCP tool is now `tribe.chief`. The old name `tribe.leadership` reflected
a deleted lease concept — the daemon no longer tracks leadership, only the
current chief (derived from connection order, or explicitly claimed via
`tribe.claim-chief`). The response shape is unchanged (`holder_name`,
`holder_id`, `claimed`, `source`). No deprecation alias is shipped — there
are no external consumers yet.

### Added — `tribe.debug` MCP tool (km-tribe.polish-sweep)

Dump daemon internals for troubleshooting: connected clients (id, name,
role, pid, registeredAt), derived chief info, the current explicit chief
claim (if any), and the per-session persisted delivery cursors. Purely
additive — handler reads through the `getDebugState` accessor on
`HandlerOpts`, daemon wires it up with a live snapshot of the `clients`
Map and a `SELECT id, name, last_delivered_ts, last_delivered_seq FROM
sessions`. Coverage: `tests/tribe-self-heal.slow.test.ts` "tribe.debug"
block.

### Changed — migration v1 uses `PRAGMA table_info` (km-tribe.polish-sweep)

`MIGRATIONS[0].up` now introspects `sessions` via `PRAGMA table_info` and
only issues `ALTER TABLE ADD COLUMN` for columns that don't exist. The
previous implementation wrapped each ALTER in a try/catch to swallow the
"duplicate column" error — correct, but abused exceptions for control
flow. Behaviour is unchanged: fresh installs skip entirely because the
CREATE TABLE already has all five columns; old installs add exactly the
missing subset.

### Changed — unified daemon (km-bear.unified-daemon)

The standalone lore daemon has been folded into the tribe daemon: one
process per user, one Unix socket, one pid. The tribe daemon now hosts
both the coordination RPC surface (`tribe.send`, `tribe.broadcast`,
`tribe.members`, `tribe.history`, `tribe.rename`, `tribe.join`,
`tribe.chief`, `tribe.claim-chief`, `tribe.release-chief`,
`tribe.retro`, `tribe.reload`, `tribe.health`) and the memory RPC surface
(`tribe.ask`, `tribe.brief`, `tribe.plan`, `tribe.session_register`,
`tribe.session_heartbeat`, `tribe.sessions_list`, `tribe.workspace`,
`tribe.session`, `tribe.inject_delta`, `tribe.status`, `tribe.hello`).
Wire protocol is unchanged (`LORE_PROTOCOL_VERSION` stays at 4); existing
lore MCP clients continue to work.

Rollout:

- **Phase 5a** (commit 4db8cdf) — `tools/lib/tribe/lore-handlers.ts`
  factory wraps the former standalone daemon's handlers, focus poller,
  summarizer, and per-session inject dedup. `tools/tribe-daemon.ts`
  opens a second SQLite file (lore.db) in the same process and routes
  `tribe.*` memory methods through the factory. New daemon flags:
  `--lore-db`, `--focus-poll-ms`, `--summary-poll-ms`,
  `--summarizer-model`, `--no-lore`. Integration coverage:
  `tests/tribe-unified-daemon.slow.test.ts` (5 smoke tests).

- **Phase 5b** (commit 93b2155) — `plugins/tribe/lore/server.ts`
  becomes a thin proxy to the unified tribe daemon. The MCP server
  connects to `$XDG_RUNTIME_DIR/tribe.sock` (via
  `resolveSocketPath` from `tools/lib/tribe/socket.ts`) instead of
  the old lore socket, and its autostart path switches from
  `ensureDaemonIfConfigured` to `ensureTribeDaemonIfConfigured`.

- **Phase 5c** (commit 2979103) — `plugins/tribe/lore/daemon.ts`
  and `plugins/tribe/lore/cli.ts` are deleted. The pre-Phase-5c
  `resolveDaemonScriptPath` / `spawnDaemonDetached` /
  `ensureDaemonIfConfigured` / `ensureAllDaemonsIfConfigured` exports
  on `tools/lib/tribe/autostart.ts` are preserved as aliases that all
  resolve to the unified tribe daemon — external importers keep
  working. `tests/lore/daemon.test.ts` and `tests/lore/focus.test.ts`
  now spawn `tools/tribe-daemon.ts` with `--lore-db` instead of the
  deleted standalone script.

- **Phase 5d** (commit fceeccb) — hook-dispatch calls
  `ensureTribeDaemonIfConfigured` directly instead of
  `ensureAllDaemonsIfConfigured`. One probe, one spawn path.

User-visible impact: none if the `.mcp.json` registration is unchanged —
the `tribe` MCP entry (coord tools) and the `lore` MCP entry (memory
tools) continue to resolve to the same tribe daemon pid. `lore status`
and `lore sessions` CLI commands are no longer shipped (the tribe CLI
covers daemon status; memory queries are MCP tools).

### Added — persistent push cursor (km-tribe.message-durability)

Phase 1.6 of the plateau. The daemon's per-connection push cursor is now
persisted to `sessions.last_delivered_ts` / `last_delivered_seq` on every
successful `pushToClient`, and seeded back into the in-memory map on register
(either from the adopted identity row via Phase 1.5, or from a skip-to-latest
bootstrap for brand-new sessions). This closes the gap explicitly called out
by `tests/tribe-self-heal.slow.test.ts`: messages already pushed before a
SIGKILL are no longer re-delivered on reconnect, and messages queued while a
session is offline still arrive when it comes back.

- `pushNewMessages` now keys off `rowid` (strictly monotonic) instead of `ts`
  (can collide within a millisecond) — this also fixed a latent bug where two
  broadcasts emitted in the same tick could cause the middle one to be
  silently skipped.
- `logActivity` no longer pushes directly and bumps the cursor to its own
  rowid — it writes the activity and calls `pushNewMessages()` to drain
  everything the cursor hasn't seen yet, keeping the cursor monotonic.
- `createStatements` exposes `updateLastDelivered` + `getLastDelivered`
  (the column was added in migration v1, now actually written to).

Integration coverage: `tests/tribe-durability.slow.test.ts` (Test E — no
duplicate delivery after restart; Test F — messages queued during downtime
delivered on reconnect).

### Added — identity token adoption (km-tribe.session-identity)

Phase 1.5 of the plateau. Sessions now keep a stable identity across Claude
Code restarts: the proxy hashes `(claude_session_id, project_path, role_hint)`
to a 16-char hex token and sends it on `register`. The daemon, on seeing that
token match a prior, currently-disconnected session, adopts its `sessionId`,
`name`, `role`, and the cursor position — so reopening later re-delivers the
correct identity instead of falling back to `member-<pid>` and replaying from
latest.

- Schema migration v6 adds `sessions.identity_token` + index.
- `registerSession` gains a `Strategy 0` cursor-recovery path that wins over
  the existing `claude_session_id` / PID / skip-to-latest strategies when the
  token is known.
- `tribe.join` accepts `identity_token` too (adopts name/role from the prior
  row when the caller omits them), so re-joining via the MCP tool preserves
  the same identity.
- An already-connected session with the same token blocks adoption — the new
  proxy gets a fresh sessionId with a deduplicated name.
- `identityToken` falls back to hashing just `project_path|role_hint` when
  `CLAUDE_SESSION_ID` is null (weaker but safe — no cross-project leakage).

Integration coverage: `tests/tribe-session-identity.slow.test.ts` (4 tests
— adoption, active-blocks-adoption, cursor recovery, no-token behavior).

### Added — self-heal invariants integration test

`tests/tribe-self-heal.slow.test.ts` exercises the three "Design principles"
invariants from the plugin README by spawning a real `tribe-daemon.ts`
subprocess, simulating crash + recovery on a hermetic tmp socket + DB, and
asserting each invariant:

1. **Reconnection**: a `createReconnectingClient` proxy transparently
   resumes against a freshly-spawned daemon on the same socket path,
   re-running `onConnect` and completing a subsequent `tribe.members` call.
2. **Always-a-chief**: disconnecting the longest-connected member
   re-derives chief onto the remaining session; explicit
   `tribe.claim-chief` promotes a later session and falls back to
   derivation when the claimer leaves.
3. **No message loss (DB-durable)**: a `tribe.broadcast` sent before
   `SIGKILL` is present in the SQLite `messages` table before the kill
   and visible to a reconnecting session via `tribe.history` after the
   new daemon boots.

The suite is `.slow.` so it lives in the `slow` vitest project and does not
run on `bun run test:fast`. Cleanup is aggressive: every test unlinks its
socket, removes its tmp directory, and `SIGKILL`s any straggler daemon in
`afterEach`.

### Changed — heartbeat machinery deleted (Phase 2 of km-tribe.plateau)

Session liveness is no longer a DB timer. Before this change every member
pushed a `heartbeat` RPC to the daemon every 15s; the daemon bumped
`sessions.heartbeat` every 10s for itself; stale rows were pruned by
`heartbeat < cutoff` queries and later hard-deleted by a retention sweep.

After this change, the daemon's in-memory `clients: Map` is the single
source of truth for "who is connected right now". The `sessions` table
survives (it stores `last_delivered_seq` for cursor recovery across
reconnects), but it is no longer tri-state.

User-visible changes:

- `tribe.members` and `tribe status` no longer report pruned / offline
  members by default. Dead sessions disappear from the list when their
  socket closes; pass `all: true` to `tribe.members` to see the full DB.
- The `pruned` field on `tribe.members` rows is gone; the old tri-state
  (`alive` / `pruned` / missing) is now just two-state (`alive: true`
  for rows whose session is in the `clients` Map, `false` otherwise).
- `last_heartbeat_sec` is renamed to `last_seen_sec` and reflects the
  DB's `updated_at` column (bumped on register / rename / last-delivered
  advance), not a periodic ping.
- `tribe status` description changed: "heartbeat" → "last-seen".

Schema:

- `sessions.heartbeat` renamed to `sessions.updated_at`.
- `sessions.pruned_at` dropped.
- `idx_sessions_pruned` dropped; `idx_sessions_updated` added (used by
  cursor-recovery ORDER BY).

Cursor recovery: on reconnect, the strategies that previously
`ORDER BY heartbeat DESC` now `ORDER BY updated_at DESC`. Rejoin under
the same name is handled by deleting the stale row iff its sessionId is
not in the daemon's active set — so dead-row-holding-my-name no longer
blocks registration.

Net deletion: ~80 LOC across `tools/tribe-daemon.ts`, `tools/tribe-proxy.ts`,
`tools/lib/tribe/session.ts`, `tools/lib/tribe/handlers.ts`, and
`tools/lib/tribe/database.ts`.

### Changed — daemon liveness is socket connectability, not a pidfile

The daemon no longer writes, reads, or deletes `tribe.pid`. Liveness is now
"the Unix socket accepts a connection" — the kernel owns the proof, so
there is nothing on-disk to go stale when a daemon crashes or is SIGKILLed.

User-visible changes:

- `tribe doctor` probes the socket instead of reading a pidfile. The PID
  shown in `tribe doctor` / `tribe stop` / `tribe reload` now comes from
  the daemon's own `cli_daemon` RPC response (daemon reports its own PID).
- Stale `.pid` files left over from previous versions are harmless and can
  be deleted by hand; new daemons will never recreate them.
- Daemon startup: if another daemon is already listening on the socket,
  the new process exits quietly. If the socket is stale (no one listening),
  it is unlinked and replaced.

API:

- Added `probeDaemonPid(socketPath)` and `isSocketAlive(socketPath)` in
  `tools/lib/tribe/socket.ts`. Removed `resolvePidPath` and `readDaemonPid`.
- `doctorReport` is now `async` (it awaits the socket probe). Callers must
  `await` the result.

Phase 3 of `km-tribe.plateau` — net ~30 LOC deletion.

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
