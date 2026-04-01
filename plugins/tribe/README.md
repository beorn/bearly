# @bearly/tribe

Cross-session coordination for Claude Code. Multiple sessions discover each other, exchange messages, and coordinate work through a shared daemon.

One session becomes **chief** (coordinator); the rest are **members** (workers). Role is auto-detected — the first session becomes chief.

## Install

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "tribe": {
      "command": "bunx",
      "args": ["--bun", "@bearly/tribe"]
    }
  }
}
```

Or install globally:

```bash
npm install -g @bearly/tribe
```

## tribe watch — Live Dashboard

See all sessions, messages, and events in real time:

```bash
tribe watch
```

The watch TUI shows active sessions, recent messages, git commits, bead updates, and GitHub events in a single terminal view. Built with [Silvery](https://silvery.dev).

## Architecture

```
┌─────────────┐          ┌─────────────────┐          ┌─────────────┐
│   Chief     │──proxy──▶│  Tribe Daemon   │◀──proxy──│  Member 1   │
│  (Claude)   │          │  (Unix socket)  │          │  (Claude)   │
└─────────────┘          └────────┬────────┘          └─────────────┘
                                  │
                         ┌────────┴────────┐
                         │  tribe.db       │
                         │  (SQLite WAL)   │
                         └─────────────────┘
```

- **Daemon** — single process per project, manages sessions, routes messages, runs plugins
- **Proxy** — thin MCP server per Claude Code session, forwards tool calls to daemon via Unix socket
- **Plugins** run in the daemon (git, beads, github) and activate based on environment

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

## CLI

```bash
tribe watch           # Live TUI dashboard (sessions, messages, events)
tribe status          # Show active sessions
tribe log -f          # Follow live message stream
tribe retro --since 2h  # Retro report for last 2 hours
tribe start           # Start daemon in foreground
tribe stop            # Stop daemon
tribe reload          # Hot-reload daemon code
```

## Message Types

| Type       | Priority    | Use                           |
| ---------- | ----------- | ----------------------------- |
| `assign`   | 0 (highest) | Assign work to a member       |
| `request`  | 1           | Request approval or resources |
| `verdict`  | 2           | Approve/deny a request        |
| `query`    | 3           | Ask a question                |
| `response` | 4           | Answer a query                |
| `status`   | 5           | Status update                 |
| `notify`   | 6 (lowest)  | General notification          |

## Plugins

Plugins run in the daemon and activate automatically when their dependencies are available:

| Plugin   | Activates when       | What it does                                       |
| -------- | -------------------- | -------------------------------------------------- |
| `git`    | Inside a git repo    | Broadcasts new commits to all sessions             |
| `beads`  | `.beads/` dir exists | Broadcasts bead claims/closures                    |
| `github` | `gh auth` available  | Monitors repos, broadcasts push/PR/CI/issue events |

## License

MIT
