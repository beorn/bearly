# bearly

Claude Code plugins and CLI tools — coordination, testing, research, refactoring.

## Plugins

Install the marketplace, then pick the plugins you want:

```bash
# Add marketplace (one time)
claude plugin marketplace add github:beorn/bearly

# Install plugins
claude plugin install tribe@bearly      # Cross-session coordination
claude plugin install tty@bearly        # Headless terminal testing
claude plugin install llm@bearly        # Multi-LLM research
claude plugin install recall@bearly     # Session history search
claude plugin install batch-refactor@bearly  # Batch rename/refactor
claude plugin install github@bearly     # GitHub notifications
```

| Plugin                                    | Type        | What                                                                                         |
| ----------------------------------------- | ----------- | -------------------------------------------------------------------------------------------- |
| [tribe](plugins/tribe/)                   | MCP channel | Cross-session coordination — discover, message, and coordinate multiple Claude Code sessions |
| [tty](plugins/tty/)                       | MCP server  | Headless terminal testing — spawn PTY sessions, send keystrokes, capture screenshots         |
| [github](plugins/github/)                 | MCP channel | GitHub notifications — build failures, PR activity, push events as channel messages          |
| [llm](plugins/llm/)                       | CLI skill   | Multi-LLM research — deep research, second opinions, multi-model debate                      |
| [recall](plugins/recall/)                 | CLI skill   | Session history search — FTS5-indexed search with LLM synthesis and file recovery            |
| [batch-refactor](plugins/batch-refactor/) | CLI skill   | Batch rename, refactor, and migrate across files with confidence-based auto-apply            |

## CLI Tools

Available via `bun tools/<tool>.ts`:

```bash
bun tools/llm.ts ask "question"           # Ask other LLMs
bun tools/llm.ts ask --deep "topic"       # Deep research with web search
bun tools/recall.ts "query"               # Search session history
bun tools/refactor.ts --help              # Batch refactoring CLI
```

### Non-plugin tools

| Tool                | What                                           |
| ------------------- | ---------------------------------------------- |
| `tools/worktree.ts` | Git worktree management with submodule support |

## Packages

### The alien-* family — "signals for a specific shape of data"

Three sibling packages on top of [alien-signals](https://github.com/stackblitz/alien-signals). Each solves one data shape well; they compose for real apps.

| Your data is…                                          | Reach for                                                                          | What it gives you                                                                                            |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **A plain value** (cursor, count, toggle)              | [`alien-signals`](https://github.com/stackblitz/alien-signals) _(upstream)_        | The primitive. `signal(value)`, `computed(fn)`, `effect(fn)`. Everything below builds on this.               |
| **A list that changes over time** (rows, cards, todos) | [`alien-projections`](packages/alien-projections/)                                 | `createProjection(list, { key, map, filter, sort })` — when one row changes, only that row re-computes.      |
| **An async fetch** (API call, file load, DB query)     | [`alien-resources`](packages/alien-resources/)                                     | `createResource(fetcher)` — `.loading()` / `.error()` / `.refetch()` + auto-cancels stale requests.          |
| **A tree / hierarchy** (folders, outlines, nested UI)  | [`alien-trees`](packages/alien-trees/)                                             | `createTree(...)` — "does any descendant have X?" / "inherit Y from any ancestor?" in O(1).                  |

A list of async-fetched trees of plain values uses all four together. For React apps, [`@silvery/signals`](https://silvery.dev) bundles the whole family + hooks.

### Other

| Package                                              | What                                                  |
| ---------------------------------------------------- | ----------------------------------------------------- |
| [vitest-silvery-dots](packages/vitest-silvery-dots/) | Streaming dot reporter for Vitest, built with Silvery |

## Development

```bash
bun install
bun run typecheck
```

### As a git submodule

```bash
git submodule add git@github.com:beorn/bearly.git vendor/bearly
```

## License

MIT
