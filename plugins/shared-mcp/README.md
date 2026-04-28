# @bearly/shared-mcp — Shared MCP server library (prototype)

> **Why "shared-mcp"?** This is not a standalone MCP plugin — it's a
> shared MCP server library used by multiple bearly tools (tribe, tty,
> github). The "shared-mcp" name disambiguates from per-protocol surfaces.

> **Status:** prototype skeleton. Wire conformance and lifecycle only. Real
> MCP tool implementations beyond an empty `tools/list` and migration of
> existing stdio MCPs are follow-up work — see the parent bead.

## What it is

A long-running MCP server, hosted as a plugin on the existing tribe daemon,
that all Claude Code sessions on the machine share over Streamable HTTP via
a Unix socket.

Today, every Claude Code session spawns its own MCP servers via stdio. With
N sessions × M servers, startup latency, FD pressure, and lifecycle bugs all
scale linearly. One shared MCP daemon collapses that to one process per
machine.

## Lifetime — two numbers, two timers

The plugin owns exactly two timers and one shutdown reason at a time. Per
the /pro round-2 elegance review (2026-04-26):

```ts
createMcpPlugin({
  idleTimeoutMs: 30 * 60 * 1000, // default
  maxLifetimeMs: 24 * 60 * 60 * 1000, // default
  onShutdown: (reason) => daemon.shutdown(reason),
})
```

- **`idleTimeoutMs`** — connection-as-lease. The active in-flight HTTP
  response count IS the lease. When it drops to zero, an idle
  `setTimeout(shutdown, idleTimeoutMs)` arms. New request → cancel timer.
  Timer fires → `onShutdown("idle")`.

- **`maxLifetimeMs`** — hard cap on plugin uptime. Fires at startup with
  `setTimeout(shutdown, maxLifetimeMs)` regardless of activity. Caps
  long-running daemons that never see an idle window.

Both timers are event-driven `setTimeout`s. There is no DSL, no rule
engine, no heartbeat tick, no predicate registry. Liveness is derived from
the connection set; the daemon is asked to shut down through one callback.

The plugin does **not** call `process.exit()` — `onShutdown` is the
daemon's hook for draining in-flight messages, persisting state, and
exiting cleanly.

## Wire — Streamable HTTP over Unix socket

```
GET    /healthz   → 200 "ok\n"  (cheap liveness probe; no MCP framing)
POST   /mcp       → @modelcontextprotocol/sdk Streamable HTTP — JSON-RPC
GET    /mcp       → @modelcontextprotocol/sdk Streamable HTTP — server-initiated SSE
DELETE /mcp       → @modelcontextprotocol/sdk Streamable HTTP — session teardown
```

The plugin uses `@modelcontextprotocol/sdk`'s
`WebStandardStreamableHTTPServerTransport` and bridges `Request` ↔
`IncomingMessage` and `Response` ↔ `ServerResponse` with a small adapter
(< 30 LOC) so the wire is straight from the SDK without the
`@hono/node-server` request-listener layer.

The transport runs in **stateful mode** (per-session). Each connecting
Claude Code session gets a session ID via the `Mcp-Session-Id` response
header on initialize and echoes it on subsequent requests. The plugin
keeps a `Map<sessionId, { server, transport }>` so multiple clients can
share the daemon without crosstalk.

### Unix socket (mode 0600, bind-before-publish)

Bound to a Unix-domain socket. Only processes that the kernel grants
read/write on the socket file (the same UID) can talk to it; there is no
network listener. Path resolution mirrors the tribe daemon:

- `BEARLY_MCP_SOCKET` env var (override)
- `XDG_RUNTIME_DIR/bearly-mcp/mcp-<pid>.sock`
- `~/.local/share/bearly-mcp/mcp-<pid>.sock` (macOS / no XDG)
- `/tmp/bearly-mcp/mcp-<pid>.sock` (no `HOME`)

Claude Code's HTTP MCP client supports `unix:` URIs, so consumers point at
the socket directly — no TCP, no port allocation, no firewall surface.

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

`stop()` unlinks the published socket so a restart doesn't trip the
"already in use" probe.

No pidfile. No handshake. Liveness check from outside is a single line:
"can I connect to the socket?"

## Usage

```ts
import { createMcpPlugin } from "@bearly/shared-mcp"

const mcp = createMcpPlugin({
  idleTimeoutMs: 30 * 60 * 1000,
  maxLifetimeMs: 24 * 60 * 60 * 1000,
  onShutdown: (reason) => {
    log.info(`mcp asks to quit: ${reason}`)
    daemon.shutdown()
  },
})

// Plug into the tribe plugin loader alongside git, beads, github, ...
const plugins = [gitPlugin, beadsPlugin, mcp /* … */]
loadPlugins(plugins, tribeClientApi)

// Test/observability hooks:
mcp.getAddress() // { socketPath } once listening
mcp.getConnectionCount() // current active wire-connection count
```

Connecting from a client — the canonical SDK Client works:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

// Claude Code's HTTP MCP client supports `unix:` URIs natively.
const client = new Client({ name: "my-client", version: "0.0.0" }, { capabilities: {} })
await client.connect(new StreamableHTTPClientTransport(new URL("unix:/path/to/mcp.sock?path=/mcp")))
const tools = await client.listTools() // → { tools: [] } in this prototype
```

Plugin shape conforms to `TribePluginApi` (see
`tools/lib/tribe/plugin-api.ts`) so it loads through the existing
`loadPlugins(plugins, api)` path with no daemon-side changes.

## Tests

`tests/mcp-plugin.test.ts` covers the design surface:

1. **idleTimeoutMs fires** — connection-as-lease, idle timer arms when
   count reaches zero, fires after the window.
2. **maxLifetimeMs fires** — lifetime timer fires regardless of activity.
3. **Bind-before-publish, mode 0600** — published path has the right
   permissions and no `.tmp.sock` leftovers.
4. **Clean disposable** — factory returns a `TribePluginApi`-shaped
   handle whose `stop()` releases all resources idempotently.
5. **MCP wire conformance** — SDK Client → `tools/list` → `[]` over the
   StreamableHTTPClientTransport, routed through a Unix-socket fetch shim.

```bash
# from the bearly worktree (uses the host-repo's vitest binary)
/path/to/km/node_modules/.bin/vitest run plugins/shared-mcp/
```

## What this bead does NOT do

- Real MCP tool implementations beyond `tools/list` returning `[]`
- Hot-reload (the tribe daemon already provides it; this plugin doesn't
  break it)
- Auth — next bead
- Migration of any existing stdio MCP usage in silvercode — next bead

## Design rulings (from the parent bead + /pro round-2 elegance review)

1. **Connection-as-lease**, no separate `lease()` API. Connection count > 0
   IS the lease.
2. **Two numbers, two timers** — `idleTimeoutMs` + `maxLifetimeMs`. No
   DSL, no rule engine, no predicate registry, no heartbeat tick.
3. **Unix socket only** for the MCP wire (mode `0600`, bind-before-publish).
   Same-UID local IPC, no TCP, no network surface.
4. **No pidfile, no handshake.** Liveness = "can I connect?".
5. **One callback for shutdown** (`onShutdown`). The plugin does not call
   `process.exit()` — the daemon owns shutdown.
