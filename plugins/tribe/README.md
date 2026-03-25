# tribe

Cross-session coordination for Claude Code. Multiple sessions discover each other, exchange messages, and coordinate work via a shared SQLite bus.

One session becomes **chief** (coordinator); the rest are **members** (workers). Role is auto-detected — the first session becomes chief.

## Install

```bash
# As a Claude Code plugin
claude plugin install tribe@beorn-tools

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
