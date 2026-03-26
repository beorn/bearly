# tribe

Cross-session coordination for Claude Code. Multiple sessions discover each other, exchange messages, and coordinate work via a shared SQLite bus.

One session becomes **chief** (coordinator); the rest are **members** (workers). Role is auto-detected — the first session becomes chief.

## Install

```bash
# As a Claude Code plugin
claude plugin install tribe@bearly

# Launch with channel support (required during research preview)
claude --dangerously-load-development-channels server:tribe
```

## How it works

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Chief     │────▶│  .beads/tribe.db │◀────│  Member 1   │
│  (session)  │     │   SQLite WAL     │     │  (session)  │
└─────────────┘     └──────────────────┘     └─────────────┘
                           ▲
                    ┌──────┘
               ┌─────────────┐
               │  Member 2   │
               │  (session)  │
               └─────────────┘
```

- **SQLite WAL** as shared message bus — no daemon, handles concurrent access
- **MCP channels** push messages into Claude Code's context as `<channel>` tags
- **Per-session read tracking** — broadcasts aren't marked "read" globally
- **Priority ordering** — assign > request > query > status > notify
- **PID liveness checking** — dead sessions auto-pruned
- **Heartbeat** every 10s for liveness detection

## Commands

Once installed, use `/tribe` in Claude Code:

| Command                    | What                               |
| -------------------------- | ---------------------------------- |
| `/tribe`                   | Show who's online                  |
| `/tribe status`            | Full dashboard (sessions + health) |
| `/tribe send <to> <msg>`   | Send a message                     |
| `/tribe assign <to> <msg>` | Assign work                        |
| `/tribe broadcast <msg>`   | Message everyone                   |
| `/tribe sync`              | Ask all members to report status   |
| `/tribe rollcall`          | Quick roll call                    |
| `/tribe history`           | Recent messages                    |
| `/tribe rename <name>`     | Rename this session                |

## Message types

| Type       | Priority    | Use                           |
| ---------- | ----------- | ----------------------------- |
| `assign`   | 0 (highest) | Assign work to a member       |
| `request`  | 1           | Request approval or resources |
| `verdict`  | 2           | Approve/deny a request        |
| `query`    | 3           | Ask a question                |
| `response` | 4           | Answer a query                |
| `status`   | 5           | Status update                 |
| `notify`   | 6 (lowest)  | General notification          |

## Roles

Role is auto-detected: the first session to join becomes **chief**; subsequent sessions become **members**. Override with `--role chief` or `--role member`.

### Chief (coordinator)

The chief routes work, tracks progress, and keeps the user informed. It does not do implementation work itself. Responsibilities:

- **Route work** to members by matching their registered domains
- **Track status** by periodically querying members and aggregating responses
- **Detect dead members** and release their bead claims
- **Prevent conflicts** by serializing access to shared files (package.json, tsconfig, etc.)
- **Relay user messages** (e.g., from Telegram) to the right member

See `skills/tribe/chief.md` for full instructions.

### Member (worker)

Members do the actual implementation work. They coordinate with chief, not each other. Responsibilities:

- **Report status** when claiming beads, committing, getting blocked, or becoming available
- **Ask before editing shared files** — chief serializes access to prevent merge conflicts
- **Report infrastructure changes** — multi-file refactors, worktree creation, dependency additions
- **Respond to queries promptly** — chief needs timely status to coordinate effectively

See `skills/tribe/member.md` for full instructions.

## Plugin Architecture

Tribe has a plugin system for optional capabilities that activate based on the environment.

### Standalone operation

Tribe works without beads or any other external dependency. The database location is resolved in order:

1. `--db` flag or `TRIBE_DB` env var (explicit path)
2. `.beads/tribe.db` (if a `.beads/` directory exists in the project tree)
3. `~/.local/share/tribe/tribe.db` (standalone fallback)

### Built-in plugins

Plugins activate automatically when their dependencies are available:

| Plugin  | Activates when       | What it does                                    |
| ------- | -------------------- | ----------------------------------------------- |
| `git`   | Inside a git repo    | Reports new commits to chief every 30s          |
| `beads` | `.beads/` dir exists | Reports bead claims/closures to chief every 30s |

If a plugin's dependencies aren't present, it silently disables itself -- no configuration needed.

### Custom plugins

Implement the `TribePlugin` interface from `tools/lib/tribe/plugins.ts`:

```typescript
interface TribePlugin {
  name: string
  available(): boolean
  start?(ctx: PluginContext): (() => void) | void
  instructions?(): string
}
```

Add your plugin to the plugins array in `tools/tribe.ts` alongside the built-in ones.

## Configuration

The server auto-detects role and name. Override via CLI args or env vars:

```bash
# CLI args
bun server.ts --name silvery --role member --domains silvery,flexily

# Environment
TRIBE_NAME=silvery TRIBE_ROLE=member TRIBE_DOMAINS=silvery,flexily
```

## npm

Published as [`tribe-wire`](https://www.npmjs.com/package/tribe-wire) on npm.

## License

MIT
