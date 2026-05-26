---
description: "Tribe coordination — check sessions, send messages, view health/history. Use when user says /tribe."
allowed-tools: mcp__tribe__tribe.members, mcp__tribe__tribe.send, mcp__tribe__tribe.fetch, mcp__tribe__tribe.rename, mcp__tribe__tribe.health, Bash(sqlite3:*)
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
| `/tribe broadcast <message>`   | `tribe.send(to="*", message)` — message everyone                                                                                                                    |
| `/tribe history`               | `tribe.fetch(since=0, limit=20)` — recent visible messages                                                                                                          |
| `/tribe history <name>`        | `tribe.fetch(with=name, limit=20)` — messages with specific session                                                                                                 |
| `/tribe rename <new_name>`     | `tribe.rename(new_name)` — rename this session                                                                                                                      |
| `/tribe whoami`                | Show this session's name, role, and domains                                                                                                                         |
| `/tribe db <sql>`              | `sqlite3 <tribe-db-path> "<sql>"` — raw query                                                                                                                       |
| `/tribe log`                   | `sqlite3 <tribe-db-path> "SELECT sender, recipient, type, substr(content,1,80), datetime(ts/1000,'unixepoch','localtime') FROM messages ORDER BY ts DESC LIMIT 20"` |
| `/tribe events`                | `sqlite3 <tribe-db-path> "SELECT type, sender, datetime(ts/1000,'unixepoch','localtime') FROM messages WHERE kind = 'event' ORDER BY ts DESC LIMIT 20"`             |
| `/tribe sync`                  | Broadcast asking all members to ensure their work is tracked (see below)                                                                                            |
| `/tribe rollcall`              | Broadcast asking all members to report name, status, and current work                                                                                               |

## Output Format

Keep output concise. For `tribe.members`, format as a table. For `tribe.health`, highlight warnings. For `tribe.fetch`, show as a chat log with timestamps.

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

## Delivery modes — `push` vs `pull`

Each session declares a delivery mode at join time. The daemon routes broadcasts and DMs accordingly. **Senders stay transport-blind** — `tribe.send({to: "codex1", message: "..."})` works the same regardless of how the recipient receives it.

| Mode     | When to declare                                                                         | How it works                                                                               |
| -------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **push** | Default. Claude Code, Agent SDK, or any client with an MCP notification-channel reader. | Daemon fans events out on the MCP channel; client sees them as `<channel source="tribe">`. |
| **pull** | Codex, Gemini, or any MCP-only client without a notification reader.                    | Events queue in SQLite; client drains via `tribe.fetch`.                                   |

**How to declare on join.** Pass `delivery: "push" | "pull"` to `tribe.join`. The stdio-adapter auto-detects Codex Desktop / `TRIBE_PROVIDER=codex|gemini` and joins as pull; Claude Code stays push. `TRIBE_DELIVERY=push|pull` is the explicit override for hosts the adapter cannot identify.

**Unknown MCP-only host example**:

```toml
[mcp_servers.tribe.env]
TRIBE_DELIVERY = "pull"
```

**Draining in pull mode.** `tribe.fetch()` is the canonical "give me my events" call — returns all broadcasts + DMs received since the session's last cursor and advances that cursor in default drain mode.

**Watch clients** (`tribe-watch`, `tribe-cli` log/events) always receive push regardless of the recipient's declared mode — the per-session toggle only gates _agent-bound_ fanout.

**Future arc.** Once silvercode squad mode lands, it will wrap codex/gemini sessions and re-advertise them as push by proxying the notification channel through the host. Pull is the transitional fallback for MCP-only clients today; long-term the host owns the channel and squad members go back to push.

**Internals** (for daemon work): per-session delivery lives in `sessions.delivery` (schema v12, NOT NULL DEFAULT `'push'`). The fanout filter is in `tools/lib/tribe/compose/with-broadcast.ts` — `toConnected` skips socket fanout for pull-mode recipients.

## Topic Trust Tiers

The canonical topic-to-trust registry lives in `vendor/bearly/tools/lib/tribe/trust.ts` and is exported through `@bearly/tribe-client` for prompt adapters. Unknown topics fail closed to `external`.

| Topic glob   | Trust tier | Treatment                                                    |
| ------------ | ---------- | ------------------------------------------------------------ |
| `tribe.send` | `internal` | Rostered peer messages: sanitized, length-capped, fenced     |
| `daemon:*`   | `daemon`   | Daemon lifecycle/session events: fenced                      |
| `health:*`   | `daemon`   | Daemon health/account/reaper/git-lock events: fenced         |
| `bead:*`     | `internal` | Local bead observer events: sanitized, length-capped, fenced |
| `git:commit` | `external` | ID-only stub by default                                      |
| `github:*`   | `external` | ID-only stub by default                                      |
| `ci:*`       | `external` | ID-only stub by default                                      |
