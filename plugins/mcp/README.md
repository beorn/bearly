# @bearly/mcp — MCP-as-tribe-plugin (prototype)

> **Status:** prototype skeleton. Wire conformance, lifecycle, and
> predicate composition only. Real MCP tool implementations beyond an
> empty `tools/list` and migration of existing stdio MCPs are follow-up
> work — see the parent bead.

## What it is

A long-running MCP server, hosted as a plugin on the existing tribe daemon,
that all Claude Code sessions on the machine share over Streamable HTTP via
a Unix socket.

Today, every Claude Code session spawns its own MCP servers via stdio. With
N sessions × M servers, startup latency, FD pressure, and lifecycle bugs all
scale linearly. One shared MCP daemon collapses that to one process per
machine.

## Connection-as-lease

The active TCP/Unix-socket connection count IS the lease. There is no
`lease()` API, no reference-count dance, no handshake — clients just
connect over the MCP wire, and the kernel-level connection itself is the
"I'm using this" signal.

```
last connection drops → arm idle-quit timer (default 30 min)
new connection arrives → cancel the timer
timer fires            → the `idle` predicate flips true
                       → events.emit("request_quit", "idle")
                       → daemon owner shuts the process down
```

Liveness check from outside is a single line: "can I connect to the
socket?" No pidfile, no handshake, no reaper. The pidfile/reaper edifice
was deleted from silvercode in commit `4f9e9ebb5` (898 LOC) — this design
exists so we don't reintroduce it.

## Composable quit predicates

Multiple shutdown reasons coexist as a flat list of callable predicates:

```ts
type QuitPredicate = () => boolean | Promise<boolean>
```

The daemon quits when **any** predicate returns true. Built-ins:

- `idle` — set true by the idle-quit timer when no MCP-wire connections are open
- `sigterm` — set true by the SIGTERM handler

Anything else plugs in the same way:

```ts
plugin.registerQuitPredicate(() => process.ppid === 1)        // parent gone
plugin.registerQuitPredicate(async () => await quotaExhausted())
plugin.registerQuitPredicate(() => !configFileStillExists())
```

There is **no tagged union, no `kind` field**. Predicates are just thunks.
Cheap to add, cheap to compose, and they keep shutdown a single
`Promise.race`-equivalent over (poll-tick, fast-path event).

Predicates are checked:

