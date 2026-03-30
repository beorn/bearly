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

## What we keep

- All `lib/tribe/` modules (database, handlers, messaging, session, etc.)
- MCP tool interface (same tools, same names, same behavior)
- SQLite DB schema (unchanged)
- beads/git plugins (move to daemon)
- tribe-retro.ts (works against same DB)
