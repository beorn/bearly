# Tribe v2: Discovery Broker + Resource Sockets

## Problem

The tribe daemon hardcodes beads coupling in 6 places and acts as both a message router and coordination service. This couples project-specific concerns (beads, git) into the daemon, prevents cross-project resource access, and makes the daemon a bottleneck for all communication.

## Design Principle

**The daemon is a discovery broker, not a message router.** It knows who's alive and who has what. It never touches data, never routes messages, never reads the filesystem.

Resources (beads, git, etc.) are exposed as sockets by the proxies that own them. Other proxies connect directly. The daemon just helps them find each other.

## Architecture

```
DAEMON (discovery broker)
│  - Session registry (who's alive, what project)
│  - Resource directory (who exposes what, at which socket)
│  - Leadership leases (per project scope)
│  - Coordination broadcasts (stop, compact, reload)
│
│  Does NOT:
│  - Route messages between sessions
│  - Forward tool calls
│  - Read the filesystem
│  - Host plugins
│  - Know about beads, git, or any project system
│
│  ~200 lines. One socket. One DB.
│
└─── daemon.sock (XDG_RUNTIME_DIR/tribe/daemon.sock)

PROXY (one per Claude session, runs in project cwd)
│  - MCP server (stdio ↔ Claude Code)
│  - Daemon client (register, discover)
│  - Plugin host (detect, load, expose)
│  - Peer connections (direct socket to other proxies/resources)
│
├─── plugins (loaded based on cwd detection):
│    ├── tribe   (always: sessions, send, leadership)
│    ├── beads   (if .beads/: bd list, create, close)
│    ├── git     (if .git/: commit notifications)
│    └── linear  (if .linear/config: query API)
│
└─── resource sockets (one per plugin that exposes resources):
     ├── /run/tribe/km-beads.sock
     └── /run/tribe/km-git.sock
```

## How It Works

### 1. Proxy starts, detects plugins, registers with daemon

```ts
// Proxy discovers what's available in its project cwd
const plugins = discoverPlugins(process.cwd())
// → .beads/ exists → load beadsPlugin
// → .git/ exists   → load gitPlugin

// Each plugin that exposes resources gets a socket
for (const plugin of plugins) {
  if (plugin.resources) {
    plugin.socket = listen(`/run/tribe/${project}-${plugin.name}.sock`)
  }
}

// Register with daemon: who I am + what I offer
daemon.call("register", {
  name: "chief", project: "km", pid: process.pid,
  resources: [
    { name: "beads", socket: "/run/tribe/km-beads.sock" },
    { name: "git",   socket: "/run/tribe/km-git.sock" },
  ]
})
```

### 2. Cross-project resource access is discover + direct connect

```
Claude (decker) wants km's open beads:

1. proxy asks daemon: "who has beads for km?"
2. daemon returns: { socket: "/run/tribe/km-beads.sock" }
3. proxy connects directly to km-beads.sock
4. proxy calls: { method: "list", params: { status: "open" } }
5. km's beads plugin reads .beads/issues.jsonl, returns data
6. done. daemon never saw the data.
```

### 3. Session-to-session messages are also direct

```
Claude (decker) wants to message km's chief:

1. proxy asks daemon: "where is km:chief?"
2. daemon returns: { socket: "/run/tribe/km-chief.sock" }
   (or the proxy's main peer socket)
3. proxy connects directly, sends message
4. daemon never saw the message content
```

### 4. Daemon broadcasts are the exception

Some coordination messages go through the daemon because they target all sessions:
- "chief is compacting, everyone pause"
- "daemon shutting down"
- "session X died" (heartbeat timeout notification)

These are rare, small, and don't carry resource data.

### 5. Observability via event log

With peer-to-peer messages the daemon loses visibility. Proxies fire-and-forget log events to the daemon for centralized observability:

```ts
// After sending a direct message, proxy logs the event (not the content)
daemon.call("log", { type: "message.sent", project: "km", to: "chief", ts: Date.now() })

// After accessing a remote resource
daemon.call("log", { type: "resource.accessed", project: "km", resource: "beads", action: "list" })
```

```sql
CREATE TABLE event_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  session_id TEXT,
  project TEXT,
  type TEXT,        -- "message.sent", "resource.accessed", "session.joined"
  meta TEXT          -- JSON: { to, resource, action, ... }
);
```

Best-effort, append-only. If the daemon is slow or down, log events are dropped — observability never blocks coordination. This powers `tribe watch`, `tribe retro`, and debugging.

## Plugin Interface

```ts
interface ResourcePlugin {
  name: string

  /** Can this plugin activate in the given project? */
  detect(projectRoot: string): boolean

  /** MCP tool definitions to expose to Claude */
  tools(): ToolDefinition[]

  /** Handle a tool call (from local Claude or remote peer) */
  handle(tool: string, args: Record<string, unknown>): ToolResult

  /** Resources this plugin exposes (for discovery directory) */
  resources?(): ResourceDescriptor[]

  /** Watch for changes and push notifications */
  watch?(onChange: (event: ResourceEvent) => void): Disposable
}

interface ResourceDescriptor {
  name: string           // "beads", "git"
  capabilities: string[] // ["list", "read", "write", "watch"]
}
```

Plugins are pure software — no LLM, no MCP protocol awareness. They expose tools (for Claude) and handle requests (from peers). The proxy wraps them in MCP for Claude and JSON-RPC for peer connections.

