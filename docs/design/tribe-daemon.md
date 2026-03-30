# Tribe Daemon Design

## Problem

Tribe currently spawns one MCP process per Claude Code session. N processes share one SQLite DB, causing:

- Duplicate chiefs (no single source of truth for leadership)
- Duplicate notifications (N git pollers detect same commit)
- SQLite write contention (busy_timeout, WAL races)
- Orphan processes (MCP processes outlive their Claude sessions)
- Message replay (cursor state lost on process restart)
- Stale code (Bun caches compiled modules)

Every fix adds complexity: dedup tables, BEGIN IMMEDIATE transactions, source hash checks, 3-strategy cursor recovery, leader leases. The fixes work but the complexity tax is growing.

## Solution

One daemon process per project. Sessions connect to it, they don't embed it.

```
Claude Code 1 → MCP proxy ──┐
Claude Code 2 → MCP proxy ──┤
Claude Code 3 → MCP proxy ──┼──→ Unix socket → tribe-daemon
Terminal      → tribe CLI ───┤     (single process)
Manual start  → tribe start ─┘     owns everything
```

## What the daemon owns

Everything that's currently scattered across N processes:

| Concern          | Current (per-process)              | Daemon (single)              |
| ---------------- | ---------------------------------- | ---------------------------- |
| SQLite DB        | N writers, WAL contention          | Single writer, no contention |
| Git poller       | N pollers, dedup needed            | 1 poller, no dedup           |
| Beads watcher    | N watchers, dedup needed           | 1 watcher, no dedup          |
| Session registry | DB + heartbeats                    | In-memory, authoritative     |
| Leader election  | Lease table + heartbeats           | Trivial — daemon assigns     |
| Message routing  | Poll-based, cursor recovery        | Direct push, no cursors      |
| Dedup            | INSERT OR IGNORE + BEGIN IMMEDIATE | Unnecessary — single writer  |
| Source updates   | Hash check + auto-reload           | fs.watch + SIGHUP            |

## What the proxy does

Thin (~100 lines). No DB access, no polling, no state:

1. Discover daemon socket
2. Connect (start daemon if not running)
3. Send handshake: `{ project, pid, claudeSessionId, name, role, domains }`
4. Forward MCP tool calls → daemon (JSON-RPC over socket)
5. Receive channel notifications ← daemon (pushed, not polled)
6. On disconnect: daemon cleans up session automatically

## Socket discovery

```
--socket flag > TRIBE_SOCKET env > .beads/tribe.sock > $XDG_RUNTIME_DIR/tribe.sock > /tmp/tribe-$UID.sock
```

Default: `.beads/tribe.sock` — lives next to the DB, scoped per project. Multiple projects get separate daemons automatically.

## Starting the daemon

Three ways:

1. **Auto-start** (default): MCP proxy tries `connect()`. ECONNREFUSED or ENOENT → spawn daemon as detached child, retry connect with backoff.

2. **Manual start**: `bun tribe-daemon.ts` or `bun tribe start` from CLI. Useful for debugging, running in a terminal to see logs.

3. **System service**: launchd plist (macOS) or systemd unit (Linux). For always-on setups.

The daemon writes a PID file at `.beads/tribe.pid` for SIGHUP targeting and stale detection.

## Stopping the daemon

1. **Auto-quit**: Daemon tracks connected client count. When the last client disconnects, starts a 30s grace timer. New connection cancels timer. Timer fires → clean exit, remove socket + PID file.

2. **Manual stop**: `bun tribe stop` or `kill $(cat .beads/tribe.pid)`. Sends SIGTERM, daemon closes socket, cleans up.

3. **Grace period configurable**: `--quit-timeout=30` (seconds). Set to 0 for immediate quit on last disconnect. Set to -1 for never auto-quit.

## Hot-reload

The daemon must support code updates without losing connections:

1. **SIGHUP handler**: On SIGHUP, daemon re-execs itself with `--fd=N` passing the listening socket file descriptor. New process inherits the socket, accepts new connections. Old connections drain naturally.

2. **fs.watch trigger**: Daemon watches its own source directory. File change → auto-SIGHUP after 500ms debounce.

3. **tribe_reload tool**: Proxy sends reload request → daemon sends SIGHUP to itself.

4. **CLI**: `bun tribe reload` sends SIGHUP to the PID from `.beads/tribe.pid`.

5. **Source hash guard**: On SIGHUP, compute source hash. If unchanged, skip re-exec (avoid unnecessary restarts).

