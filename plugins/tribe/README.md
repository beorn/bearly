# @bearly/tribe

Cross-session coordination for Claude Code. Multiple sessions discover each other, exchange messages, and coordinate work through a shared daemon.

One session becomes **chief** (coordinator); the rest are **members** (workers). Role is auto-detected — the first session becomes chief.

## Domain model

A **tribe** is the set of Claude Code sessions working together on a project. Each session joins as a **member**. One member at a time is the **chief** (coordinator). Members communicate over **wire** — the real-time signals carried by the tribe's **daemon** — and draw on shared **lore** — the accumulated memory of everything the tribe has done together.

| Concept       | Definition                                                                                                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **tribe**     | The set of Claude Code sessions working together on a project. A tribe forms around one daemon and persists as long as the daemon runs.                                                   |
| **member**    | Any Claude Code session that has joined the tribe. Peer to other members; identity keyed by claude pid + session id.                                                                      |
| **chief**     | The coordinating member. Plans, delegates, and stays responsive to the human. Role is auto-elected (first member in) but can be handed off. A member is not always a chief.               |
| **agent**     | A sub-process a member spawns to do scoped work (an `Agent` tool call, `/max` teammate, worktree worker). Agents serve the spawning member; they are not tribe members themselves.        |
| **daemon**    | The long-lived per-user process that hosts the tribe. Carries wire traffic; stores lore. Exactly one per project.                                                                         |
| **wire**      | Real-time signals among members: presence (heartbeats), broadcasts, events (git commits, bead updates, GitHub notifications), channel pub/sub. What travels between members _now_.        |
| **lore**      | Accumulated memory: session history (FTS-indexed), focus state, LLM-derived summaries, hook-dedup state. What the tribe _remembers_. Lives inside `@bearly/tribe` as the memory daemon.   |
| **recall**    | The action of searching lore. `bun recall "query"` is how a member retrieves lore. Same verb as everyday English — you recall a memory, the tribe recalls its lore.                       |
| **plugin**    | Optional capabilities that run in the daemon and activate based on environment: `git`, `beads`, `github`, `health`, `accountly`. Plugins emit events onto the wire and may write to lore. |
| **channel**   | A pub/sub topic on the wire. Members subscribe to receive pushed messages of that type.                                                                                                   |
| **broadcast** | A message sent to every alive member on a channel.                                                                                                                                        |
| **heartbeat** | Periodic liveness signal a member sends to the daemon. Members that stop heartbeating are marked stale.                                                                                   |

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

`@bearly/tribe` is a single package containing the coordination layer, memory daemon, wire protocol, MCP tools, CLI, watch TUI, and plugins. Everything a tribe of Claude Code sessions needs to work together — presence, broadcasts, events, focus cache, LLM summaries, per-session hook dedup — lives in this one package.

`@bearly/recall` is a separate companion package providing the FTS search primitive that tribe uses internally for session-history lookup; it can also be used standalone (e.g., `bun recall "query"` from the CLI).

`@bearly/llm` is an independent multi-provider LLM dispatcher (cheap-model race, consensus, deep research) that `@bearly/recall` uses internally for its planner/agent.

History: lore started as its own package in April 2026 (renamed from `@bearly/bear`); folded back into `@bearly/tribe` the same month once the concepts stabilized.

## Design principles

Three invariants the tribe system is designed to guarantee. They shape every lifecycle decision — when daemons start, how sessions connect, who holds the chief role — so the user never has to think about the coordination layer.

### 1. Agents come and go — auto-connecting every time

Sessions are transient by nature: a Claude Code window opens, does work, closes; a sub-agent spawns for a task and exits; a worktree session runs for ten minutes. The tribe accommodates all of this without ceremony. There is no "register" step, no manual join, no explicit leave.

- **Arrival**: starting a Claude Code session is enough. The tribe MCP loads, the proxy connects to the daemon, and if the daemon isn't running the `SessionStart` hook spawns it on demand.
- **Reconnection**: if the daemon restarts mid-session (crash, hot-reload), the proxy reconnects transparently on the next tool call. No manual `tribe restart`, no lost MCP registration.
- **Departure**: closing the terminal is enough. The socket closes, the daemon notices, the session is marked gone. No cleanup call required.
- **Return**: reopening later — with the same Claude Code session id, same working directory, or same explicit name — the session rejoins the tribe and resumes its identity.

The tribe treats churn as the default case, not an edge case. Steady state: the user forgets the daemon exists. Degraded state: it self-heals.

### 2. There is always a chief

While at least one session is connected, one of them is the chief. No "empty throne," no "lease expired 12 days ago" state. Resolution order:

1. **Claimed chief** — if a session has explicitly claimed the role (`tribe.claim-chief`), they hold it for as long as they're connected.
2. **Derived chief** — otherwise, the longest-running connected session is chief by definition.
3. **Release** — `tribe.release-chief` steps down; derivation picks the next in line automatically.

No election protocol, no periodic lease renewal, no auto-promotion after grace window. The chief is a derived property of the connection set plus an optional claim — not an independent state machine that can desync from reality.

### 3. Daemons are spun up and down automatically

Manual daemon lifecycle is not part of normal use. `tribe start`, `tribe stop`, `tribe reload` exist for troubleshooting but should rarely be needed.

- **Spin up**: on first demand (SessionStart hook → `ensureAllDaemonsIfConfigured` → detached spawn). The user's very first Claude Code session of the day brings the tribe up.
- **Stay up**: the daemon persists across Claude sessions so state, history, and in-flight messaging survive. Cost of staying resident is ~5 MB RAM.
- **Spin down**: auto-quit after very long idle (30 min default; `--quit-timeout -1` disables). Crash recovery is the next SessionStart hook.

The autostart config (`~/.claude/tribe/config.json` — values `daemon` / `library` / `never`) lets users override if they prefer to manage lifecycle themselves.

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
tribe watch             # Live TUI dashboard (sessions, messages, events)
tribe status            # Show active sessions
tribe log -f            # Follow live message stream
tribe retro --since 2h  # Retro report for last 2 hours
tribe start             # Start daemon in foreground
tribe stop              # Stop daemon
tribe reload            # Hot-reload daemon code
tribe install           # Install Claude Code SessionStart/SessionEnd hooks
tribe hook session-start  # Hook entry point (run by Claude Code)
tribe hook session-end    # Hook entry point (run by Claude Code)
tribe uninstall         # Remove installed hooks
tribe doctor            # Verify daemon + MCP + hooks + env
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
