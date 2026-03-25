# recall

Session history search for Claude Code. FTS5-indexed search across past sessions with LLM synthesis and file recovery.

## Install

```bash
claude plugin install recall@bearly
```

## Commands

```bash
# Search with LLM synthesis (default)
bun tools/recall.ts "query terms"

# Raw search results (no LLM)
bun tools/recall.ts "query" --raw

# Build/rebuild FTS5 index
bun tools/recall.ts index [--incremental]

# Dashboard: activity + stats + index health
bun tools/recall.ts status

# List sessions or show details
bun tools/recall.ts sessions [id]

# List/search file writes
bun tools/recall.ts files [pattern]

# Recover file content
bun tools/recall.ts files --restore <file>

# Daily/weekly summaries
bun tools/recall.ts summarize
bun tools/recall.ts weekly
```

## How it works

1. Claude Code session transcripts are indexed into a SQLite FTS5 database
2. Searches match against messages, tool calls, and file contents
3. LLM synthesis (optional) summarizes results into a coherent narrative
4. File recovery extracts written file contents from past sessions

## When to use

- Before debugging — check if prior sessions already diagnosed the problem
- Recovering file content from past sessions
- Finding what was discussed or decided about a topic
- Checking session activity and index health

## License

MIT
