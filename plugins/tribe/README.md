# @bearly/tribe

Cross-session coordination for Claude Code. Multiple sessions discover each other, exchange messages, and coordinate work through a shared daemon.

One session becomes **chief** (coordinator); the rest are **members** (workers). Role is auto-detected — the first session becomes chief.

## Domain model

A **tribe** is the set of Claude Code sessions working together on a project. Each session joins as a **member**. One member at a time is the **chief** (coordinator). Members communicate over **wire** — the real-time signals carried by the tribe's **daemon** — and draw on shared **lore** — the accumulated memory of everything the tribe has done together.

| Concept | Definition |
| --- | --- |
| **tribe** | The set of Claude Code sessions working together on a project. A tribe forms around one daemon and persists as long as the daemon runs. |
| **member** | Any Claude Code session that has joined the tribe. Peer to other members; identity keyed by claude pid + session id. |
| **chief** | The coordinating member. Plans, delegates, and stays responsive to the human. Role is auto-elected (first member in) but can be handed off. A member is not always a chief. |
| **agent** | A sub-process a member spawns to do scoped work (an `Agent` tool call, `/max` teammate, worktree worker). Agents serve the spawning member; they are not tribe members themselves. |
| **daemon** | The long-lived per-user process that hosts the tribe. Carries wire traffic; stores lore. Exactly one per project. |
| **wire** | Real-time signals among members: presence (heartbeats), broadcasts, events (git commits, bead updates, GitHub notifications), channel pub/sub. What travels between members *now*. |
| **lore** | Accumulated memory: session history (FTS-indexed), focus state, LLM-derived summaries, hook-dedup state. What the tribe *remembers*. The `@bearly/lore` package (formerly `@bearly/bear`). |
| **recall** | The action of searching lore. `bun recall "query"` is how a member retrieves lore. Same verb as everyday English — you recall a memory, the tribe recalls its lore. |
| **plugin** | Optional capabilities that run in the daemon and activate based on environment: `git`, `beads`, `github`, `health`, `accountly`. Plugins emit events onto the wire and may write to lore. |
| **channel** | A pub/sub topic on the wire. Members subscribe to receive pushed messages of that type. |
| **broadcast** | A message sent to every alive member on a channel. |
| **heartbeat** | Periodic liveness signal a member sends to the daemon. Members that stop heartbeating are marked stale. |

### How the concepts fit together

```
                                 The tribe
                                     │
                ┌────────────────────┼────────────────────┐
                │                    │                    │
           Member (chief)        Member               Member
                │                    │                    │
                └────── wire ────────┴────── wire ────────┘
                              (broadcasts,
                            events, presence)
                                     │
                                     ▼
                             ┌───────────────┐
                             │    daemon     │
                             │               │
                             │     lore      │ ← searched via `recall`
                             │  (memory)     │
                             └───────────────┘

A chief may spawn agents (short-lived sub-processes) to run parallel work.
Agents are not tribe members; they serve the chief and terminate when done.
```

### Packages

| Package | What it holds |
| --- | --- |
| `@bearly/tribe` | The coordination layer — daemon, wire protocol, MCP proxy, CLI, watch TUI, plugins. This package. |
| `@bearly/lore` | The memory layer — FTS-indexed session history, focus cache, LLM summaries, per-session hook dedup. Formerly `@bearly/bear`. |

The two packages compose: `@bearly/lore` is consumed by `@bearly/tribe`'s daemon to give the tribe memory. They may merge into one runtime process over time; the package split is by domain, not by deployment.


## Install

The recommended way is as a Claude Code plugin from the `bearly` marketplace. This installs tribe globally across every project, so you don't need per-project `.mcp.json` entries.

```bash
claude plugin install tribe@bearly
```

Then launch Claude Code with the channel flag so asynchronous messages (session join/leave, broadcasts, daemon notifications) can be pushed into your session:

```bash
claude --dangerously-load-development-channels plugin:tribe@bearly
```

A convenient wrapper for your shell:

```zsh
claude() { command claude "$@" --dangerously-load-development-channels plugin:tribe@bearly }
```

Without the flag, tribe's MCP tools still work (you can send messages and query state), but you won't _receive_ pushed messages from other sessions or the daemon.

### Alternatives

Per-project MCP install (legacy, no channel push):

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

Or install the CLI on its own:

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
