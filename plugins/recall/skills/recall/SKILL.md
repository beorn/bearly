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
bun tools/recall.ts "query terms"

# Raw search results (no LLM)
bun tools/recall.ts "query terms" --raw

# Build/rebuild FTS5 index
bun tools/recall.ts index [--incremental]

# Dashboard: activity + stats + index health
bun tools/recall.ts status

# List sessions or show details
bun tools/recall.ts sessions [id]

# List/search file writes
bun tools/recall.ts files [pattern]

# Recover file content from session history
bun tools/recall.ts files --restore <file>

# Daily summary
bun tools/recall.ts summarize

# Weekly summary
bun tools/recall.ts weekly

# Show specific summary
bun tools/recall.ts show <id>
```

## Output

Search results include session metadata, matching excerpts, and relevance scores. With LLM synthesis (default), results are summarized into a coherent narrative with key findings.

## Workflow

1. **Before debugging**: `bun tools/recall.ts "error message or topic"` to check prior art
2. **After fixing**: session is auto-indexed for future recall
3. **Periodic maintenance**: `bun tools/recall.ts index --incremental` to update the index

## Trigger Phrases

- "search session history"
- "what did we do about X"
- "check if this was fixed before"
- "recall previous work on"
- "recover that file"
- "session status"
