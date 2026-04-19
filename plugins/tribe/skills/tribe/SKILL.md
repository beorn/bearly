---
description: "Tribe coordination — check sessions, send messages, view health/history. Use when user says /tribe."
allowed-tools: mcp__tribe__tribe.members, mcp__tribe__tribe.send, mcp__tribe__tribe.broadcast, mcp__tribe__tribe.history, mcp__tribe__tribe.rename, mcp__tribe__tribe.health, Bash(sqlite3:*)
---

# Tribe

Cross-session coordination. Parse the subcommand from ARGUMENTS.

## Command Mapping

| User Says                      | Action                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/tribe`                       | `tribe.members()` — show who's online                                                                                                                               |
| `/tribe status`                | `tribe.members()` + `tribe.health()` — full dashboard                                                                                                               |
| `/tribe health`                | `tribe.health()` — warnings, silent members, unread counts                                                                                                          |
| `/tribe sessions`              | `tribe.members()` — list active sessions                                                                                                                            |
| `/tribe sessions --all`        | `tribe.members(all=true)` — include dead sessions                                                                                                                   |
| `/tribe send <to> <message>`   | `tribe.send(to, message)` — send notify message                                                                                                                     |
| `/tribe assign <to> <message>` | `tribe.send(to, message, type="assign")` — assign work                                                                                                              |
| `/tribe query <to> <message>`  | `tribe.send(to, message, type="query")` — ask a question                                                                                                            |
| `/tribe broadcast <message>`   | `tribe.broadcast(message)` — message everyone                                                                                                                       |
| `/tribe history`               | `tribe.history(limit=20)` — recent messages                                                                                                                         |
| `/tribe history <name>`        | `tribe.history(with=name, limit=20)` — messages with specific session                                                                                               |
| `/tribe rename <new_name>`     | `tribe.rename(new_name)` — rename this session                                                                                                                      |
| `/tribe whoami`                | Show this session's name, role, and domains                                                                                                                         |
| `/tribe db <sql>`              | `sqlite3 <tribe-db-path> "<sql>"` — raw query                                                                                                                       |
| `/tribe log`                   | `sqlite3 <tribe-db-path> "SELECT sender, recipient, type, substr(content,1,80), datetime(ts/1000,'unixepoch','localtime') FROM messages ORDER BY ts DESC LIMIT 20"` |
| `/tribe events`                | `sqlite3 <tribe-db-path> "SELECT type, sender, datetime(ts/1000,'unixepoch','localtime') FROM messages WHERE kind = 'event' ORDER BY ts DESC LIMIT 20"`             |
| `/tribe sync`                  | Broadcast asking all members to ensure their work is tracked (see below)                                                                                            |
| `/tribe rollcall`              | Broadcast asking all members to report name, status, and current work                                                                                               |

## Output Format

Keep output concise. For `tribe.members`, format as a table. For `tribe.health`, highlight warnings. For `tribe.history`, show as a chat log with timestamps.

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
2. **Cross-match blockers**: if member A is blocked on something member B could unblock, proactively suggest the assignment or send a tribe.send to coordinate
3. **Infrastructure conflicts**: check for overlapping worktrees, concurrent test runs, half-migrated code, unpublished package dependencies
4. **Suggest renames**: if a member has a generic name (member-N) but clear domain focus, suggest they `/tribe rename` to a domain name
5. Flag any tasks that have been in_progress too long without updates

## `/tribe rollcall` Protocol

Broadcast this message:

```
Roll call: please report your current session name (/rename), what you're working on, and your status (idle/busy/blocked). Reply with tribe.send to chief.
```

Collect responses and present as a table.

## Notes

- If tribe tools are not available (MCP server not loaded), tell the user to launch with: `claude --dangerously-load-development-channels server:tribe`
- `/tribe whoami` reads from the MCP server instructions (check if "chief" or "member" appears)
- The tribe DB is at `~/.local/share/tribe/tribe.db` (user-level default). Legacy `.beads/tribe.db` is auto-migrated to the XDG path on first daemon start after upgrade. Override via `--db` flag or `TRIBE_DB` env.
