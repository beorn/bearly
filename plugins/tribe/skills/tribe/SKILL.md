---
description: "Tribe coordination — check sessions, send messages, view health/history. Use when user says /tribe."
allowed-tools: mcp__tribe__tribe_sessions, mcp__tribe__tribe_send, mcp__tribe__tribe_broadcast, mcp__tribe__tribe_history, mcp__tribe__tribe_rename, mcp__tribe__tribe_health, Bash(sqlite3:*)
---

# Tribe

Cross-session coordination. Parse the subcommand from ARGUMENTS.

## Command Mapping

| User Says                      | Action                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/tribe`                       | `tribe_sessions()` — show who's online                                                                                                                              |
| `/tribe status`                | `tribe_sessions()` + `tribe_health()` — full dashboard                                                                                                              |
| `/tribe health`                | `tribe_health()` — warnings, silent members, unread counts                                                                                                          |
| `/tribe sessions`              | `tribe_sessions()` — list active sessions                                                                                                                           |
| `/tribe sessions --all`        | `tribe_sessions(all=true)` — include dead sessions                                                                                                                  |
| `/tribe send <to> <message>`   | `tribe_send(to, message)` — send notify message                                                                                                                     |
| `/tribe assign <to> <message>` | `tribe_send(to, message, type="assign")` — assign work                                                                                                              |
| `/tribe query <to> <message>`  | `tribe_send(to, message, type="query")` — ask a question                                                                                                            |
| `/tribe broadcast <message>`   | `tribe_broadcast(message)` — message everyone                                                                                                                       |
| `/tribe history`               | `tribe_history(limit=20)` — recent messages                                                                                                                         |
| `/tribe history <name>`        | `tribe_history(with=name, limit=20)` — messages with specific session                                                                                               |
| `/tribe rename <new_name>`     | `tribe_rename(new_name)` — rename this session                                                                                                                      |
| `/tribe whoami`                | Show this session's name, role, and domains                                                                                                                         |
| `/tribe db <sql>`              | `sqlite3 <tribe-db-path> "<sql>"` — raw query                                                                                                                       |
| `/tribe log`                   | `sqlite3 <tribe-db-path> "SELECT sender, recipient, type, substr(content,1,80), datetime(ts/1000,'unixepoch','localtime') FROM messages ORDER BY ts DESC LIMIT 20"` |
| `/tribe events`                | `sqlite3 <tribe-db-path> "SELECT type, session, datetime(ts/1000,'unixepoch','localtime') FROM events ORDER BY ts DESC LIMIT 20"`                                   |
| `/tribe sync`                  | Broadcast asking all members to ensure their work is tracked (see below)                                                                                            |
| `/tribe rollcall`              | Broadcast asking all members to report name, status, and current work                                                                                               |

## Output Format

Keep output concise. For `tribe_sessions`, format as a table. For `tribe_health`, highlight warnings. For `tribe_history`, show as a chat log with timestamps.

## `/tribe sync` Protocol

Broadcast this message to all members:

```
Sync check: report your current status.

1. Your session name (/rename) and Claude session ID (echo $CLAUDE_SESSION_ID)
2. What you're working on — beads/tasks created, updated, closed this session
3. BLOCKERS: anything you're blocked on, what's blocking, and what would unblock
4. NEEDS: anything another member could help with (review, info, shared resources)
5. INFRASTRUCTURE: active worktrees, in-flight refactors, running test suites, unpublished packages, or shared config changes

Reply to chief with your summary.
```

After responses come in:

1. Summarize the results as a table for the user
2. **Cross-match blockers**: if member A is blocked on something member B could unblock, proactively suggest the assignment or send a tribe_send to coordinate
3. **Infrastructure conflicts**: check for overlapping worktrees, concurrent test runs, half-migrated code, unpublished package dependencies
4. **Suggest renames**: if a member has a generic name (member-N) but clear domain focus, suggest they `/tribe rename` to a domain name
5. Flag any tasks that have been in_progress too long without updates

## `/tribe rollcall` Protocol

Broadcast this message:

```
Roll call: please report your current session name (/rename), what you're working on, and your status (idle/busy/blocked). Reply with tribe_send to chief.
```

Collect responses and present as a table.

## Notes

- If tribe tools are not available (MCP server not loaded), tell the user to launch with: `claude --dangerously-load-development-channels server:tribe`
- `/tribe whoami` reads from the MCP server instructions (check if "chief" or "member" appears)
- The tribe DB location is determined by the server (typically `.beads/tribe.db` in the project root)
