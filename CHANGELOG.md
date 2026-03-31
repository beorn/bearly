# Changelog

## [0.8.0] - 2026-03-31

### Added

- **Tribe v2: Discovery broker architecture** — daemon is now a discovery broker, not a message router. Canonical project_id (hash of realpath), protocol versioning, coordination state table, event log
- **Peer sockets** — proxies expose peer sockets for direct messaging. `discover` handler finds sessions by project/name. Direct send with daemon fallback
- **GitHub resource plugin** — centralized GitHub monitoring as tribe plugin. Polls all user repos via API. Broadcasts push, PR, workflow, issue events to all sessions
- **Watch TUI resources column** — shows active resources per session (git, beads, github)
- **Managed timers** — `createTimers(signal)` ties all setTimeout/setInterval to AbortController. Prevents timer leaks
- **Hot-reload** — proxy and watch auto-re-exec on source file changes (when running from source)
- **Proxy heartbeat** — sessions heartbeat every 15s, staying alive in daemon DB
- **Unified `logActivity()`** — single function for all observable events. Persists to DB + pushes to clients. No silent events
- **Session join logs** — include PID and project path
- **Default session names** — sessions named by project (km, vault) instead of member-pid
- **Message TTL** — auto-delete messages/events older than 7 days
- **Silvery Table component** — watch uses `<Table>` with auto-width columns

### Changed

- **Module splits** — recall.ts (1678→6 files), llm.ts (1310→3 files), db.ts (959→3 files)
- **Deleted tribe.ts** — standalone MCP mode replaced by proxy
- **Merged tribe-retro.ts** into CLI subcommand + lib/tribe/retro.ts
- **Broadcast protocol** — bead claims, git commits, session events broadcast to all (was chief-only)
- **Watch layout** — flexbox table, auto-width columns, no padEnd strings
- **Socket path** — always user-level (~/.local/share/tribe/tribe.sock), no .beads/ fallback
- **Disposable hot-reload** — uses `Symbol.dispose` + `using` pattern

### Fixed

- **Watch exit hang** — unref reconnect timers, fix race in close handler
- **Duplicate messages** — logActivity advances lastDelivered to prevent double delivery
- **Notification replay on reconnect** — handlers replayed onto new connections
- **GitHub event floods** — cap at 3 events per repo per poll, cursor miss handling
- **GitHub commit count** — use commits.length instead of payload.size
- **Flexily CI** — add ESNext.Disposable to lib, add loggily + @types/node deps
- **mdtest CI** — add loggily, zod, @types/node deps
