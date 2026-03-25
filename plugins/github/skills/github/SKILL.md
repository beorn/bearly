---
description: "GitHub notifications — check events, workflow runs, PRs. Use when user says /github."
allowed-tools: mcp__github__github_status, mcp__github__github_runs, mcp__github__github_prs, Bash(gh:*)
---

# GitHub

GitHub event monitoring and queries. Parse the subcommand from ARGUMENTS.

## Command Mapping

| User Says                   | Action                                               |
| --------------------------- | ---------------------------------------------------- |
| `/github`                   | `github_status()` — recent events summary            |
| `/github status`            | `github_status()` — recent events summary            |
| `/github status <repo>`     | `github_status(repo)` — events for specific repo     |
| `/github runs`              | `github_runs()` — recent workflow runs               |
| `/github runs --failed`     | `github_runs(status="failure")` — failed runs only   |
| `/github runs --status <s>` | `github_runs(status=s)` — filter by status           |
| `/github runs <repo>`       | `github_runs(repo=repo)` — runs for specific repo    |
| `/github prs`               | `github_prs()` — open PRs                            |
| `/github prs <repo>`        | `github_prs(repo=repo)` — open PRs for specific repo |

## Output Format

Keep output concise.

- For `github_status`, show events as a timeline with timestamps and links.
- For `github_runs`, format as a table with name, status, conclusion, branch, and link. Highlight failures.
- For `github_prs`, format as a table with number, title, author, branch, draft status, and reviewers.

## Reacting to Events

Channel notifications arrive as `<channel source="github" type="..." repo="..." url="...">`.

- **Workflow failures**: These likely need immediate attention. Check the run logs and suggest fixes.
- **PR activity**: Review comments may need a response. New PRs may need review.
- **Push events**: Informational unless they conflict with current work (e.g., someone pushed to a branch you're working on).
- **Issue activity**: New issues may need triage. Closed issues may unblock work.

## Notes

- GitHub token is resolved from `GITHUB_TOKEN` env var or `gh auth token`
- Repos are auto-detected from git remote, or pass `--repos owner/repo` to the server
- Events are polled every 30s (configurable via `--poll-interval`)
- First poll sets the cursor without delivering historical events
- Workflow failures are polled separately every 60s for faster detection
