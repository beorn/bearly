# tribe

Cross-session coordination for Claude Code. Multiple sessions discover each other, exchange messages, and coordinate work through a shared daemon.

One session becomes **chief** (coordinator); the rest are **members** (workers). Role is auto-detected — the first session becomes chief.

## Install

```bash
# As a Claude Code plugin
claude plugin install tribe@bearly

# Launch with channel support (required during research preview)
claude --dangerously-load-development-channels server:tribe
```

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
- **Direct peer messaging** — proxies can send messages directly to each other for lower latency
- **Plugins** run in the daemon (git, beads, github) and activate based on environment
- **DB** at `~/.local/share/tribe/tribe.db` (user-level default), or `.beads/tribe.db` if present

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
tribe status          # Show active sessions
tribe log -f          # Follow live message stream
tribe retro --since 2h  # Retro report for last 2 hours
tribe watch           # Full TUI dashboard
tribe start           # Start daemon in foreground
tribe stop            # Stop daemon
tribe reload          # Hot-reload daemon code (SIGHUP)
```

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

## Plugins

Plugins run in the daemon and activate automatically when their dependencies are available:

| Plugin   | Activates when       | What it does                                                |
| -------- | -------------------- | ----------------------------------------------------------- |
| `git`    | Inside a git repo    | Broadcasts new commits to all sessions                      |
| `beads`  | `.beads/` dir exists | Broadcasts bead claims/closures                             |
| `github` | `gh auth` available  | Monitors repos, broadcasts push/PR/CI/issue events          |

## Configuration

```bash
# CLI args
bun server.ts --name silvery --role member --domains silvery,flexily

# Environment
TRIBE_NAME=silvery TRIBE_ROLE=member TRIBE_DOMAINS=silvery,flexily
```

## npm

Published as [`@bearly/tribe`](https://www.npmjs.com/package/@bearly/tribe) on npm.

## License

MIT