## Protocol

JSON-RPC 2.0 over unix socket (newline-delimited JSON):

```json
// Request (proxy → daemon)
{"jsonrpc":"2.0","id":1,"method":"tribe_send","params":{"to":"member-1","message":"hello"}}

// Response (daemon → proxy)
{"jsonrpc":"2.0","id":1,"result":{"sent":true,"id":"msg-uuid"}}

// Notification (daemon → proxy, pushed)
{"jsonrpc":"2.0","method":"channel","params":{"from":"chief","type":"notify","content":"..."}}
```

### Handshake

On connect, proxy sends a `register` call:

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "method": "register",
  "params": {
    "project": "/Users/beorn/Code/pim/km",
    "pid": 12345,
    "claudeSessionId": "abc-123",
    "name": "silvery",
    "role": "member",
    "domains": ["silvery", "flexily"]
  }
}
```

Daemon responds with session assignment:

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "result": {
    "sessionId": "uuid",
    "name": "silvery",
    "role": "member",
    "chief": "chief"
  }
}
```

## Auth

1. **Filesystem permissions**: Unix socket file owned by user. Only same-UID processes can connect.
2. **Project binding**: Per-project sockets (`.beads/tribe.sock`) are inherently project-scoped. Per-user sockets check `project` in handshake.
3. **No crypto**: Same-machine, same-user. Filesystem perms are sufficient.

## Session lifecycle

| Event                       | Daemon action                                                    |
| --------------------------- | ---------------------------------------------------------------- |
| Client connects + registers | Add to session map, assign name/role, notify others              |
| Client sends tool call      | Execute against DB, return result                                |
| Bead change detected        | Push notification to relevant clients (claimed_by match)         |
| Git commit detected         | Push notification to ONE client (first in round-robin or chief)  |
| Client disconnects          | Remove from session map, notify others, start quit timer if last |
| SIGHUP                      | Re-exec, transfer socket fd, new process re-reads DB state       |

## Message delivery

No more polling. Daemon pushes directly:

1. Client A calls `tribe_send(to: "B", message: "hello")`
2. Daemon writes to DB (single writer, no contention)
3. Daemon looks up B's socket connection
4. Daemon pushes notification to B immediately (no 1s poll delay)
5. If B is not connected, message stays in DB for when B reconnects

Reconnection: on connect, daemon sends any undelivered messages (since last `delivered_seq`) as a batch. No cursor recovery strategies needed — daemon tracks everything.

## Migration plan

### Phase 1: Create daemon

- `tools/tribe-daemon.ts`: socket server, JSON-RPC handler, session registry
- Reuses existing `lib/tribe/` modules (database, handlers, plugins, etc.)
- Can run standalone: `bun tools/tribe-daemon.ts`

### Phase 2: Create thin proxy

- `tools/tribe-proxy.ts`: MCP server that proxies to daemon
- Auto-starts daemon if not running
- ~100 lines, no DB access

### Phase 3: Switch tribe.ts

- `tribe.ts` becomes `tribe-proxy.ts` (or imports it)
- Old embedded mode deleted entirely
- .mcp.json unchanged (still points to tribe.ts)

### Phase 4: Update CLI

- `tribe-cli.ts` connects to daemon socket instead of DB
- Same commands, better reliability (no SQLite contention with MCP processes)

### Phase 5: Cleanup

- Delete: dedup table, BEGIN IMMEDIATE, source hash check, cursor recovery strategies, leader lease (daemon assigns chief)
- Delete: plugins from proxy (daemon owns them)
- /complete: grep Database in tribe.ts → 0 hits

## CLI design

