# github

GitHub notifications for Claude Code. Push events, PR activity, workflow failures, and issue changes delivered as channel messages.

## Install

```bash
# As a Claude Code plugin
claude plugin install github@bearly

# Launch with channel support (required during research preview)
claude --dangerously-load-development-channels server:github
```

## How it works

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│ Claude Code  │◀────│  MCP Channel     │◀────│  GitHub API  │
│  (session)   │     │  (polls every    │     │  (REST v3)   │
└─────────────┘     │   30 seconds)    │     └──────────────┘
                    └──────────────────┘
                           │
                    ┌──────┘
               ┌──────────────────┐
               │ .beads/          │
               │ github-cursor.json│
               └──────────────────┘
```

- **GitHub REST API** polled for repo events, workflow runs, and PR activity
- **MCP channels** push notifications into Claude Code's context as `<channel>` tags
- **Cursor persistence** in `.beads/github-cursor.json` — only new events delivered
- **Auto-detect repo** from git remote URL in cwd
- **Token resolution**: `GITHUB_TOKEN` env var, then `gh auth token`

## Events monitored

| Type          | Channel tag `type=` | What                                     |
| ------------- | ------------------- | ---------------------------------------- |
| Push events   | `push`              | New commits pushed to branches           |
| Workflow runs | `workflow`          | CI/CD completions (failures highlighted) |
| Pull requests | `pr`                | Opened, merged, reviewed, commented      |
| Issues        | `issue`             | Opened, closed, assigned, commented      |

## Commands

Once installed, use `/github` in Claude Code:

| Command                 | What                        |
| ----------------------- | --------------------------- |
| `/github`               | Recent events summary       |
| `/github status`        | Recent events summary       |
| `/github runs`          | Workflow runs               |
| `/github runs --failed` | Failed runs only            |
| `/github prs`           | Open PRs with review status |

## Tools

| Tool            | Description                                  |
| --------------- | -------------------------------------------- |
| `github_status` | Recent events summary across monitored repos |
| `github_runs`   | Workflow runs (filter by status/conclusion)  |
| `github_prs`    | Open PRs with review status                  |

## Configuration

```bash
# CLI args
bun server.ts --repos beorn/km,beorn/bearly --poll-interval 30 --events push,workflow_run,pull_request,issues

# Environment
GITHUB_REPOS=beorn/km GITHUB_POLL_INTERVAL=30 GITHUB_EVENTS=push,workflow_run
```

| Option            | Default                                 | Description                |
| ----------------- | --------------------------------------- | -------------------------- |
| `--repos`         | Auto-detect from git remote             | Comma-separated owner/repo |
| `--poll-interval` | 30                                      | Seconds between polls      |
| `--events`        | `push,workflow_run,pull_request,issues` | Event types to monitor     |

## License

MIT
