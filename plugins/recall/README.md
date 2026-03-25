# recall

Session history search for Claude Code. FTS5-indexed search across past sessions with LLM synthesis and file recovery.

## Install

```bash
claude plugin install recall@beorn-tools
```

## Commands

```bash
# Search with LLM synthesis (default)
bunx @beorn/tools recall "query terms"

# Raw search results (no LLM)
bunx @beorn/tools recall "query" --raw

# Build/rebuild FTS5 index
bunx @beorn/tools recall index [--incremental]

# Dashboard: activity + stats + index health
bunx @beorn/tools recall status

# List sessions or show details
bunx @beorn/tools recall sessions [id]

# List/search file writes
bunx @beorn/tools recall files [pattern]

# Recover file content
bunx @beorn/tools recall files --restore <file>

# Daily/weekly summaries
bunx @beorn/tools recall summarize
bunx @beorn/tools recall weekly
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
