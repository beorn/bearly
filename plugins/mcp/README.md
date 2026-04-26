# @bearly/mcp — MCP-as-tribe-plugin (prototype)

> **Status:** prototype skeleton. Lifecycle and predicate composition only.
> Real MCP tool implementations and migration of existing stdio MCPs are
> follow-up work — see the parent bead.

## What it is

A long-running MCP server, hosted as a plugin on the existing tribe daemon,
that all Claude Code sessions on the machine share over HTTP+SSE.

Today, every Claude Code session spawns its own MCP servers via stdio. With
N sessions × M servers, startup latency, FD pressure, and lifecycle bugs all
scale linearly. One shared MCP daemon collapses that to one process per
machine.

## Connection-as-lease

The active SSE-connection count IS the lease. There is no `lease()` API, no
reference-count dance, no handshake — clients just connect over SSE, and
the connection itself is the "I'm using this" signal.

```
last connection drops → arm idle-quit timer (default 30 min)
new connection arrives  → cancel the timer
timer fires             → the `idle` predicate flips true
                          → `onRequestQuit("idle")` fires
                          → daemon owner shuts the process down
```

Liveness check from outside is a single line: "can I connect to the port?"
No pidfile, no handshake, no reaper. The pidfile/reaper edifice was deleted
from silvercode in commit `4f9e9ebb5` (898 LOC) — this design exists so we
don't reintroduce it.

## Composable quit predicates

Multiple shutdown reasons coexist as a flat list of callable predicates:

```ts
type QuitPredicate = () => boolean | Promise<boolean>
```

The daemon quits when **any** predicate returns true. Built-ins:

- `idle` — set true by the idle-quit timer when no SSE connections are open
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

## Wire (prototype scope)

```
GET  /healthz   → 200 "ok\n"
GET  /sse       → text/event-stream; each connect joins the active set
POST /rpc       → JSON-RPC; right now only `tools/list` → { tools: [] }
```

Bound to `127.0.0.1:<ephemeral-port>` by default. Loopback only — this
server speaks to in-machine Claude Code sessions, not the network.

The MCP SDK's StreamableHttp/SSE transports are deliberately **not** used
in this skeleton. The prototype validates the lifecycle design (lease /
predicate composition / clean shutdown) and stays small enough to read in
one sitting. SDK upgrade is a one-file follow-up.

## Usage

```ts
import { createMcpPlugin } from "@bearly/mcp"

const mcp = createMcpPlugin({
  onRequestQuit: (reason) => {
    log.info(`mcp asks to quit: ${reason}`)
    daemon.shutdown()
  },
  idleTimeoutMs: 30 * 60 * 1000, // default
})

// Plug into the tribe plugin loader alongside git, beads, github, ...
const plugins = [gitPlugin, beadsPlugin, mcp /* … */]
loadPlugins(plugins, tribeClientApi)

// Outside callers can still register more predicates after start():
mcp.registerQuitPredicate(() => process.ppid === 1)

// And introspect, mostly for tests:
mcp.getAddress()         // { host, port } once listening
mcp.getConnectionCount() // current active SSE count
```

Plugin shape conforms to `TribePluginApi` (see
`tools/lib/tribe/plugin-api.ts`) so it loads through the existing
`loadPlugins(plugins, api)` path with no daemon-side changes.

## Tests

One happy-path lifecycle test plus two predicate-composition tests live in
`tests/mcp-plugin.test.ts`. They use a 100ms idle window so the suite stays
fast; production default is 30 minutes.

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
- StreamableHttp / SSEServerTransport from `@modelcontextprotocol/sdk` —
  next bead

## Design rulings (from the parent bead)

1. **Connection-as-lease**, no separate `lease()` API. Connection count > 0
   IS the lease.
2. **Composable predicates** typed uniformly as
   `() => boolean | Promise<boolean>`. No tagged union, no `kind` field.
3. **Loopback only** for the HTTP wire. (Tribe daemon's own IPC stays Unix
   socket — not changed by this plugin.)
4. **No pidfile, no handshake.** Liveness = "can I connect?".
5. **Default 30-min idle-quit**, configurable; tests can override to 100ms.