- on a slow tick (default 5s, configurable)
- immediately when the connection count drops to zero (event-driven, so
  external-state predicates don't pay the full poll latency on detach)
- immediately when the idle timer fires

## request_quit channel — EventEmitter

The plugin emits a `"request_quit"` event with the firing predicate's
label as payload. **Multiple subscribers are supported** — this is the
reason the channel is an EventEmitter rather than a single callback. A
daemon supervisor can record telemetry while the actual lifecycle handler
does the shutdown:

```ts
plugin.events.on("request_quit", (reason) => daemon.shutdown(reason))
plugin.events.on("request_quit", (reason) => metrics.record(reason))
```

The plugin does NOT call `process.exit()` — shutdown is the daemon's
responsibility.

## Wire — Streamable HTTP over Unix socket

Endpoints:

```
GET    /healthz   → 200 "ok\n"  (cheap liveness probe; no MCP framing)
POST   /mcp       → @modelcontextprotocol/sdk Streamable HTTP — JSON-RPC requests
GET    /mcp       → @modelcontextprotocol/sdk Streamable HTTP — server-initiated SSE stream
DELETE /mcp       → @modelcontextprotocol/sdk Streamable HTTP — session teardown
```

The plugin uses `@modelcontextprotocol/sdk`'s
`WebStandardStreamableHTTPServerTransport` — the canonical wire that
Claude Code's HTTP MCP client speaks. We bridge `Request` ↔
`IncomingMessage` and `Response` ↔ `ServerResponse` with a small adapter
(< 30 LOC) so the wire is straight from the SDK without the
`@hono/node-server` request-listener layer.

The transport runs in **stateful mode** (per-session). Each connecting
Claude Code session gets a session ID via the `Mcp-Session-Id` response
header on initialize and echoes it on subsequent requests. The plugin
keeps a `Map<sessionId, { server, transport }>` so multiple clients can
share the daemon without crosstalk. Stateless mode requires a fresh
transport per request (per the SDK's docstring: "Reusing a stateless
transport causes message ID collisions between clients") — too expensive
for a long-running server.

### Unix socket (mode 0600, bind-before-publish)

Bound to a Unix-domain socket. Only processes that the kernel grants
read/write on the socket file (the same UID) can talk to it; there is no
network listener. Path resolution mirrors the tribe daemon:

- `BEARLY_MCP_SOCKET` env var (override)
- `XDG_RUNTIME_DIR/bearly-mcp/mcp-<pid>.sock`
- `~/.local/share/bearly-mcp/mcp-<pid>.sock` (macOS / no XDG)
- `/tmp/bearly-mcp/mcp-<pid>.sock` (no `HOME`)

Claude Code's HTTP MCP client supports `unix:` URIs, so consumers point
at the socket directly — no TCP, no port allocation, no firewall surface.

On startup, the plugin:

1. Creates the parent dir (mode `0700`).
2. Probes any existing file at the published path. If it answers a
   `connect()`, refuses to start (a live peer owns the path). Otherwise
   unlinks the stale file.
3. Binds the HTTP server to a hidden temp path in the same dir
   (`.mcp-<pid>-<rand>.tmp.sock`).
4. `chmod 0600` on the temp path — the published path is **never** visible
   with wider permissions, even briefly.
5. `rename(temp → published)` — atomic on the same filesystem.

`stop()` unlinks the published socket, so a restart doesn't hit the
"already in use" probe.

## Usage

```ts
import { createMcpPlugin } from "@bearly/mcp"

const mcp = createMcpPlugin({
  idleTimeoutMs: 30 * 60 * 1000, // default
})

// Subscribe to shutdown signals — multi-listener supported.
mcp.events.on("request_quit", (reason) => {
  log.info(`mcp asks to quit: ${reason}`)
  daemon.shutdown()
})

// Plug into the tribe plugin loader alongside git, beads, github, ...
const plugins = [gitPlugin, beadsPlugin, mcp /* … */]
loadPlugins(plugins, tribeClientApi)

// Outside callers can still register more predicates after start():
mcp.registerQuitPredicate(() => process.ppid === 1)

// And introspect, mostly for tests:
mcp.getAddress()         // { socketPath } once listening
mcp.getConnectionCount() // current active wire-connection count
```

Connecting from a client — the canonical SDK Client works:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

// (Custom fetch shim required if the client speaks Unix-socket; Claude
// Code's HTTP MCP client supports `unix:` URIs natively.)
const client = new Client({ name: "my-client", version: "0.0.0" }, { capabilities: {} })
await client.connect(new StreamableHTTPClientTransport(new URL("unix:/path/to/mcp.sock?path=/mcp")))
const tools = await client.listTools() // → { tools: [] } in this prototype
```

Plugin shape conforms to `TribePluginApi` (see
`tools/lib/tribe/plugin-api.ts`) so it loads through the existing
`loadPlugins(plugins, api)` path with no daemon-side changes.

## Tests

`tests/mcp-plugin.test.ts` covers the full design surface:

1. **lifecycle** — bind-publish, mode 0600, lease taken on connect, dropped
   on disconnect, idle-quit fires via `events.emit("request_quit", "idle")`.
   Uses a raw socket to take the lease so SDK timing doesn't interfere.
2. **MCP wire conformance** — SDK Client → `tools/list` → `[]` over the
   StreamableHTTPClientTransport, routed through a Unix-socket fetch shim.
3. **initial-predicate composition** — a custom predicate fires before
   the idle window, proving predicates compose as flat thunks.
4. **registerQuitPredicate after start()** works.
5. **multi-listener** — two `events.on("request_quit", ...)` listeners
   both receive the event. Pins the EE contract that motivated the swap
   from a single callback.

```bash
# from the bearly worktree (uses the host-repo's vitest binary)
/path/to/km/node_modules/.bin/vitest run plugins/mcp/
```

## What this bead does NOT do

- Real MCP tool implementations beyond `tools/list` returning `[]`
- Hot-reload (the tribe daemon already provides it; this plugin doesn't
  break it)
- Auth — next bead
- Migration of any existing stdio MCP usage in silvercode — next bead

## Design rulings (from the parent bead)

1. **Connection-as-lease**, no separate `lease()` API. Connection count > 0
   IS the lease.
2. **Composable predicates** typed uniformly as
   `() => boolean | Promise<boolean>`. No tagged union, no `kind` field.
3. **Unix socket only** for the MCP wire (mode `0600`, bind-before-publish).
   Same-UID local IPC, no TCP, no network surface. Tribe daemon's own
   coordination IPC also stays Unix-socket — not changed by this plugin.
4. **No pidfile, no handshake.** Liveness = "can I connect?".
5. **Default 30-min idle-quit**, configurable; tests can override to 100ms.
