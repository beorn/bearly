# bearly

Claude Code plugins and CLI tools — coordination, testing, research, refactoring.

## Plugins

Install the marketplace, then pick the plugins you want:

```bash
# Add marketplace (one time)
claude plugin marketplace add beorn/bearly

# Install plugins
claude plugin install tribe@bearly            # Cross-session coordination
claude plugin install llm@bearly              # Multi-LLM research
claude plugin install recall@bearly           # Session history search
claude plugin install batch-refactor@bearly   # Batch rename/refactor
claude plugin install github@bearly           # GitHub notifications
```

| Plugin                                    | Type        | What                                                                                         |
| ----------------------------------------- | ----------- | -------------------------------------------------------------------------------------------- |
| [tribe](plugins/tribe/)                   | MCP channel | Cross-session coordination — discover, message, and coordinate multiple Claude Code sessions |
| [github](plugins/github/)                 | MCP channel | GitHub notifications — build failures, PR activity, push events as channel messages          |
| [llm](plugins/llm/)                       | CLI skill   | Multi-LLM research — deep research, second opinions, multi-model debate                      |
| [recall](plugins/recall/)                 | CLI skill   | Session history search — FTS5-indexed search with LLM synthesis and file recovery            |
| [batch-refactor](plugins/batch-refactor/) | CLI skill   | Batch rename, refactor, and migrate across files with confidence-based auto-apply            |

The marketplace is defined by [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json); each
listed plugin carries its own [`.claude-plugin/plugin.json`](plugins/tribe/.claude-plugin/plugin.json)
manifest, which is the source of truth for that plugin's version.

### Two install routes

Tribe (and any other MCP-channel plugin) can be wired into Claude Code two ways — **one source, two routes**:

- **Marketplace route** — for external users. `claude plugin marketplace add beorn/bearly` then
  `claude plugin install tribe@bearly`. Claude Code resolves the plugin from this repo and caches it.
- **Inline `.mcp.json` route** — for developers who vendor bearly as a git submodule. The host repo's
  `.mcp.json` points an `mcpServers` entry directly at `vendor/bearly/plugins/tribe/server.ts`. This
  always tracks the vendored submodule commit — no marketplace cache to go stale. (km uses this route.)
  The plugin's `server.ts` is a thin wrapper that imports `@bearly/tribe-client/stdio`; the stdio
  adapter runtime ships in the published `@bearly/tribe-client` npm package — no committed bundle.

Do not enable both routes for the same plugin in one project — two `tribe` MCP registrations shadow
each other, and the cached marketplace copy can drift from the vendored source.

### Internal plugins (not in the marketplace)

Some directories under `plugins/` are **internal-only** — libraries or folded-away tools, not
installable Claude Code plugins. They have no `.claude-plugin/plugin.json` and are intentionally
absent from `marketplace.json`:

| Directory                    | Status                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `plugins/injection-envelope` | Internal library (`@bearly/injection-envelope`, `private`) — prompt-injection defense             |
| `plugins/shared-mcp`         | Internal library (`@bearly/shared-mcp`, `private`) — shared MCP wire used by tribe etc.           |
| `plugins/tty`                | Retired — terminal-testing MCP folded into `termless mcp` (`@termless/cli`); no longer ships here |

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

### The alien-\* family — "signals for a specific shape of data"

Three sibling packages on top of [alien-signals](https://github.com/stackblitz/alien-signals). Each solves one data shape well; they compose for real apps.

| Your data is…                                          | Reach for                                                                   | What it gives you                                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **A plain value** (cursor, count, toggle)              | [`alien-signals`](https://github.com/stackblitz/alien-signals) _(upstream)_ | The primitive. `signal(value)`, `computed(fn)`, `effect(fn)`. Everything below builds on this.          |
| **A list that changes over time** (rows, cards, todos) | [`alien-projections`](packages/alien-projections/)                          | `createProjection(list, { key, map, filter, sort })` — when one row changes, only that row re-computes. |
| **An async fetch** (API call, file load, DB query)     | [`alien-resources`](packages/alien-resources/)                              | `createResource(fetcher)` — `.loading()` / `.error()` / `.refetch()` + auto-cancels stale requests.     |
| **A tree / hierarchy** (folders, outlines, nested UI)  | [`alien-trees`](packages/alien-trees/)                                      | `createTree(...)` — "does any descendant have X?" / "inherit Y from any ancestor?" in O(1).             |

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
