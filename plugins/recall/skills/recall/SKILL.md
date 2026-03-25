---
name: recall
description: "Session history search — search past Claude Code sessions, synthesize findings, recover files. Use when user says /recall."
allowed-tools: Bash, Read
---

# Recall Skill

Search past Claude Code session history with FTS5 indexing and optional LLM synthesis.

## When to Use

- Before theorizing about a bug -- check if prior sessions already diagnosed it
- Recovering file content from past sessions
- Finding what was discussed/decided about a topic
- Checking session activity and index health

## Commands

```bash
# Search with LLM synthesis (default)
bunx @beorn/tools recall "query terms"

# Raw search results (no LLM)
bunx @beorn/tools recall "query terms" --raw

# Build/rebuild FTS5 index
bunx @beorn/tools recall index [--incremental]

# Dashboard: activity + stats + index health
bunx @beorn/tools recall status

# List sessions or show details
bunx @beorn/tools recall sessions [id]

# List/search file writes
bunx @beorn/tools recall files [pattern]

# Recover file content from session history
bunx @beorn/tools recall files --restore <file>

# Daily summary
bunx @beorn/tools recall summarize

# Weekly summary
bunx @beorn/tools recall weekly

# Show specific summary
bunx @beorn/tools recall show <id>
```

## Output

Search results include session metadata, matching excerpts, and relevance scores. With LLM synthesis (default), results are summarized into a coherent narrative with key findings.

## Workflow

1. **Before debugging**: `bunx @beorn/tools recall "error message or topic"` to check prior art
2. **After fixing**: session is auto-indexed for future recall
3. **Periodic maintenance**: `bunx @beorn/tools recall index --incremental` to update the index

## Trigger Phrases

- "search session history"
- "what did we do about X"
- "check if this was fixed before"
- "recall previous work on"
- "recover that file"
- "session status"