## What Lives Where

```
LLM LAND (reasoning, judgment)     SOFTWARE LAND (data, I/O)
                                   
Claude session                     Daemon (~200 lines)
├─ "claim bead km-tui.foo"        ├─ session registry
├─ "coordinate with flexily"      ├─ resource directory
├─ "this bug is because…"         ├─ leadership leases
│                                  └─ broadcast coordination
│  ── MCP boundary ──              
│                                  Proxy (one process per session)
│  tribe_send(to, msg)             ├─ daemon client
│  bd_list(status: open)           ├─ plugin host
│  bd_create(title)                ├─ peer connections
│                                  └─ resource sockets
│  Claude makes decisions.         
│  Plugins execute them.           Plugins (loaded in proxy)
│                                  ├─ beads: readFileSync + jsonl parse
│                                  ├─ git: execSync("git log")
│                                  └─ linear: fetch() API calls
```

The MCP boundary is the clean cut. Everything below it is deterministic software. Everything above it is LLM reasoning. Plugins never need AI — they read files and return data.

## Daemon API

The daemon exposes exactly 5 operations:

```ts
// Session lifecycle
register(session: SessionInfo): { id, leadershipStatus }
heartbeat(id: string): void
unregister(id: string): void

// Discovery
discover(query: { project?, resource?, name? }): DiscoveryResult[]

// Coordination
broadcast(scope: string, message: CoordMessage): void

// Observability (fire-and-forget)
log(event: { type, project?, meta? }): void
```

No `send`, no `forward`, no `handleToolCall`. The daemon doesn't move data — it answers "where is X?" and "who has Y?".

## Daemon DB Schema

```sql
-- Session registry
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project TEXT NOT NULL,        -- "km", "decker"
  project_root TEXT,            -- absolute path
  role TEXT DEFAULT 'member',
  pid INTEGER,
  socket TEXT,                  -- peer socket path for direct connection
  heartbeat INTEGER,
  registered_at INTEGER
);

-- Resource directory
CREATE TABLE resources (
  session_id TEXT REFERENCES sessions(id),
  name TEXT NOT NULL,            -- "beads", "git"
  socket TEXT NOT NULL,          -- socket path for direct access
  capabilities TEXT,             -- JSON array: ["list","read","write"]
  PRIMARY KEY (session_id, name)
);

-- Leadership leases (per project scope)
CREATE TABLE leadership (
  project TEXT PRIMARY KEY,
  holder_session_id TEXT REFERENCES sessions(id),
  holder_name TEXT,
  lease_until INTEGER
);
```

No messages table. Messages go directly between peers — the daemon never sees them.

## Socket Layout

```
$XDG_RUNTIME_DIR/tribe/          (or ~/.local/share/tribe/ fallback)
├── daemon.sock                  # daemon discovery broker
├── daemon.db                    # session + resource registry
├── km-chief.sock                # km chief proxy peer socket
├── km-member-1234.sock          # km member proxy peer socket
├── km-beads.sock                # km beads resource socket
├── km-git.sock                  # km git resource socket
├── decker-chief.sock            # decker chief
└── decker-git.sock              # decker git resource socket
```

All sockets in one directory. Filesystem permissions provide access control — same user, same access. Socket names are `{project}-{name}.sock`.

## Plugin Loading

Plugins live in a shared location, not vendored per project:

```
~/.config/tribe/plugins/         # user plugins
vendor/bearly/plugins/           # built-in plugins
```

The proxy loads from both, running `detect(cwd)` to decide what activates. This solves version skew — all proxies use the same plugin code regardless of which project they're in.

Built-in plugins (tribe, beads, git) ship with bearly. Custom plugins (linear, github, slack) go in `~/.config/tribe/plugins/`.

## Migration

### Phase 1: Pure decoupling (this PR)
- Daemon takes resolved `--socket` and `--db`
- Remove `findBeadsDir()` from daemon
- Remove `.beads/` chmod from daemon
- Plugins move into proxy (beadsPlugin detects internally)
- Keep existing message routing temporarily
- CLI connects via daemon socket, not DB walk-up

### Phase 2: Direct peer connections
- Proxies expose peer sockets at registration
- Session-to-session messages go direct (discover + connect)
- Remove message routing from daemon
- Remove messages table from daemon DB

### Phase 3: Resource sockets
- Plugins expose resource sockets
- Resource directory in daemon DB
- Cross-project resource access via discover + direct connect
- Remove tool call forwarding from daemon

### Phase 4: Centralized plugin loading
- Plugin directory at `~/.config/tribe/plugins/`
- Dynamic detection per project cwd
- Project-scoped plugin lifecycle (start when first session appears, stop on last disconnect)

## What Gets Simpler

| Concern | Before | After |
|---------|--------|-------|
| Daemon | 800 lines, routes everything | ~200 lines, just discovery |
| Cross-project | Not possible | Discover + direct connect |
| Plugin context | Daemon cwd (wrong) | Proxy cwd (right) |
| Message routing | All through daemon | Direct peer sockets |
| Resource access | All through daemon | Direct resource sockets |
| Plugin version | Daemon's version wins | Shared plugin dir |
| Plugin crash | Kills daemon | Kills one proxy |
| Scaling | Daemon bottleneck | Peer-to-peer |