The daemon transforms the CLI from a direct-DB reader to a socket client. Same commands, same output, but reliable (no SQLite contention) and live (real-time data from daemon's in-memory state).

```
bun tribe status          # Sessions with uptime, heartbeat, role, domains
bun tribe sessions [--all]# List sessions (--all includes disconnected)
bun tribe send <to> <msg> # Send message through daemon (immediate push)
bun tribe log [--limit N] # Recent messages
bun tribe health          # Diagnostics: stale sessions, unread messages, daemon uptime
bun tribe start           # Start daemon in foreground (for debugging)
bun tribe stop            # Stop daemon (SIGTERM)
bun tribe reload          # Hot-reload daemon (SIGHUP)
bun tribe retro           # Retrospective report (reads DB directly — offline OK)
```

### Implementation

The CLI connects to the daemon socket and sends JSON-RPC requests. For read-only queries (`status`, `sessions`, `log`, `health`), the daemon returns its authoritative in-memory state plus DB-backed history. For writes (`send`), the daemon handles routing and persistence.

```typescript
// CLI request
{"jsonrpc":"2.0","id":1,"method":"cli_status","params":{}}

// Daemon response — real-time, no heartbeat staleness
{"jsonrpc":"2.0","id":1,"result":{
  "sessions": [...],
  "daemon": { "uptime": 3600, "clients": 3, "dbPath": ".beads/tribe.db" }
}}
```

New CLI methods (not in MCP proxy):

| Method          | Purpose                            |
| --------------- | ---------------------------------- |
| `cli_status`    | Sessions + daemon info             |
| `cli_log`       | Message history with limit/filter  |
| `cli_health`    | Full diagnostics                   |
| `cli_daemon`    | Daemon process info (PID, uptime)  |

### Fallback

If daemon is not running and `--offline` flag is set, CLI falls back to direct DB read (same as current behavior). This allows inspection even when the daemon is down.

### Interactive mode (future)

`bun tribe watch` — TUI dashboard showing live session status and message stream via persistent socket connection. Updates pushed from daemon in real-time.

## Comparison with openclaw gateway

openclaw's gateway is a mature reference architecture solving a related but different problem. Key patterns and how tribe differs:

### Architecture

| Aspect | openclaw gateway | tribe daemon |
| --- | --- | --- |
| **Process model** | Single long-running server (WebSocket + HTTP) | Single long-running daemon (Unix socket) |
| **Client protocol** | WebSocket (remote-capable) | Unix domain socket (local-only) |
| **Channels** | Telegram, WhatsApp, email, SMS, browser | Claude Code sessions (MCP) |
| **Session tracking** | In-memory session map + heartbeat runner | In-memory session map + socket liveness |
| **Storage** | None (stateless gateway, LLM handles state) | SQLite (messages, sessions, events persist) |
| **Config** | YAML file, hot-reload via chokidar watcher | CLI args + env vars, hot-reload via fs.watch |
| **Discovery** | DNS/LAN/Tailscale (network-based) | Unix socket path (filesystem-based) |
| **Auth** | API keys, device auth, session tokens | Unix socket permissions (same-UID) |

### Hot-reload comparison

openclaw uses a hybrid reload system worth studying:

1. **Chokidar file watcher** on config file → 300ms debounce → creates a `GatewayReloadPlan`
2. **Reload plan classifies changes** as `hot` (apply in-place) vs `restart` (full process restart)
3. **Hot reload** restarts individual subsystems: channels, cron, hooks, heartbeat — without full restart
4. **Full restart** via SIGUSR1 with authorization gate: `authorizeGatewaySigusr1Restart()` must be called before the signal fires — prevents unauthorized external SIGUSR1
5. **Platform-aware restart**: launchd (macOS) or systemd (Linux) for daemon supervision

What we borrow:
- **Authorized SIGUSR1**: Tribe daemon should gate SIGHUP re-exec behind authorization too — prevent stray signals from causing unexpected restarts
- **Granular reload plan**: Some changes (config, plugin params) don't need re-exec — just re-read the value. Reserve re-exec for actual code changes.
- **Subsystem restart**: The daemon can restart individual plugins (git poller, beads watcher) without full re-exec

What we don't need:
- **Remote networking**: tribe is same-machine, same-user — no WebSocket, no TLS, no discovery
- **Channel abstraction**: tribe has one channel type (MCP session) — no multi-channel routing
- **Config file watching**: tribe config is args/env, not a YAML file that changes at runtime

### Key openclaw patterns to adopt

1. **Restart sentinel** (`server-restart-sentinel.ts`): Before re-exec, write a sentinel file. New process reads it to know "I'm a restart, not a fresh start" — important for reconnection behavior.

2. **Subsystem logger hierarchy** (`createSubsystemLogger`): Each subsystem gets a child logger for structured logging. Tribe daemon should do the same — `daemon`, `daemon/socket`, `daemon/plugins/git`, `daemon/plugins/beads`.

3. **Reload plan** rather than blanket restart: classify changes and minimize disruption.

## What we keep

- All `lib/tribe/` modules (database, handlers, messaging, session, etc.)
- MCP tool interface (same tools, same names, same behavior)
- SQLite DB schema (unchanged)
- beads/git plugins (move to daemon)
- tribe-retro.ts (works against same DB)
